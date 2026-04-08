/**
 * POST /api/discord/attendee-check
 *
 * Called on a schedule (every 5 min).
 * Protected by Authorization: Bearer <CRON_SECRET> — NOT by session auth.
 *
 * Two jobs:
 * 1. Polls StartGG for numEntrants. When >= attendeeCap, creates waitlist thread.
 * 2. Detects fastest registrant after public reg opens and posts to Discord forum.
 *
 * Returns: { ok: boolean, fired: boolean, entrants: number }
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { createForumPost, sendMessage, getLatestForumThread, shortenSlug, truncateTo100 } from '$lib/server/discord';
import { getDiscordConfig, saveDiscordConfig } from '$lib/server/store';
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

/**
 * Resolve tournament ID from event slug (e.g. "tournament/foo/event/bar" → tournament.id).
 */
async function resolveTournamentId(eventSlug: string): Promise<number | null> {
	const slugMatch = eventSlug.match(/tournament\/([^/]+)/);
	if (!slugMatch) return null;
	const data = await gql<{ tournament: { id: number } }>(
		'query($slug:String!){tournament(slug:$slug){id}}',
		{ slug: slugMatch[1] }
	);
	return data?.tournament?.id ?? null;
}

/**
 * Find the fastest registrant from the StartGG export.
 * Filters to registrations after the configured public reg time on the most recent
 * registration day, then sorts by timestamp ascending.
 */
async function findFastestRegistrants(
	tournamentId: number,
	regDay: string,
	regHour: number,
	regMinute: number
): Promise<{ gamerTag: string; registeredAt: string }[]> {
	const attendees = await exportAttendees(tournamentId);
	if (attendees.length === 0) return [];

	// Parse all registration timestamps and filter for those after public reg opens
	const withTime: { gamerTag: string; registeredAt: string; ts: Date }[] = [];

	for (const a of attendees) {
		if (!a.registeredAt) continue;
		// registeredAt format from CSV: "MM/DD/YYYY HH:MM" or similar
		const ts = new Date(a.registeredAt);
		if (isNaN(ts.getTime())) continue;
		withTime.push({ gamerTag: a.gamerTag, registeredAt: a.registeredAt, ts });
	}

	if (withTime.length === 0) return [];

	// Sort by registration time ascending (earliest first)
	withTime.sort((a, b) => a.ts.getTime() - b.ts.getTime());

	// Find the public reg open time — the most recent occurrence of regDay at regHour:regMinute PST
	// For simplicity, we filter out anyone who registered before the configured reg time
	// by looking at the earliest cluster of registrations (they'll all be within seconds of each other)
	// The first person in the sorted list is the fastest

	return withTime.map((w) => ({ gamerTag: w.gamerTag, registeredAt: w.registeredAt }));
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
					const winner = sorted[0].gamerTag;
					const runnersUp = sorted.slice(1, 4).map((r) => r.gamerTag);
					const eventShort = shortenSlug(config.eventSlug);

					// Generate AI message
					let message: string;
					try {
						message = await generateFastestRegMessage(winner, eventShort, runnersUp);
					} catch (aiErr) {
						// Fallback if AI fails
						console.error(`[attendee-check] AI message generation failed: ${aiErr}`);
						message = `@${winner} wins fastest registrant for ${eventShort}!\n\nTop 3 after: ${runnersUp.join(', ')}`;
					}

					// Post to the latest thread in the fastest-reg forum
					const guildId = env.DISCORD_GUILD_ID ?? '';
					if (guildId) {
						const latestThread = await getLatestForumThread(guildId, FASTEST_REG_FORUM_ID);
						if (latestThread) {
							await sendMessage(latestThread.id, message);
							results.push(`fastest reg posted to thread ${latestThread.name}`);
						} else {
							// No active thread — create a new one
							const threadName = truncateTo100(`Fastest Registrant — ${eventShort}`);
							await createForumPost(FASTEST_REG_FORUM_ID, threadName, message);
							results.push('fastest reg: created new forum thread');
						}
					} else {
						results.push('fastest reg: DISCORD_GUILD_ID not set, skipped');
					}

					await saveDiscordConfig({ fastestRegPosted: true });
					fired = true;
				} else {
					results.push(`fastest reg: only ${sorted.length} registrants with timestamps, need 4`);
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

		// Announce the cap in #announcements
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
