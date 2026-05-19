import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';

/**
 * PATCH /api/tournament/bracket/place-player
 *
 * Manually place a player into a specific match slot. MSV Hub only — no StartGG calls.
 * Used to correct bracket display when generation or sync produces wrong pairings.
 * Normal match reporting and propagation still work after manual placement.
 *
 * Body: { bracketName, matchId, slot: 'top' | 'bottom', entrantId }
 *   - entrantId: the MSV Hub entrant ID to place (or null to clear the slot)
 */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.brackets) return Response.json({ error: 'No brackets generated' }, { status: 400 });

	const body = await request.json();
	const { bracketName, matchId, slot, entrantId } = body as {
		bracketName: 'main' | 'redemption';
		matchId: string;
		slot: 'top' | 'bottom';
		entrantId: string | null;
	};

	if (!bracketName || !matchId || !slot) {
		return Response.json({ error: 'bracketName, matchId, and slot are required' }, { status: 400 });
	}
	if (slot !== 'top' && slot !== 'bottom') {
		return Response.json({ error: 'slot must be "top" or "bottom"' }, { status: 400 });
	}

	const bracket = tournament.brackets[bracketName];
	if (!bracket) return Response.json({ error: `Bracket "${bracketName}" not found` }, { status: 404 });

	const match = bracket.matches.find((m) => m.id === matchId);
	if (!match) return Response.json({ error: `Match "${matchId}" not found` }, { status: 404 });

	if (match.winnerId) {
		return Response.json({ error: 'Cannot modify a reported match. Unreport it first.' }, { status: 400 });
	}

	if (entrantId) {
		const entrant = tournament.entrants.find((e) => e.id === entrantId);
		if (!entrant) return Response.json({ error: `Entrant "${entrantId}" not found` }, { status: 404 });
	}

	const prev = slot === 'top' ? match.topPlayerId : match.bottomPlayerId;
	if (slot === 'top') {
		match.topPlayerId = entrantId ?? undefined;
	} else {
		match.bottomPlayerId = entrantId ?? undefined;
	}

	await saveTournament(tournament);

	const entrant = entrantId ? tournament.entrants.find((e) => e.id === entrantId) : null;
	return Response.json({
		ok: true,
		matchId,
		slot,
		previous: prev ?? null,
		placed: entrantId,
		placedTag: entrant?.gamerTag ?? null
	});
};
