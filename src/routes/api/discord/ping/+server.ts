/**
 * POST /api/discord/ping
 *
 * Sends a test "hello" message to the hardcoded test channel to verify
 * that the bot token and guild ID are working correctly.
 */

import type { RequestHandler } from './$types';
import { sendMessage } from '$lib/server/discord';

const TEST_CHANNEL = '1317322917129879562';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	try {
		await sendMessage(TEST_CHANNEL, 'Hello from MSV Hub! 👋 Discord integration is working.');
		return Response.json({ ok: true, channel: TEST_CHANNEL });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json({ error: msg }, { status: 500 });
	}
};
