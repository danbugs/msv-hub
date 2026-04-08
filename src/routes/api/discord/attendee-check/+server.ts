/**
 * GET/POST /api/discord/attendee-check
 *
 * Called on a schedule (every 5 min on Wednesdays after reg opens).
 * Protected by Authorization: Bearer <CRON_SECRET>.
 *
 * Two jobs:
 * 1. Polls StartGG for numEntrants. When >= attendeeCap, creates waitlist thread.
 * 2. Detects fastest registrant after public reg opens and posts to Discord forum.
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import {
	createForumPost, sendMessage, sendMessageWithId, editMessage,
	getLatestForumThread, shortenSlug, truncateTo100
} from '$lib/server/discord';
import {
	getDiscordConfig, saveDiscordConfig,
	getFastestRegLeaderboard, saveFastestRegLeaderboard, buildLeaderboardText,
	type FastestRegEntry
} from '$lib/server/store';
import { exportAttendees } from '$lib/server/startgg-admin';
import { gql } from '$lib/server/startgg';
import { generateFastestRegMessage } from '$lib/server/ai';

const STARTGG_API = 'https://api.start.gg/gql/alpha';
const WAITLIST_CHANNEL_ID = '1193295598166737118';
const ANNOUNCE_CHANNEL_ID = '1066863301885173800';
const FASTEST_REG_FORUM_ID = '1193306596332290088';

const ENTRANTS_QUERY = `
query getEventEntrants($slug: String!) {
  event(slug: $slug) {
    numEntrants
  }
}`;

async function fetchNumEntrants(slug: string): Promise<number | null> {
	const token = env.STARTGG_TOKEN;
	if (!token) throw new Error('STARTGG_TOKEN must be set');

	const res = await fetch(STARTGG_API, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({ query: ENTRANTS_QUERY, variables: { slug } })
	});

	if (!res.ok) return null;
	const json = await res.json();
	if (json.errors) return null;
	return (json.data?.event?.numEntrants as number | null | undefined) ?? null;
}

/** Resolve tournament ID from event slug. */
async function resolveTournamentId(eventSlug: string): Promise<number | null> {
	const slugMatch = eventSlug.match(/tournament\/([^/]+)/);
	if (!slugMatch) return null;
	const data = await gql<{ tournament: { id: number } }>(
		'query($slug:String!){tournament(slug:$slug){id}}',
		{ slug: slugMatch[1] }
	);
	return data?.tournament?.id ?? null;
}

