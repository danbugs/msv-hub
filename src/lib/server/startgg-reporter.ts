/**
 * StartGG result reporter.
 *
 * All functions are best-effort: they never throw. Errors are returned as
 * { ok: false, error } so the caller can store them and surface them in the UI
 * without blocking the MSV Hub match flow.
 */

import { findSetInPhaseGroup, findSetByEntrants, reportSet, resetSet, gql, PHASE_GROUP_SETS_QUERY } from '$lib/server/startgg';
import { saveTournament } from '$lib/server/store';
import type { TournamentState, SwissMatch, BracketMatch, StartggSyncState } from '$lib/types/tournament';

// ── Internal helpers ────────────────────────────────────────────────────

function ensureSync(tournament: TournamentState): StartggSyncState {
	if (!tournament.startggSync) {
		tournament.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
	}
	return tournament.startggSync;
}

function addError(sync: StartggSyncState, matchId: string, message: string) {
	// Keep only the 20 most recent errors
	sync.errors = [{ matchId, message, ts: Date.now() }, ...sync.errors].slice(0, 20);
}

function clearErrorsForMatch(sync: StartggSyncState, matchId: string) {
	sync.errors = sync.errors.filter((e) => e.matchId !== matchId);
}

// ── Batch set-ID caching ─────────────────────────────────────────────────────

type GqlNode = { id: unknown; winnerId?: unknown; slots: { entrant: { id: unknown } | null }[] };
type PGData = { phaseGroup: { sets: { nodes: GqlNode[] } } };

/** Populate startggSetId on every match in a round from a batch of phase-group nodes. */
function applyNodesToRound(
	nodes: GqlNode[],
	round: { matches: { topPlayerId: string; bottomPlayerId: string; startggSetId?: string }[] },
	entrantMap: Map<string, { startggEntrantId?: number }>
) {
	for (const match of round.matches) {
		const top = entrantMap.get(match.topPlayerId);
		const bot = entrantMap.get(match.bottomPlayerId);
		if (!top?.startggEntrantId || !bot?.startggEntrantId) continue;
		const e1 = Number(top.startggEntrantId);
		const e2 = Number(bot.startggEntrantId);
		for (const node of nodes) {
			const ids = (node.slots ?? [])
				.map((s) => Number(s.entrant?.id))
				.filter((id): id is number => !isNaN(id) && id > 0);
			if (ids.includes(e1) && ids.includes(e2)) {
				match.startggSetId = String(node.id);
				break;
			}
		}
	}
}

/**
 * Fetch all sets for a phase group and populate startggSetId on every match in the round.
 * Retries up to 20×3 s — handles the preview→real transition window where 0 sets are returned.
 */
export async function preCacheRoundSetIds(
	tournament: TournamentState,
	roundNumber: number,
	phaseGroupId: number
): Promise<void> {
	const round = tournament.rounds.find((r) => r.number === roundNumber);
	if (!round) return;
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));

	let nodes: GqlNode[] = [];
	for (let retry = 0; retry <= 20; retry++) {
		if (retry > 0) await new Promise<void>((r) => setTimeout(r, 3000));
		const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId }, { delay: 0 });
		nodes = (data?.phaseGroup?.sets?.nodes ?? []) as GqlNode[];
		if (nodes.length > 0) break;
	}
	if (nodes.length === 0) return;

	applyNodesToRound(nodes, round, entrantMap);
}

/**
 * Proactively trigger the StartGG preview→real conversion at round start, then cache real IDs.
 *
 * Flow:
 *   1. Fetch preview set IDs from the phase group and cache them (best-effort first reports).
 *   2. If all IDs are already real (rounds 2+, or previously converted), set cacheReady and return.
 *   3. Otherwise report one preview set (triggers conversion) then immediately reset it.
 *   4. Poll until real IDs appear (up to 60 s), then cache them and set cacheReady = true.
 *
 * Caller must set startggSync.cacheReady = false and save before calling this, so the UI
 * shows the "Re-hydrating" banner immediately. This function saves when done.
 */
