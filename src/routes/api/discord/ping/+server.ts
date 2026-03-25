/**
 * POST /api/discord/ping
 *
 * Sends a test "hello" message to the hardcoded test channel to verify
 * that the bot token and guild ID are working correctly.
 */

import type { RequestHandler } from './$types';
import { sendMessage } from '$lib/server/discord';

const GENERAL_CHANNEL = '1066863005591162961';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as { message?: string };
	const message = body.message?.trim();
	if (!message) return Response.json({ error: 'message is required' }, { status: 400 });

	try {
		await sendMessage(GENERAL_CHANNEL, message);
		return Response.json({ ok: true, channel: GENERAL_CHANNEL });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json({ error: msg }, { status: 500 });
	}
};
