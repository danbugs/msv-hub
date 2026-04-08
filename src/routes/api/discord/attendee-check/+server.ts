/**
 * POST /api/discord/attendee-check
 *
 * Called by GitHub Actions on a schedule (every 5 min).
 * Protected by Authorization: Bearer <CRON_SECRET> — NOT by session auth.
 *
 * Polls StartGG for numEntrants on the configured event slug. When
 * numEntrants >= attendeeCap it creates a waitlist thread in Discord
 * and sets waitlistCreated: true so subsequent calls are no-ops.
 *
 * Returns: { ok: boolean, fired: boolean, entrants: number }
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { createForumPost, sendMessage, shortenSlug, truncateTo100 } from '$lib/server/discord';
import { getDiscordConfig, saveDiscordConfig } from '$lib/server/store';

const STARTGG_API = 'https://api.start.gg/gql/alpha';
const WAITLIST_CHANNEL_ID = '1193295598166737118';
const ANNOUNCE_CHANNEL_ID = '1066863301885173800';

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

	if (config.waitlistCreated) {
		return Response.json({ ok: true, fired: false, entrants: 0, reason: 'waitlist already created' });
	}

	const numEntrants = await fetchNumEntrants(config.eventSlug);
	if (numEntrants === null) {
		return Response.json({ ok: false, fired: false, reason: 'failed to fetch entrants from StartGG' }, { status: 502 });
	}

	if (numEntrants >= config.attendeeCap) {
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

		// Announce the cap in #announcements so people know to check the waitlist.
		const shortSlugStr = shortenSlug(config.eventSlug);
		await sendMessage(
			ANNOUNCE_CHANNEL_ID,
			`📢 **${shortSlugStr}** just capped! Add yourself to the waitlist: <#${WAITLIST_CHANNEL_ID}>`
		).catch(() => { /* best-effort — don't fail the whole check if announce fails */ });

		return Response.json({ ok: true, fired: true, entrants: numEntrants });
	}

	return Response.json({ ok: true, fired: false, entrants: numEntrants });
}

// Accept both GET (QStash) and POST (manual/legacy)
export const GET: RequestHandler = async ({ request }) => handleAttendeeCheck(request);
export const POST: RequestHandler = async ({ request }) => handleAttendeeCheck(request);
