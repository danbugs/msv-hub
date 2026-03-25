/**
 * POST /api/discord/register-commands
 *
 * Auth-gated endpoint (requires logged-in user) that performs a bulk overwrite
 * of the bot's global slash commands via Discord's API. This lets the TO
 * register or update commands from the dashboard without CLI access.
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

const DISCORD_API = 'https://discord.com/api/v10';

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

const COMMANDS = [
	{ name: 'roll_dice',       description: 'Roll a 6-sided die' },
	{ name: 'yes_or_no',       description: 'Get a random Yes or No answer' },
	{ name: 'thanks',          description: "Post a random 'you're welcome' reply" },
	{ name: 'who_is_da_goat',  description: 'Crown a random recent #general author as the GOAT 🐐' },
	{ name: 'quote',           description: 'Share a random recent message from #general as a quote' },
	{ name: 'nextweek',        description: 'Show next event slug, cap, and registration time' },
	{ name: 'standings',       description: 'Show current tournament standings (Swiss top 10 or brackets status)' },
	{ name: 'bracket',         description: 'Show open bracket matches with station numbers' },
	{ name: 'gif',             description: 'Post a random Balrog GIF 🎬' },
	{ name: 'balrog_help',     description: 'List all Balrog slash commands' }
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const appId = env.DISCORD_APP_ID;
	const botToken = env.DISCORD_BOT_TOKEN;

	if (!appId || !botToken) {
		return Response.json(
			{ error: 'DISCORD_APP_ID or DISCORD_BOT_TOKEN is not configured' },
			{ status: 500 }
		);
	}

	const guildId = env.DISCORD_GUILD_ID;
	if (!guildId) {
		return Response.json({ error: 'DISCORD_GUILD_ID is not configured' }, { status: 500 });
	}

	const headers = {
		Authorization: `Bot ${botToken}`,
		'Content-Type': 'application/json'
	};

	// Clear any lingering global commands that cause duplicates in the command list.
	await fetch(`${DISCORD_API}/applications/${appId}/commands`, {
		method: 'PUT',
		headers,
		body: JSON.stringify([])
	});

	// Guild commands are instant; global commands take up to 1 hour.
	const res = await fetch(`${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`, {
		method: 'PUT',
		headers,
		body: JSON.stringify(COMMANDS)
	});

	if (!res.ok) {
		const text = await res.text();
		return Response.json(
			{ error: `Discord API error ${res.status}: ${text}` },
			{ status: 502 }
		);
	}

	const registered = (await res.json()) as { name: string }[];
	return Response.json({
		ok: true,
		registered: registered.map((c) => c.name)
	});
};
