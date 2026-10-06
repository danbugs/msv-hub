import type { RequestHandler } from './$types';
import { getActiveTournament, getAttendance } from '$lib/server/store';
import { sendMessagePingingUsers } from '$lib/server/discord';
import { buildNoShowPing, PING_CHANNELS } from '$lib/attendance-ping';

/** POST — Balrog pings everyone not marked present/late: "are you still coming?" */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const { channel, test } = (await request.json().catch(() => ({}))) as { channel?: string; test?: boolean };
	const target = PING_CHANNELS.find((c) => c.value === channel);
	if (!target) return Response.json({ error: 'Unknown channel' }, { status: 400 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	// Built from the server's view, not the client's, so a stale tab can't ping people who just arrived.
	const ping = buildNoShowPing(await getAttendance(tournament));
	if (!ping) return Response.json({ error: 'Everyone is marked present or late' }, { status: 400 });

	try {
		// Test mode renders the real message but notifies no one.
		await sendMessagePingingUsers(target.id, test ? `[TEST — nobody was notified]\n${ping.content}` : ping.content, test ? [] : ping.mentionIds);
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
	}
	return Response.json({ ok: true, test: !!test, mentioned: ping.mentionIds.length, unlinked: ping.unlinked });
};
