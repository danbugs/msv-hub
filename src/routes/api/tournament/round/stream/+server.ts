import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';

/** PUT — reassign stream station to a different match in the active round */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const body = await request.json();
	const { matchId } = body as { matchId: string };
	if (!matchId) return Response.json({ error: 'matchId is required' }, { status: 400 });

	const activeRound = tournament.rounds.find((r) => r.status === 'active');
	if (!activeRound) return Response.json({ error: 'No active round' }, { status: 400 });

	const targetMatch = activeRound.matches.find((m) => m.id === matchId);
	if (!targetMatch) return Response.json({ error: 'Match not found in active round' }, { status: 404 });

	const currentStreamMatch = activeRound.matches.find((m) => m.isStream);

	// Swap stations
	const streamStation = tournament.settings.streamStation;
	const targetStation = targetMatch.station;

	for (const m of activeRound.matches) {
		if (m.id === matchId) {
			m.station = streamStation;
			m.isStream = true;
		} else if (m.isStream) {
			m.station = targetStation;
			m.isStream = false;
		}
	}

	await saveTournament(tournament);
	return Response.json({ ok: true, round: activeRound });
};
