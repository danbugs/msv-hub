/**
 * POST /api/tournament/startgg-sync
 *
 * Confirms that the main/redemption bracket split has been corrected in StartGG,
 * then flushes all queued bracket match reports.
 *
 * DELETE /api/tournament/startgg-sync
 *
 * Clears stored StartGG errors from the tournament state.
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { flushPendingBracketMatches } from '$lib/server/startgg-reporter';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (tournament.phase !== 'brackets' && tournament.phase !== 'completed') {
		return Response.json({ error: 'Tournament is not in brackets phase' }, { status: 400 });
	}

	const { reported, failed } = await flushPendingBracketMatches(tournament);

	return Response.json({
		ok: true,
		splitConfirmed: true,
		reported,
		failed,
		errors: tournament.startggSync?.errors ?? []
	});
};

export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	if (tournament.startggSync) {
		tournament.startggSync.errors = [];
	}
	await saveTournament(tournament);
	return Response.json({ ok: true });
};
