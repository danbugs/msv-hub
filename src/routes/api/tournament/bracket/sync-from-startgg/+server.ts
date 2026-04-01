import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { generateBracket } from '$lib/server/swiss';

/**
 * POST — Reset bracket to a clean state from final standings.
 * Use as an escape hatch when MSV Hub bracket gets into a bad state.
 * Regenerates the bracket structure, clearing all match results.
 * StartGG state is NOT affected — use this alongside manual StartGG fixes.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.finalStandings) return Response.json({ error: 'No final standings' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const bracketName = (body as { bracketName?: string }).bracketName as 'main' | 'redemption' | undefined;
	if (!bracketName) return Response.json({ error: 'bracketName required' }, { status: 400 });

	const standings = tournament.finalStandings;
	const players = bracketName === 'main'
		? standings.filter((s) => s.bracket === 'main').map((s) => ({ entrantId: s.entrantId, seed: s.rank }))
		: standings.filter((s) => s.bracket === 'redemption').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));

	if (!tournament.brackets) {
		return Response.json({ error: 'No brackets to reset' }, { status: 400 });
	}

	tournament.brackets[bracketName] = generateBracket(bracketName, players, standings);

	// Clear errors for this bracket
	if (tournament.startggSync) {
		const matchIds = new Set(tournament.brackets[bracketName].matches.map((m) => m.id));
		tournament.startggSync.errors = tournament.startggSync.errors.filter((e) => !matchIds.has(e.matchId));
	}

	await saveTournament(tournament);
	return Response.json({ ok: true, bracketName, matchCount: tournament.brackets[bracketName].matches.length });
};
