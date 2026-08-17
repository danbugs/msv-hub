import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { pushPairingsToPhaseGroup, validateStartGGToken, StartGGAuthError } from '$lib/server/startgg';
import { addEntrantsToPhase, restartPhase } from '$lib/server/startgg-admin';
import { triggerConversionAndCache } from '$lib/server/startgg-reporter';

/**
 * POST — Re-push pairings for a given Swiss round to StartGG.
 * Handles the case where the initial sync failed (network error, pool already started, etc.)
 * by restarting the phase if needed and re-pushing pairings.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	try {
		await validateStartGGToken();
	} catch (e) {
		if (e instanceof StartGGAuthError) {
			return Response.json({ error: `StartGG auth failed: ${(e as Error).message}` }, { status: 401 });
		}
		throw e;
	}

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (tournament.phase !== 'swiss') return Response.json({ error: 'Tournament is not in Swiss phase' }, { status: 400 });

	const { roundNumber } = await request.json() as { roundNumber: number };
	if (!roundNumber || roundNumber < 1) return Response.json({ error: 'Invalid round number' }, { status: 400 });

	const round = tournament.rounds.find((r) => r.number === roundNumber);
	if (!round) return Response.json({ error: `Round ${roundNumber} not found` }, { status: 404 });

	// Look up the phase group for this round
	const roundGroup = tournament.startggPhase1Groups?.find(g => g.roundNumber === roundNumber)
		?? tournament.startggPhase1Groups?.[roundNumber - 1];
	const pgId = roundGroup?.id;
	const roundPhaseId = roundGroup?.phaseId ?? tournament.startggPhase1Id;

	if (!pgId || !roundPhaseId) {
		return Response.json({ error: `No StartGG phase group mapped for round ${roundNumber}` }, { status: 400 });
	}

	// Step 1: Add all entrants to this round's phase (they're only in R1 by default)
	if (roundNumber > 1 && tournament.startggEventId) {
		const allEntrantIds = tournament.entrants
			.map((e) => e.startggEntrantId)
			.filter((id): id is number => id !== undefined);
		if (allEntrantIds.length) {
			const addResult = await addEntrantsToPhase(tournament.startggEventId, roundPhaseId, allEntrantIds)
				.catch((e) => ({ ok: false as const, error: String(e) }));
			if (addResult.ok) {
				console.log(`[repush] Added ${allEntrantIds.length} entrants to round ${roundNumber} phase ${roundPhaseId}`);
			} else {
				console.warn(`[repush] Failed to add entrants (may already be present): ${addResult.error}`);
			}
		}
	}

	// Step 2: Build pairings from current round matches
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
	const sgPairings = round.matches
		.map((m): [number, number] | null => {
			const t = entrantMap.get(m.topPlayerId)?.startggEntrantId;
			const b = entrantMap.get(m.bottomPlayerId)?.startggEntrantId;
			return t && b ? [t, b] : null;
		})
		.filter((p): p is [number, number] => p !== null);

	if (!sgPairings.length) {
		return Response.json({ error: 'No valid pairings to push (missing StartGG entrant IDs)' }, { status: 400 });
	}

	const byeEntrantId = round.byePlayerId
		? entrantMap.get(round.byePlayerId)?.startggEntrantId
		: undefined;

	// Step 3: Push pairings; if pool is already started, restart the phase and retry
	console.log(`[repush] Pushing ${sgPairings.length} pairings to phase group ${pgId} for round ${roundNumber}`);
	let seedResult = await pushPairingsToPhaseGroup(roundPhaseId, pgId, sgPairings, byeEntrantId)
		.catch((e) => ({ ok: false as const, error: String(e) }));

	if (!seedResult.ok) {
		console.warn(`[repush] First push failed: ${seedResult.error} — restarting phase and retrying`);
		const restartResult = await restartPhase(roundPhaseId).catch((e) => ({ ok: false as const, error: String(e) }));
		if (!restartResult.ok) {
			return Response.json({ error: `Phase restart failed: ${restartResult.error}` }, { status: 500 });
		}
		console.log(`[repush] Phase ${roundPhaseId} restarted, retrying push...`);

		seedResult = await pushPairingsToPhaseGroup(roundPhaseId, pgId, sgPairings, byeEntrantId)
			.catch((e) => ({ ok: false as const, error: String(e) }));

		if (!seedResult.ok) {
			return Response.json({ error: `Re-push failed after phase restart: ${seedResult.error}` }, { status: 500 });
		}
	}

	console.log(`[repush] Pairings pushed successfully for round ${roundNumber}`);

	// Step 4: Clear cached set IDs and re-trigger conversion
	for (const m of round.matches) m.startggSetId = undefined;
	if (tournament.startggSync?.pendingPhaseReset?.roundNumber === roundNumber) {
		tournament.startggSync.pendingPhaseReset = undefined;
	}
	if (!tournament.startggSync) {
		tournament.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
	}
	tournament.startggSync.cacheReady = false;
	await saveTournament(tournament);

	// Background cache
	triggerConversionAndCache(tournament, roundNumber, pgId).catch(() => {});

	return Response.json({ ok: true, roundNumber, pairings: sgPairings.length });
};
