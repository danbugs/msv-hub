/**
 * POST /api/discord/test-trigger
 *
 * Manually triggers Discord actions for testing.
 * All test actions post to #talk-to-balrog or the test waitlist channel.
 * Requires session auth (not cron secret).
 *
 * Body: { action: 'announcement' | 'attendee-check' | 'waitlist-test' | 'motivational' }
 */

import type { RequestHandler } from './$types';
import { sendMessage, buildAnnouncementMessage, createForumPost, shortenSlug, truncateTo100 } from '$lib/server/discord';
import {
	getDiscordConfig,
	getCommunityConfig,
	getLastMotivationalTs,
	setLastMotivationalTs
} from '$lib/server/store';
import { env } from '$env/dynamic/private';

const STARTGG_API = 'https://api.start.gg/gql/alpha';
const TALK_TO_BALROG = '1317322917129879562';
const TEST_WAITLIST_CHANNEL = '1317322581938016317';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const { action, eventSlug: overrideSlug } = await request.json() as { action: string; eventSlug?: string };
	const config = await getDiscordConfig();
	const effectiveSlug = overrideSlug?.trim() || config.eventSlug;

	if (action === 'announcement') {
		if (!effectiveSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const message = buildAnnouncementMessage(effectiveSlug, config.attendeeCap, config.announcementTemplate);
		await sendMessage(TALK_TO_BALROG, `[TEST] ${message}`);
		return Response.json({ ok: true, action: 'announcement', message: 'Sent to #talk-to-balrog' });
	}

	if (action === 'attendee-check') {
		if (!effectiveSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const token = env.STARTGG_TOKEN;
		if (!token) return Response.json({ error: 'STARTGG_TOKEN not set' }, { status: 500 });
		const res = await fetch(STARTGG_API, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				query: 'query($slug:String!){event(slug:$slug){numEntrants}}',
				variables: { slug: effectiveSlug }
			})
		});
		const json = await res.json();
		const numEntrants = json.data?.event?.numEntrants ?? 0;
		return Response.json({
			ok: true, action: 'attendee-check',
			entrants: numEntrants, cap: config.attendeeCap,
			wouldFire: numEntrants >= config.attendeeCap,
			waitlistAlreadyCreated: config.waitlistCreated
		});
	}

	if (action === 'waitlist-test') {
		// Creates a test waitlist post in the test channel (not the real waitlist channel)
		if (!effectiveSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const title = truncateTo100(`[TEST] Waitlist for ${shortenSlug(effectiveSlug)}`);
		const content =
			`[TEST] Answer in the thread if you'd like to be added to the waitlist!\n\n` +
			`Top 8 of this waitlist get priority registration for next week.\n\n` +
			`Please, let me know if you are bringing a setup. For example, "Dantotto setup"`;
		await createForumPost(TEST_WAITLIST_CHANNEL, title, content);
		await sendMessage(TALK_TO_BALROG, `[TEST] 📢 Event just capped! Waitlist posted to test channel.`);
		return Response.json({ ok: true, action: 'waitlist-test', message: 'Waitlist post created in test channel' });
	}

	if (action === 'motivational') {
		const communityConfig = await getCommunityConfig();
		const messages = communityConfig.motivationalMessages;
		if (!messages.length) return Response.json({ error: 'No motivational messages configured' }, { status: 400 });
		const pick = messages[Math.floor(Math.random() * messages.length)];
		await sendMessage(TALK_TO_BALROG, `[TEST] ${pick}`);
		return Response.json({ ok: true, action: 'motivational', message: pick });
	}

	return Response.json({ error: 'Unknown action. Use: announcement, attendee-check, waitlist-test, motivational' }, { status: 400 });
};