const DAY_MAP: Record<string, number> = {
	sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

/**
 * Parse a StartGG CSV date+time string like "April 8 2026 8:30 AM" or "4/8/2026 8:30 AM".
 * new Date() can't reliably parse "April 8 2026" (no comma), so we normalize first.
 */
function parseRegTimestamp(raw: string): Date | null {
	if (!raw) return null;

	// Try adding comma after day number: "April 8 2026" → "April 8, 2026"
	const withComma = raw.replace(/^(\w+ \d{1,2}) (\d{4})/, '$1, $2');
	let ts = new Date(withComma);
	if (!isNaN(ts.getTime())) return ts;

	// Try as-is
	ts = new Date(raw);
	if (!isNaN(ts.getTime())) return ts;

	return null;
}

/**
 * Get the fastest registrants from the StartGG export CSV.
 *
 * The CSV rows are already in registration order (earliest first).
 * We filter out priority registrants — anyone who registered BEFORE
 * the configured public reg day+time (e.g. Wednesday 8:30 AM PST).
 */
async function findFastestRegistrants(
	tournamentId: number,
	regDay: string,
	regHour: number,
	regMinute: number
): Promise<{ gamerTag: string; discordId: string; registeredAt: string }[]> {
	const attendees = await exportAttendees(tournamentId);
	if (attendees.length === 0) return [];

	const targetDow = DAY_MAP[regDay] ?? 3;
	const regThresholdMinutes = regHour * 60 + regMinute;

	const results: { gamerTag: string; discordId: string; registeredAt: string }[] = [];

	// CSV timestamps from StartGG are already in Pacific Time — don't convert again
	for (const a of attendees) {
		const ts = parseRegTimestamp(a.registeredAt);
		if (!ts) continue;

		const dow = ts.getDay();
		const hour = ts.getHours();
		const minute = ts.getMinutes();

		if (dow === targetDow && hour * 60 + minute >= regThresholdMinutes) {
			results.push({
				gamerTag: a.gamerTag,
				discordId: a.discordId,
				registeredAt: a.registeredAt
			});
		}
	}

	return results;
}

/** Format a mention: Discord <@id> if valid numeric snowflake, otherwise gamer tag. */
function mention(tag: string, discordId: string): string {
	return discordId && /^\d{17,20}$/.test(discordId) ? `<@${discordId}>` : tag;
}

/**
 * Extract event label like "MSV#135" from event slug.
 * e.g. "tournament/microspacing-vancouver-135/event/..." → "MSV#135"
 */
function extractEventLabel(slug: string): string {
	const match = slug.match(/microspacing-vancouver-(\d+)/i);
	if (match) return `MSV#${match[1]}`;
	// Fallback: use the short slug
	return shortenSlug(slug);
}

/**
 * Post fastest registrant: AI-generated reply + update leaderboard.
 */
async function postFastestRegistrant(
	config: { eventSlug: string; registrationDay: string; registrationHour: number; registrationMinute: number },
	registrants: { gamerTag: string; discordId: string; registeredAt: string }[]
): Promise<string> {
	const winner = registrants[0];
	const runnersUp = registrants.slice(1, 4);
	const eventLabel = extractEventLabel(config.eventSlug);
	const eventShort = shortenSlug(config.eventSlug);
	const guildId = env.DISCORD_GUILD_ID ?? '';

	if (!guildId) return 'DISCORD_GUILD_ID not set, skipped';

	// Only ping the winner; runners-up just use gamer tags
	const winnerMention = mention(winner.gamerTag, winner.discordId);
	const runnerTags = runnersUp.map((r) => r.gamerTag);

	let funMessage: string;
	try {
		funMessage = await generateFastestRegMessage(winnerMention, eventLabel, runnerTags);
	} catch (aiErr) {
		console.error(`[attendee-check] AI message generation failed: ${aiErr}`);
		funMessage = `${winnerMention} wins fastest registrant for ${eventLabel}!\n\nTop 3 after: ${runnerTags.join(', ')}`;
	}

	// Load or create leaderboard
	let lb = await getFastestRegLeaderboard();

	const newEntry: FastestRegEntry = {
		eventLabel,
		winnerTag: winner.gamerTag,
		winnerDiscordId: winner.discordId,
		runnersUp: runnersUp.map((r) => ({ tag: r.gamerTag, discordId: r.discordId }))
	};

	if (lb && lb.threadId) {
		// Add entry and update the leaderboard message
		lb.entries.push(newEntry);
		const leaderboardText = buildLeaderboardText(lb.entries);

		// Try to edit Balrog's leaderboard message. If it fails (e.g. not Balrog's message),
		// post a new leaderboard reply and track that one instead.
		let edited = false;
		if (lb.leaderboardMessageId) {
			try {
				await editMessage(lb.threadId, lb.leaderboardMessageId, leaderboardText);
				edited = true;
			} catch {
				// Can't edit (probably not Balrog's message) — post new one
			}
		}
		if (!edited) {
			const newMsgId = await sendMessageWithId(lb.threadId, leaderboardText);
			lb.leaderboardMessageId = newMsgId;
		}

		// Post the fun reply
		await sendMessage(lb.threadId, funMessage);
		await saveFastestRegLeaderboard(lb);
		return `posted to thread, ${edited ? 'edited' : 'posted new'} leaderboard (${eventLabel})`;
	} else {
		// No leaderboard exists — create a new forum thread
		const entries = [newEntry];
		const leaderboardText = buildLeaderboardText(entries);

		const threadName = truncateTo100(`Fastest Registrant — Season`);
		const thread = await createForumPost(FASTEST_REG_FORUM_ID, threadName, leaderboardText);

		// Post the fun announcement as a reply
		await sendMessage(thread.id, funMessage);

		// The first message in the thread was created by Balrog via createForumPost,
		// so we can edit it. Fetch its ID.
		const { getMessages } = await import('$lib/server/discord');
		const msgs = await getMessages(thread.id, 1);
		const firstMsgId = msgs[0]?.id ?? '';

		await saveFastestRegLeaderboard({
			entries,
			threadId: thread.id,
			leaderboardMessageId: firstMsgId,
			updatedAt: Date.now()
		});
		return `created new forum thread (${eventLabel})`;
	}
}

async function handleAttendeeCheck(request: Request) {
	const cronSecret = env.CRON_SECRET;
	if (!cronSecret) {
		return Response.json({ ok: false, fired: false, reason: 'CRON_SECRET not configured' }, { status: 500 });
	}

	const authHeader = request.headers.get('Authorization') ?? '';
	if (authHeader !== `Bearer ${cronSecret}`) {
		return Response.json({ ok: false, fired: false, reason: 'Unauthorized' }, { status: 401 });
	}

	const config = await getDiscordConfig();

	if (!config.eventSlug) {
		return Response.json({ ok: true, fired: false, entrants: 0, reason: 'no event slug configured' });
	}

	if (config.paused) {
		return Response.json({ ok: true, fired: false, entrants: 0, reason: 'bot is paused' });
	}

	const numEntrants = await fetchNumEntrants(config.eventSlug);
	if (numEntrants === null) {
		return Response.json({ ok: false, fired: false, reason: 'failed to fetch entrants from StartGG' }, { status: 502 });
	}

	const results: string[] = [];
	let fired = false;

	// --- Fastest registrant check ---
	// Trigger once we have 4+ entrants and haven't posted yet
	if (!config.fastestRegPosted && numEntrants >= 4) {
		try {
			const tournamentId = await resolveTournamentId(config.eventSlug);
			if (tournamentId) {
				const sorted = await findFastestRegistrants(
					tournamentId,
					config.registrationDay,
					config.registrationHour,
					config.registrationMinute
				);

				if (sorted.length >= 4) {
					const result = await postFastestRegistrant(config, sorted);
					await saveDiscordConfig({ fastestRegPosted: true });
					fired = true;
					results.push(`fastest reg: ${result}`);
				} else {
					results.push(`fastest reg: only ${sorted.length} public registrants (need 4, pri-reg filtered out)`);
				}
			} else {
				results.push('fastest reg: could not resolve tournament ID');
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			results.push(`fastest reg error: ${msg}`);
		}
	} else if (config.fastestRegPosted) {
		results.push('fastest reg: already posted');
	} else {
		results.push(`fastest reg: waiting for 4+ entrants (have ${numEntrants})`);
	}

	// --- Waitlist check ---
	if (config.waitlistCreated) {
		results.push('waitlist: already created');
	} else if (numEntrants >= config.attendeeCap) {
		const title = truncateTo100(`Waitlist for ${shortenSlug(config.eventSlug)}`);

		const waitlistNote =
			config.attendeeCap === 32
				? '\n\nTop 8 of this waitlist get priority registration for next week.'
				: '';

		const content =
			`Answer in the thread if you'd like to be added to the waitlist!${waitlistNote}\n\n` +
			`Please, let me know if you are bringing a setup. For example, "Dantotto setup"`;

		await createForumPost(WAITLIST_CHANNEL_ID, title, content);
		await saveDiscordConfig({ waitlistCreated: true });

		const shortSlugStr = shortenSlug(config.eventSlug);
		await sendMessage(
			ANNOUNCE_CHANNEL_ID,
			`📢 **${shortSlugStr}** just capped! Add yourself to the waitlist: <#${WAITLIST_CHANNEL_ID}>`
		).catch(() => { /* best-effort */ });

		fired = true;
		results.push('waitlist thread created');
	} else {
		results.push(`waitlist: ${numEntrants}/${config.attendeeCap}`);
	}

	return Response.json({ ok: true, fired, entrants: numEntrants, reason: results.join('; ') });
}

// Accept both GET (QStash) and POST (manual/legacy)
export const GET: RequestHandler = async ({ request }) => handleAttendeeCheck(request);
export const POST: RequestHandler = async ({ request }) => handleAttendeeCheck(request);
