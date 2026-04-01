/**
 * POST /api/discord/test-trigger
 *
 * Manually triggers the announcement or attendee check for testing.
 * Requires session auth (not cron secret).
 *
 * Body: { action: 'announcement' | 'attendee-check' | 'motivational' }
 */

import type { RequestHandler } from '@sveltejs/kit';
import { sendMessage, buildAnnouncementMessage } from '$lib/server/discord';
import {
	getDiscordConfig,
	getCommunityConfig,
	getLastMotivationalTs,
	setLastMotivationalTs
} from '$lib/server/store';
import { env } from '$env/dynamic/private';

const STARTGG_API = 'https://api.start.gg/gql/alpha';
const WAITLIST_CHANNEL_ID = '1193295598166737118';
const ANNOUNCE_CHANNEL_ID = '1066863301885173800';
const GENERAL_CHANNEL_ID = '1066863005591162961';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const { action } = await request.json() as { action: string };
	const config = await getDiscordConfig();

	if (action === 'announcement') {
		if (!config.eventSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const message = buildAnnouncementMessage(config.eventSlug, config.attendeeCap, config.announcementTemplate);
		await sendMessage(ANNOUNCE_CHANNEL_ID, message);
		return Response.json({ ok: true, action: 'announcement', message: 'Sent to #announcements' });
	}

	if (action === 'attendee-check') {
		if (!config.eventSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const token = env.STARTGG_TOKEN;
		if (!token) return Response.json({ error: 'STARTGG_TOKEN not set' }, { status: 500 });
		const res = await fetch(STARTGG_API, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				query: 'query($slug:String!){event(slug:$slug){numEntrants}}',
				variables: { slug: config.eventSlug }
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

	if (action === 'motivational') {
		const communityConfig = await getCommunityConfig();
		const messages = communityConfig.motivationalMessages;
		if (!messages.length) return Response.json({ error: 'No motivational messages configured' }, { status: 400 });
		const pick = messages[Math.floor(Math.random() * messages.length)];
		await sendMessage(GENERAL_CHANNEL_ID, pick);
		await setLastMotivationalTs(Date.now());
		return Response.json({ ok: true, action: 'motivational', message: pick });
	}

	return Response.json({ error: 'Unknown action' }, { status: 400 });
};
