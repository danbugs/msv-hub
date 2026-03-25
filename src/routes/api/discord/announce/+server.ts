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
import { sendMessage } from '$lib/server/discord';
import { getDiscordConfig } from '$lib/server/store';

function channelId(envKey: string, fallback: string): string {
	return (env as Record<string, string | undefined>)[envKey] ?? fallback;
}

/**
 * Build the announcement message from config.
 * If a custom template is set, replace {{slug}} and {{cap}}.
 * Otherwise use the hardcoded default.
 */
export function buildAnnouncementMessage(slug: string, cap: 32 | 64, template?: string): string {
	if (template && template.trim()) {
		return template
			.replace(/\{\{slug\}\}/g, slug)
			.replace(/\{\{cap\}\}/g, String(cap));
	}

	let message =
		`@everyone ~ registration for next week's event is open!\n\n` +
		`- ${cap} player cap.\n` +
		`- for venue access, see: #how-to-get-to-the-venue .\n` +
		`- **:warning: BRING YOUR NINTENDO SWITCHES (DOCK, CONSOLE, POWER CABLE, AND HDMI) WITH GAME CUBE ADAPTERS :warning:**`;

	if (cap === 32) {
		message +=
			` (running Swiss is dependent on having at least 20 setups; otherwise, we'll do normal Redemption). We've got monitors.\n`;
	} else {
		message += `\n`;
	}

	message +=
		`- if you are trying to register, but we've already reached the cap, please drop your StartGG tag ` +
		`(and say if you can bring a setup) at #add-me-to-the-waitlist once it opens. ` +
		`Are you from out-of-region? If so, you have priority in the waitlist!\n\n` +
		`PS If you can't bring a full setup, but would still like to contribute, _please bring your GCC adapter_. ` +
		`There are some people that can bring full setups but only play w/ pro cons., so it's always best to have extras.\n\n` +
		`https://start.gg/${slug}`;

	return message;
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
