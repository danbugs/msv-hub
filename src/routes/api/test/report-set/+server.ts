/**
 * POST /api/test/report-set
 *
 * Test endpoint for the internal-REST set reporting path. Use via browser:
 *
 *   fetch('/api/test/report-set', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ phaseGroupId: 3251999, winnerTag: '1Test', score: '2-0' })
 *   }).then(r => r.json()).then(console.log)
 *
 * This picks the first unreported set in the phase group and reports it via
 * StartGG's internal REST API (the one the UI uses).
 */

import type { RequestHandler } from './$types';
import { fetchAdminPhaseGroupSetsRaw, completeSetViaAdminRest } from '$lib/server/startgg-admin';
import { getActiveTournament } from '$lib/server/store';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json() as {
		phaseGroupId?: number;
		winnerTag?: string;
		score?: string; // e.g. "2-0"
		isDQ?: boolean;
	};

	if (!body.phaseGroupId) return Response.json({ error: 'phaseGroupId required' }, { status: 400 });

	const t0 = Date.now();
	const sets = await fetchAdminPhaseGroupSetsRaw(body.phaseGroupId);
	const t1 = Date.now();

	// Find the first unreported set
	const target = sets.find((s) => !s.winnerId && Number(s.entrant1Id) > 0 && Number(s.entrant2Id) > 0);
	if (!target) {
		return Response.json({
			error: 'No unreported set with entrants found',
			totalSets: sets.length,
			firstFew: sets.slice(0, 3).map((s) => ({ id: s.id, entrant1Id: s.entrant1Id, entrant2Id: s.entrant2Id, winnerId: s.winnerId }))
		}, { status: 400 });
	}

	// Resolve winner: either explicit tag lookup or default to entrant1
	const tournament = await getActiveTournament();
	let winnerEntrantId = Number(target.entrant1Id);
	if (body.winnerTag && tournament) {
		const winner = tournament.entrants.find((e) => e.gamerTag?.toLowerCase() === body.winnerTag!.toLowerCase());
		if (winner?.startggEntrantId) winnerEntrantId = winner.startggEntrantId;
	}

	// Parse score
	const [wScore = 2, lScore = 0] = (body.score ?? '2-0').split('-').map(Number);
	const e1Score = winnerEntrantId === Number(target.entrant1Id) ? wScore : lScore;
	const e2Score = winnerEntrantId === Number(target.entrant2Id) ? wScore : lScore;

	const t2 = Date.now();
	const result = await completeSetViaAdminRest(
		String(target.id),
		target,
		winnerEntrantId,
		e1Score,
		e2Score,
		body.isDQ ?? false
	);
	const t3 = Date.now();

	return Response.json({
		ok: result.ok,
		error: result.error,
		setId: target.id,
		realSetId: result.realSetId,
		winnerEntrantId,
		scores: { e1: e1Score, e2: e2Score },
		timingsMs: {
			fetchSets: t1 - t0,
			reportSet: t3 - t2,
			total: t3 - t0
		}
	});
};
