/**
 * GET/POST /api/discord/motivational-cron
 *
 * Called by QStash on a schedule (every 3 days at ~12 PM PDT).
 * Posts an AI-generated community message to #general.
 * Protected by Authorization: Bearer <CRON_SECRET>.
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sendMessage } from '$lib/server/discord';
import { generateMotivationalMessage } from '$lib/server/ai';

const GENERAL_CHANNEL_ID = '1066863005591162961';

async function handleMotivational(request: Request) {
	const cronSecret = env.CRON_SECRET;
	if (!cronSecret) {
		return Response.json({ ok: false, reason: 'CRON_SECRET not configured' }, { status: 500 });
	}

	const authHeader = request.headers.get('Authorization') ?? '';
	if (authHeader !== `Bearer ${cronSecret}`) {
		return Response.json({ ok: false, reason: 'Unauthorized' }, { status: 401 });
	}

	try {
		const message = await generateMotivationalMessage();
		await sendMessage(GENERAL_CHANNEL_ID, message);
		return Response.json({ ok: true, message });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json({ ok: false, reason: msg }, { status: 500 });
	}
}

export const GET: RequestHandler = async ({ request }) => handleMotivational(request);
export const POST: RequestHandler = async ({ request }) => handleMotivational(request);
