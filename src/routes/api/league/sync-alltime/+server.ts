import type { RequestHandler } from './$types';
import { syncAllSeasonsToAllTime } from '$lib/server/league-import';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const logs: string[] = [];
	const result = await syncAllSeasonsToAllTime((msg) => logs.push(msg));

	if (!result) {
		return Response.json({ ok: true, message: 'No events found in any season', logs });
	}

	return Response.json({
		ok: true,
		events: result.events.length,
		players: Object.keys(result.players).length,
		matches: result.matches.length,
		logs
	});
};