export async function triggerConversionAndCache(
	tournament: TournamentState,
	roundNumber: number,
	phaseGroupId: number
): Promise<void> {
	const round = tournament.rounds.find((r) => r.number === roundNumber);
	if (!round) return;

	const sync = ensureSync(tournament);
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));

	// Step 1: fetch current nodes (may be preview or real)
	const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId }, { delay: 0 });
	const nodes = (data?.phaseGroup?.sets?.nodes ?? []) as GqlNode[];
	if (nodes.length === 0) {
		// Phase group empty — can't proceed, leave cacheReady as-is
		return;
	}

	// Cache whatever IDs we have now (preview or real) so first reports can proceed immediately
	applyNodesToRound(nodes, round, entrantMap);
	await saveTournament(tournament);

	// Step 2: if already real IDs, we're done
	const allReal = nodes.every((n) => !String(n.id).startsWith('preview_'));
	if (allReal) {
		sync.cacheReady = true;
		await saveTournament(tournament);
		return;
	}

	// Step 3: fake-report one preview set to trigger the preview→real conversion
	const previewNode = nodes.find((n) => String(n.id).startsWith('preview_') && !n.winnerId);
	if (!previewNode) {
		// All preview sets already have results — skip fake-report, just poll
	} else {
		const setId = String(previewNode.id);
		const slotIds = (previewNode.slots ?? [])
			.map((s) => Number(s.entrant?.id))
			.filter((id): id is number => !isNaN(id) && id > 0);

		if (slotIds.length >= 2) {
			// Report with arbitrary winner — we'll reset immediately
			const reportResult = await reportSet(setId, slotIds[0]);
			if (reportResult.ok) {
				// Reset up to 3× to ensure the fake result is cleared
				const realSetId = reportResult.reportedSetId ?? setId;
				for (let attempt = 0; attempt < 3; attempt++) {
					const resetResult = await resetSet(realSetId);
					if (resetResult.ok) break;
					if (attempt < 2) await new Promise<void>((r) => setTimeout(r, 1000));
					else {
						// Reset failed — record error so the TO can see it
						addError(sync, 'cache-init', `StartGG set ${realSetId} could not be reset after fake report — please manually reset it on StartGG before reporting that match.`);
					}
				}
			}
		}
	}

	// Step 4: poll for real IDs (up to 60 s)
	await preCacheRoundSetIds(tournament, roundNumber, phaseGroupId);

	sync.cacheReady = true;
	await saveTournament(tournament);
}

// ── Set ID resolution ────────────────────────────────────────────────────────

/** Resolve the StartGG set ID for a match, using cached ID when available. */
async function resolveSetId(
	tournament: TournamentState,
	entrantId1: number,
	entrantId2: number,
	roundNumber: number,
	cachedSetId?: string
): Promise<string | null> {
	if (cachedSetId) return cachedSetId;

	// Try phase-group-scoped lookup. If we have phase group info for this round,
	// trust it exclusively — a full event scan risks finding a set in a different
	// phase (brackets, final standings) and silently reporting to the wrong place.
	const groups = tournament.startggPhase1Groups;
	if (groups && groups[roundNumber - 1]) {
		return findSetInPhaseGroup(
			groups[roundNumber - 1].id,
			entrantId1,
			entrantId2
		).catch(() => null);
	}

	// No phase group info — fall back to full event scan (only safe path when
	// startggPhase1Groups is not populated, e.g. older tournaments).
	if (tournament.startggEventId) {
		return findSetByEntrants(tournament.startggEventId, entrantId1, entrantId2).catch(() => null);
	}

	return null;
}

// ── Swiss reporting ─────────────────────────────────────────────────────

/**
 * Report a Swiss match result to StartGG.
 * Updates tournament in-place (sets startggSetId on match, records errors).
 * Caller must call saveTournament() after this returns.
 *
 * If the cached set ID is a preview ID that has since been invalidated (because another
 * match in the phase group was already reported), the first reportSet call will fail and
 * this function automatically retries with a fresh lookup. On success it also fires a
 * background preCacheRoundSetIds so the remaining matches get their real IDs populated
 * before the next report comes in.
 */
