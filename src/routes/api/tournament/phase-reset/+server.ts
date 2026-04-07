import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { pushPairingsToPhaseGroup } from '$lib/server/startgg';
import { triggerConversionAndCache } from '$lib/server/startgg-reporter';
import { restartPhase } from '$lib/server/startgg-admin';

/**
 * POST — Automatically restarts the phase on StartGG, re-seeds with current pairings,
 * and re-triggers conversion. No manual step needed on StartGG.
 */
export const POST: RequestHandler = async ({ locals, platform }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const pending = tournament.startggSync?.pendingPhaseReset;
	if (!pending) return Response.json({ error: 'No pending phase reset' }, { status: 400 });

	const { roundNumber, phaseGroupId, phaseId } = pending;
	const round = tournament.rounds.find((r) => r.number === roundNumber);
	if (!round) return Response.json({ error: `Round ${roundNumber} not found` }, { status: 404 });

	// Step 1: Restart the phase on StartGG (resets all sets, un-starts the pool)
	console.log(`[phase-reset] Restarting phase ${phaseId} for round ${roundNumber}...`);
	const restartResult = await restartPhase(phaseId).catch((e) => ({ ok: false as const, error: String(e) }));
	if (!restartResult.ok) {
		return Response.json({
			error: `Phase restart failed: ${restartResult.error}`
		}, { status: 400 });
	}
	console.log(`[phase-reset] Phase ${phaseId} restarted`);

	// Step 2: Re-seed with current MSV Hub pairings
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

	const seedResult = await pushPairingsToPhaseGroup(phaseId, phaseGroupId, sgPairings, byeEntrantId)
		.catch((e) => ({ ok: false as const, error: String(e) }));

	if (!seedResult.ok) {
		console.error(`[phase-reset] Re-seed failed: ${seedResult.error}`);
	} else {
		console.log(`[phase-reset] Re-seed successful`);
	}

	// Step 3: Clear cached set IDs and trigger conversion
	for (const m of round.matches) m.startggSetId = undefined;
	tournament.startggSync!.pendingPhaseReset = undefined;
	tournament.startggSync!.cacheReady = false;
	await saveTournament(tournament);

	const conversionPromise = triggerConversionAndCache(tournament, roundNumber, phaseGroupId).catch((e) => {
		console.error(`[phase-reset] conversion failed: ${e}`);
	});
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = (platform as any)?.context;
		if (ctx?.waitUntil) ctx.waitUntil(conversionPromise);
	} catch { /* not on Vercel */ }

	return Response.json({ ok: true, roundNumber });
};
