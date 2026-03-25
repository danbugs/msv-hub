/**
 * POST /api/discord/interactions
 *
 * Discord sends all slash command interactions here. We must:
 *   1. Verify the Ed25519 signature — Discord rejects endpoints that fail this.
 *   2. Respond to PING (type 1) with PONG (type 1).
 *   3. Dispatch APPLICATION_COMMAND (type 2) to the appropriate handler.
 *
 * Signature verification uses the raw request body (text) before any JSON
 * parsing, since the HMAC covers the exact bytes Discord sent.
 */

import type { RequestHandler } from './$types';
import { createVerify } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getDiscordConfig, getActiveTournament } from '$lib/server/store';
import { getMessages } from '$lib/server/discord';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERAL_CHANNEL_ID = '1066863005591162961';

// Discord interaction types
const PING = 1;
const APPLICATION_COMMAND = 2;

// Discord response types
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifyDiscordSignature(
	publicKey: string,
	signature: string,
	timestamp: string,
	body: string
): boolean {
	try {
		const verify = createVerify('ed25519');
		verify.update(timestamp + body);
		return verify.verify(Buffer.from(publicKey, 'hex'), Buffer.from(signature, 'hex'));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function reply(content: string): Response {
	return Response.json({ type: CHANNEL_MESSAGE_WITH_SOURCE, data: { content } });
}

function pong(): Response {
	return Response.json({ type: PONG });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleRollDice(): Promise<string> {
	const n = Math.floor(Math.random() * 6) + 1;
	return `🎲 You rolled a ${n}!`;
}

async function handleYesOrNo(): Promise<string> {
	return Math.random() < 0.5 ? 'Yes' : 'No';
}

async function handleThanks(): Promise<string> {
	const responses = ['No worries!', "You're welcome!", 'Anytime 😎', 'All good!', 'You got it!', 'np 👍'];
	return responses[Math.floor(Math.random() * responses.length)];
}

async function handleWhoIsDaGoat(): Promise<string> {
	const messages = await getMessages(GENERAL_CHANNEL_ID, 100);
	const authorMap = new Map<string, string>();
	for (const m of messages) {
		if (!m.author.bot && !authorMap.has(m.author.id)) {
			authorMap.set(m.author.id, m.author.username);
		}
	}
	if (authorMap.size === 0) {
		return 'Could not find any recent messages to pick a GOAT from.';
	}
	const authors = [...authorMap.values()];
	const chosen = authors[Math.floor(Math.random() * authors.length)];
	return `🐐 The GOAT is... **${chosen}**!`;
}

async function handleQuote(): Promise<string> {
	const messages = await getMessages(GENERAL_CHANNEL_ID, 100);
	const eligible = messages.filter((m) => !m.author.bot && m.content.trim().length > 0);
	if (eligible.length === 0) {
		return 'No eligible messages found to quote.';
	}
	const picked = eligible[Math.floor(Math.random() * eligible.length)];
	return `📜 Random quote from **${picked.author.username}**:\n> ${picked.content}`;
}

async function handleNextWeek(): Promise<string> {
	const config = await getDiscordConfig();
	if (!config.eventSlug) {
		return 'No next event configured yet.';
	}

	// Format day: "wed" → "Wednesday"
	const dayNames: Record<string, string> = {
		mon: 'Monday',
		tue: 'Tuesday',
		wed: 'Wednesday',
		thu: 'Thursday',
		fri: 'Friday',
		sat: 'Saturday',
		sun: 'Sunday'
	};
	const day = dayNames[config.registrationDay] ?? config.registrationDay;

	// Format time as HH:MM PST
	const hh = String(config.registrationHour).padStart(2, '0');
	const mm = String(config.registrationMinute).padStart(2, '0');

	return (
		`📅 Next event: start.gg/${config.eventSlug}\n` +
		`- ${config.attendeeCap} player cap\n` +
		`- Registration opens ${day} at ${hh}:${mm} PST`
	);
}

async function handleStandings(): Promise<string> {
	const tournament = await getActiveTournament();
	if (!tournament) {
		return 'No active tournament.';
	}

	if (tournament.phase === 'brackets') {
		return 'Brackets are live!';
	}

	if (tournament.phase !== 'swiss') {
		return 'No active tournament.';
	}

	// Build W-L records from completed rounds
	const wins = new Map<string, number>();
	const losses = new Map<string, number>();

	for (const entrant of tournament.entrants) {
		wins.set(entrant.id, 0);
		losses.set(entrant.id, 0);
	}

	for (const round of tournament.rounds) {
		if (round.status !== 'completed') continue;
		for (const match of round.matches) {
			if (!match.winnerId) continue;
			const loserId =
				match.winnerId === match.topPlayerId ? match.bottomPlayerId : match.topPlayerId;
			wins.set(match.winnerId, (wins.get(match.winnerId) ?? 0) + 1);
			losses.set(loserId, (losses.get(loserId) ?? 0) + 1);
		}
	}

	// Sort by wins desc, then losses asc
	const sorted = [...tournament.entrants]
		.sort((a, b) => {
			const wDiff = (wins.get(b.id) ?? 0) - (wins.get(a.id) ?? 0);
			if (wDiff !== 0) return wDiff;
			return (losses.get(a.id) ?? 0) - (losses.get(b.id) ?? 0);
		})
		.slice(0, 10);

	const lines = sorted.map(
		(e, i) => `${i + 1}. **${e.gamerTag}** — ${wins.get(e.id) ?? 0}-${losses.get(e.id) ?? 0}`
	);

	return `🏆 Swiss Standings (Top 10):\n${lines.join('\n')}`;
}

async function handleBracket(): Promise<string> {
	const tournament = await getActiveTournament();
	if (!tournament) {
		return 'No active tournament.';
	}

	if (tournament.phase !== 'brackets' || !tournament.brackets) {
		return 'Brackets are not live yet.';
	}

	// Collect all open (unreported) matches from both brackets
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e.gamerTag]));

	const openMatches: string[] = [];

	for (const bracket of [tournament.brackets.main, tournament.brackets.redemption]) {
		for (const match of bracket.matches) {
			// Open = both players assigned, no winner yet
			if (match.topPlayerId && match.bottomPlayerId && !match.winnerId) {
				const top = entrantMap.get(match.topPlayerId) ?? '???';
				const bottom = entrantMap.get(match.bottomPlayerId) ?? '???';
				const station = match.station ? ` (Station ${match.station})` : '';
				openMatches.push(`**${top}** vs **${bottom}**${station}`);
			}
		}
	}

	if (openMatches.length === 0) {
		return 'No open bracket matches right now.';
	}

	return `🎮 Open bracket matches:\n${openMatches.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
	const publicKey = env.DISCORD_PUBLIC_KEY;
	if (!publicKey) {
		return Response.json({ error: 'DISCORD_PUBLIC_KEY not configured' }, { status: 500 });
	}

	// Read raw body text — signature verification needs the exact bytes.
	const rawBody = await request.text();
	const signature = request.headers.get('x-signature-ed25519') ?? '';
	const timestamp = request.headers.get('x-signature-timestamp') ?? '';

	if (!verifyDiscordSignature(publicKey, signature, timestamp, rawBody)) {
		return new Response('Invalid request signature', { status: 401 });
	}

	const interaction = JSON.parse(rawBody) as {
		type: number;
		data?: { name: string };
	};

	// PING — Discord validates the endpoint with this
	if (interaction.type === PING) {
		return pong();
	}

	// Slash command
	if (interaction.type === APPLICATION_COMMAND) {
		const name = interaction.data?.name ?? '';

		try {
			switch (name) {
				case 'roll_dice':
					return reply(await handleRollDice());
				case 'yes_or_no':
					return reply(await handleYesOrNo());
				case 'thanks':
					return reply(await handleThanks());
				case 'who_is_da_goat':
					return reply(await handleWhoIsDaGoat());
				case 'quote':
					return reply(await handleQuote());
				case 'nextweek':
					return reply(await handleNextWeek());
				case 'standings':
					return reply(await handleStandings());
				case 'bracket':
					return reply(await handleBracket());
				default:
					return reply(`Unknown command: /${name}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return reply(`Error: ${msg}`);
		}
	}

	return Response.json({ error: 'Unknown interaction type' }, { status: 400 });
};
