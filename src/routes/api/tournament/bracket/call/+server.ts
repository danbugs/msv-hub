import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';

/** PATCH — toggle "called" state on a bracket match (sets or clears calledAt) */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.brackets) return Response.json({ error: 'No brackets generated' }, { status: 400 });

	const { bracketName, matchId } = await request.json() as { bracketName: 'main' | 'redemption'; matchId: string };
	if (!bracketName || !matchId) return Response.json({ error: 'bracketName and matchId are required' }, { status: 400 });

	const bracket = tournament.brackets[bracketName];
	if (!bracket) return Response.json({ error: `Bracket "${bracketName}" not found` }, { status: 404 });

	const matches = bracket.matches.map((m) => {
		if (m.id !== matchId) return m;
		return { ...m, calledAt: m.calledAt ? undefined : Date.now() };
	});

	if (!matches.some((m) => m.id === matchId)) {
		return Response.json({ error: `Match ${matchId} not found` }, { status: 404 });
	}

	tournament.brackets[bracketName] = { ...bracket, matches };
	await saveTournament(tournament);
	return Response.json({ ok: true });
};