export async function reportSwissMatch(
	tournament: TournamentState,
	roundNumber: number,
	match: SwissMatch
): Promise<{ ok: boolean; error?: string }> {
	if (!match.winnerId) return { ok: false, error: 'No winner set on match' };

	const sync = ensureSync(tournament);
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));

	const topEntrant = entrantMap.get(match.topPlayerId);
	const botEntrant = entrantMap.get(match.bottomPlayerId);
	const winnerEntrant = entrantMap.get(match.winnerId);

	if (!topEntrant?.startggEntrantId || !botEntrant?.startggEntrantId || !winnerEntrant?.startggEntrantId) {
		const msg = `StartGG entrant IDs not found for ${topEntrant?.gamerTag ?? match.topPlayerId} (${topEntrant?.startggEntrantId ?? 'missing'}) vs ${botEntrant?.gamerTag ?? match.bottomPlayerId} (${botEntrant?.startggEntrantId ?? 'missing'}) — was tournament loaded from a StartGG event?`;
		addError(sync, match.id, msg);
		return { ok: false, error: msg };
	}

	let setId = await resolveSetId(
		tournament,
		topEntrant.startggEntrantId,
		botEntrant.startggEntrantId,
		roundNumber,
		match.startggSetId
	);

	if (!setId) {
		const pgId = tournament.startggPhase1Groups?.[roundNumber - 1]?.id;
		const msg = `Set not found for ${topEntrant.gamerTag} (entrant ${topEntrant.startggEntrantId}) vs ${botEntrant.gamerTag} (entrant ${botEntrant.startggEntrantId}) in phase group ${pgId ?? 'N/A'} (round ${roundNumber}). Unreported set may be missing — check StartGG phase group setup.`;
		addError(sync, match.id, msg);
		return { ok: false, error: msg };
	}

	const loserEntrant = winnerEntrant === topEntrant ? botEntrant : topEntrant;
	const winnerScore = match.winnerId === match.topPlayerId ? match.topScore : match.bottomScore;
	const loserScore  = match.winnerId === match.topPlayerId ? match.bottomScore : match.topScore;

	let result = await reportSet(setId, winnerEntrant.startggEntrantId, {
		loserEntrantId: loserEntrant.startggEntrantId,
		winnerScore,
		loserScore,
		isDQ: match.isDQ
	});

	// If we used a cached preview ID and the report failed, the phase group has already
	// converted to real IDs (another match triggered the conversion first). Do a short
	// inline retry with findSetInPhaseGroup (3×2 s = 6 s max) to get the real ID.
	// If still not found, fail fast — the match is saved in MSV Hub regardless, and the
	// background preCacheRoundSetIds will populate the real ID for the next retry.
	if (!result.ok && setId.startsWith('preview_')) {
		const pgId = tournament.startggPhase1Groups?.[roundNumber - 1]?.id;
		if (pgId) {
			match.startggSetId = undefined; // discard stale preview cache
			const freshId = await findSetInPhaseGroup(
				pgId,
				topEntrant.startggEntrantId,
				botEntrant.startggEntrantId
			).catch(() => null);
			if (freshId && !freshId.startsWith('preview_')) {
				setId = freshId;
				result = await reportSet(setId, winnerEntrant.startggEntrantId, {
					loserEntrantId: loserEntrant.startggEntrantId,
					winnerScore,
					loserScore
				});
			}
		}
	}

	if (result.ok) {
		match.startggSetId = result.reportedSetId ?? setId;
		clearErrorsForMatch(sync, match.id);

		// If we just reported a preview set, StartGG is converting the whole phase group
		// to real IDs. Fire off a background preCacheRoundSetIds (up to 60 s of retries)
		// so remaining matches get their real set IDs before the user reports them.
		// Fire-and-forget: does not block the current response.
		if (setId.startsWith('preview_')) {
			const pgId = tournament.startggPhase1Groups?.[roundNumber - 1]?.id;
			if (pgId) {
				preCacheRoundSetIds(tournament, roundNumber, pgId)
					.then(() => saveTournament(tournament))
					.catch(() => {});
			}
		}
	} else {
		addError(sync, match.id, result.error ?? 'Unknown StartGG error');
	}

	return result;
}

// ── Bracket reporting ───────────────────────────────────────────────────

/**
 * Report a bracket match result to StartGG.
 * If split is not yet confirmed, queues the match ID instead of reporting.
 * Caller must call saveTournament() after this returns.
 */
