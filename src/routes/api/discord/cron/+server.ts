/**
 * POST /api/discord/cron
 *
 * Called by GitHub Actions on a schedule (every 30 min).
 * Protected by Authorization: Bearer <CRON_SECRET> — NOT by session auth.
 *
 * Checks if now (UTC) matches the configured PST announcement time within
 * a ±15 min window to handle cron drift. If so, fires the announcement.
 *
 * Also posts a random motivational message to #general if 48h have passed
 * since the last one.
 *
 * Returns: { ok: boolean, fired: boolean, reason: string }
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sendMessage } from '$lib/server/discord';
import { buildAnnouncementMessage } from '../announce/+server';
import {
	getDiscordConfig,
	getCommunityConfig,
	getLastMotivationalTs,
	setLastMotivationalTs
} from '$lib/server/store';

const DAY_MAP: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6
};

// PST is UTC-8 (no DST awareness — community uses fixed PST).
const PST_OFFSET_HOURS = 8;

function channelId(envKey: string, fallback: string): string {
	return (env as Record<string, string | undefined>)[envKey] ?? fallback;
}

export const POST: RequestHandler = async ({ request }) => {
	// Authenticate via CRON_SECRET bearer token.
	const cronSecret = env.CRON_SECRET;
	if (!cronSecret) {
		return Response.json({ ok: false, fired: false, reason: 'CRON_SECRET not configured' }, { status: 500 });
	}

	const authHeader = request.headers.get('Authorization') ?? '';
	if (authHeader !== `Bearer ${cronSecret}`) {
		return Response.json({ ok: false, fired: false, reason: 'Unauthorized' }, { status: 401 });
	}

	const now = new Date();
	const nowUtcMs = now.getTime();

	// Convert current UTC time to PST minutes-of-week.
	const pstMs = nowUtcMs - PST_OFFSET_HOURS * 60 * 60 * 1000;
	const pstDate = new Date(pstMs);
	const pstDayOfWeek = pstDate.getUTCDay(); // 0=Sun
	const pstHour = pstDate.getUTCHours();
	const pstMinute = pstDate.getUTCMinutes();
	const pstTotalMinutes = pstDayOfWeek * 24 * 60 + pstHour * 60 + pstMinute;

	const config = await getDiscordConfig();

	const results: string[] = [];
	let fired = false;

	// --- Announcement check ---
	if (config.eventSlug) {
		const targetDay = DAY_MAP[config.registrationDay] ?? 3;
		const targetMinutes = targetDay * 24 * 60 + config.registrationHour * 60 + config.registrationMinute;

		const diff = Math.abs(pstTotalMinutes - targetMinutes);
		// Handle week wrap (e.g. Sunday midnight edge case).
		const wrappedDiff = Math.min(diff, 7 * 24 * 60 - diff);

		if (wrappedDiff <= 15) {
			const announceChannelId = channelId('DISCORD_CHANNEL_ANNOUNCE', '1066863301885173800');
			const message = buildAnnouncementMessage(
				config.eventSlug,
				config.attendeeCap,
				config.announcementTemplate
			);
			try {
				await sendMessage(announceChannelId, message);
				fired = true;
				results.push('announcement sent');
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				results.push(`announcement failed: ${msg}`);
			}
		} else {
			results.push(`announcement skipped (diff=${wrappedDiff}m, window=±15m)`);
		}
	} else {
		results.push('announcement skipped (no event slug configured)');
	}

	// --- Motivational message check (48h throttle) ---
	const lastMotivational = await getLastMotivationalTs();
	const hoursSinceLast = (nowUtcMs - lastMotivational) / (1000 * 60 * 60);

	if (hoursSinceLast >= 48) {
		const communityConfig = await getCommunityConfig();
		const messages = communityConfig.motivationalMessages;
		if (messages.length > 0) {
			const pick = messages[Math.floor(Math.random() * messages.length)];
			const generalChannelId = '1066863005591162961';
			try {
				await sendMessage(generalChannelId, pick);
				await setLastMotivationalTs(nowUtcMs);
				results.push('motivational message sent');
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				results.push(`motivational failed: ${msg}`);
			}
		} else {
			results.push('motivational skipped (no messages configured)');
		}
	} else {
		results.push(`motivational skipped (${Math.round(hoursSinceLast)}h since last, need 48h)`);
	}

	return Response.json({ ok: true, fired, reason: results.join('; ') });
};
