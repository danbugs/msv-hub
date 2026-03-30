import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { pushPairingsToPhaseGroup } from '$lib/server/startgg';
import { triggerConversionAndCache } from '$lib/server/startgg-reporter';

/**
 * POST — "Phase Reset Done": user has manually reset the phase on StartGG.
 * Re-seeds the phase group with the current MSV Hub pairings, then re-triggers
 * preview→real conversion so set IDs are ready for reporting.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const pending = tournament.startggSync?.pendingPhaseReset;
	if (!pending) return Response.json({ error: 'No pending phase reset' }, { status: 400 });

	const { roundNumber, phaseGroupId, phaseId } = pending;
	const round = tournament.rounds.find((r) => r.number === roundNumber);
	if (!round) return Response.json({ error: `Round ${roundNumber} not found` }, { status: 404 });

	// Build pairings from current round matches
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
	const sgPairings = round.matches
		.map((m): [number, number] | null => {
			const t = entrantMap.get(m.topPlayerId)?.startggEntrantId;
			const b = entrantMap.get(m.bottomPlayerId)?.startggEntrantId;
			return t && b ? [t, b] : null;
		})
		.filter((p): p is [number, number] => p !== null);

	const byeEntrantId = round.byePlayerId
		? entrantMap.get(round.byePlayerId)?.startggEntrantId
		: undefined;

	// Re-seed
	const seedResult = await pushPairingsToPhaseGroup(phaseId, phaseGroupId, sgPairings, byeEntrantId)
		.catch((e) => ({ ok: false as const, error: String(e) }));

	if (!seedResult.ok) {
		return Response.json({
			error: `Re-seed failed: ${seedResult.error}. Make sure you reset the phase on StartGG first.`
		}, { status: 400 });
	}

	// Clear cached set IDs and re-trigger conversion
	for (const m of round.matches) m.startggSetId = undefined;
	tournament.startggSync!.pendingPhaseReset = undefined;
	tournament.startggSync!.cacheReady = false;
	await saveTournament(tournament);

	// Fire conversion in background
	triggerConversionAndCache(tournament, roundNumber, phaseGroupId).catch(() => {});

	return Response.json({ ok: true, roundNumber });
};