export async function reportBracketMatch(
	tournament: TournamentState,
	bracketName: 'main' | 'redemption',
	match: BracketMatch
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
	if (!match.winnerId || !match.topPlayerId || !match.bottomPlayerId) {
		return { ok: false, error: 'Match is incomplete' };
	}

	const sync = ensureSync(tournament);
	const pendingKey = `${bracketName}:${match.id}`;

	if (!sync.splitConfirmed) {
		// Queue for later
		if (!sync.pendingBracketMatchIds.includes(pendingKey)) {
			sync.pendingBracketMatchIds.push(pendingKey);
		}
		return { ok: true, queued: true };
	}

	return _doReportBracketMatch(tournament, bracketName, match, sync, pendingKey);
}

async function _doReportBracketMatch(
	tournament: TournamentState,
	_bracketName: string,
	match: BracketMatch,
	sync: StartggSyncState,
	pendingKey: string
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));

	const topEntrant = entrantMap.get(match.topPlayerId!);
	const botEntrant = entrantMap.get(match.bottomPlayerId!);
	const winnerEntrant = entrantMap.get(match.winnerId!);

	if (!topEntrant?.startggEntrantId || !botEntrant?.startggEntrantId || !winnerEntrant?.startggEntrantId) {
		const msg = 'StartGG entrant IDs not found for bracket match';
		addError(sync, match.id, msg);
		return { ok: false, error: msg };
	}

	// For brackets, use full event scan (no phase group mapping implemented yet)
	let setId = match.startggSetId ?? null;
	if (!setId && tournament.startggEventId) {
		setId = await findSetByEntrants(
			tournament.startggEventId,
			topEntrant.startggEntrantId,
			botEntrant.startggEntrantId
		).catch(() => null);
	}

	if (!setId) {
		const msg = `Bracket set not found on StartGG for ${topEntrant.gamerTag} vs ${botEntrant.gamerTag}`;
		addError(sync, match.id, msg);
		return { ok: false, error: msg };
	}

	const loserEntrant = winnerEntrant === topEntrant ? botEntrant : topEntrant;
	const winnerScore = match.winnerId === match.topPlayerId ? match.topScore : match.bottomScore;
	const loserScore  = match.winnerId === match.topPlayerId ? match.bottomScore : match.topScore;

	const result = await reportSet(setId, winnerEntrant.startggEntrantId, {
		loserEntrantId: loserEntrant.startggEntrantId,
		winnerScore,
		loserScore
	});

	if (result.ok) {
		match.startggSetId = result.reportedSetId ?? setId;
		clearErrorsForMatch(sync, match.id);
		// Remove from pending queue if it was there
		sync.pendingBracketMatchIds = sync.pendingBracketMatchIds.filter((id) => id !== pendingKey);
	} else {
		addError(sync, match.id, result.error ?? 'Unknown StartGG error');
	}

	return result;
}

// ── Flush pending bracket matches ───────────────────────────────────────

/**
 * Flush all queued bracket match reports after split is confirmed.
 * Sets splitConfirmed=true, processes the queue, saves tournament once at the end.
 * Returns count of successful and failed reports.
 */
export async function flushPendingBracketMatches(
	tournament: TournamentState
): Promise<{ reported: number; failed: number }> {
	const sync = ensureSync(tournament);
	sync.splitConfirmed = true;

	if (!tournament.brackets || sync.pendingBracketMatchIds.length === 0) {
		await saveTournament(tournament);
		return { reported: 0, failed: 0 };
	}

	const pending = [...sync.pendingBracketMatchIds];
	let reported = 0;
	let failed = 0;

	for (const key of pending) {
		const [bracketName, matchId] = key.split(':') as ['main' | 'redemption', string];
		const bracket = tournament.brackets[bracketName];
		if (!bracket) continue;

		const match = bracket.matches.find((m) => m.id === matchId);
		if (!match || !match.winnerId) continue;

		const result = await _doReportBracketMatch(tournament, bracketName, match, sync, key);
		if (result.ok && !result.queued) reported++;
		else if (!result.ok) failed++;
	}

	await saveTournament(tournament);
	return { reported, failed };
}
