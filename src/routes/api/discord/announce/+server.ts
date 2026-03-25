/**
 * POST /api/discord/announce
 *
 * Sends the registration-open announcement to the announcement channel.
 * Replicates the scheduled_task_wrapper message from Balrog.
 *
 * Body: { test?: boolean }
 *   test=true  → sends to the test announcement channel instead of the real one.
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sendMessage, buildAnnouncementMessage } from '$lib/server/discord';
import { getDiscordConfig } from '$lib/server/store';

function channelId(envKey: string, fallback: string): string {
	return (env as Record<string, string | undefined>)[envKey] ?? fallback;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as { test?: boolean };
	const isTest = body.test === true;

	const config = await getDiscordConfig();
	if (!config.eventSlug) {
		return Response.json(
			{ error: 'No event slug configured — set it in Discord Setup first.' },
			{ status: 400 }
		);
	}

	// Channel selection — test mode uses a dedicated test channel.
	const announceChannelId = isTest
		? channelId('DISCORD_CHANNEL_TEST_ANNOUNCE', '1317322763043864616')
		: channelId('DISCORD_CHANNEL_ANNOUNCE', '1066863301885173800');

	const message = buildAnnouncementMessage(
		config.eventSlug,
		config.attendeeCap,
		config.announcementTemplate
	);

	try {
		await sendMessage(announceChannelId, message);
		return Response.json({ ok: true, test: isTest, channel: announceChannelId });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json({ error: msg }, { status: 500 });
	}
};
