import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';

/** PUT — set stream match for a bracket */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.brackets) return Response.json({ error: 'No brackets' }, { status: 400 });

	const body = await request.json();
	const { bracketName, matchId } = body as { bracketName: 'main' | 'redemption'; matchId: string };
	if (!bracketName || !matchId) {
		return Response.json({ error: 'bracketName and matchId are required' }, { status: 400 });
	}

	const bracket = tournament.brackets[bracketName];
	if (!bracket) return Response.json({ error: `Bracket "${bracketName}" not found` }, { status: 404 });

	const targetMatch = bracket.matches.find((m) => m.id === matchId);
	if (!targetMatch) return Response.json({ error: 'Match not found' }, { status: 404 });

	// Clear stream from ALL bracket matches (both main and redemption)
	for (const b of Object.values(tournament.brackets)) {
		for (const m of b.matches) m.isStream = false;
	}

	// Set new stream match
	targetMatch.isStream = true;

	await saveTournament(tournament);
	return Response.json({ ok: true });
};
