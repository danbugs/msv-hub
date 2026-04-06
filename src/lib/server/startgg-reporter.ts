/**
 * StartGG result reporter.
 *
 * All functions are best-effort: they never throw. Errors are returned as
 * { ok: false, error } so the caller can store them and surface them in the UI
 * without blocking the MSV Hub match flow.
 */

import { findSetInPhaseGroup, findSetByEntrants, reportSet, resetSet, gql, PHASE_GROUP_SETS_QUERY, PHASE_GROUP_SEEDS_QUERY, fetchAllEntrants } from '$lib/server/startgg';
import { saveTournament, getActiveTournament } from '$lib/server/store';
import type { TournamentState, SwissMatch, BracketMatch, StartggSyncState } from '$lib/types/tournament';

// ── Bracket entrant ID translation cache ─────────────────────────────────
// Swiss and bracket events have different entrant IDs for the same players.
// This cache maps Swiss entrant ID → bracket entrant ID via player ID matching.
let _bracketEntrantCache: Map<string, Map<number, number>> | null = null;

type SeedNode = { entrant?: { id?: number; participants?: { player?: { id?: number } }[] } };

async function buildBracketEntrantTranslation(
	swissPgId: number,
	bracketEventId: number
): Promise<Map<number, number>> {
	const translation = new Map<number, number>();

	// Fetch Swiss seeds (with player IDs)
	const swissData = await gql<{ phaseGroup: { seeds: { nodes: SeedNode[] } } }>(
		PHASE_GROUP_SEEDS_QUERY, { phaseGroupId: swissPgId, page: 1, perPage: 64 }, { delay: 0 }
	).catch(() => null);
	const swissSeeds = swissData?.phaseGroup?.seeds?.nodes ?? [];

	// Build Swiss entrantId → playerId
	const swissEntrantToPlayer = new Map<number, number>();
	for (const s of swissSeeds) {
		const eid = s.entrant?.id;
		const pid = s.entrant?.participants?.[0]?.player?.id;
		if (eid && pid) swissEntrantToPlayer.set(Number(eid), Number(pid));
	}

	// Fetch bracket event entrants (with player IDs)
	// fetchAllEntrants returns { id, participants: [{ player: { id, gamerTag } }] }
	const bracketEntrants = await fetchAllEntrants(bracketEventId, undefined).catch(() => []);

	// Build bracket playerId → entrantId
	const bracketPlayerToEntrant = new Map<number, number>();
	for (const e of bracketEntrants) {
		const eid = (e as Record<string, unknown>).id as number | undefined;
		const participants = (e as Record<string, unknown>).participants as { player?: { id?: number } }[] | undefined;
		const pid = participants?.[0]?.player?.id;
		if (eid && pid) bracketPlayerToEntrant.set(Number(pid), Number(eid));
	}

	// Map: Swiss entrantId → playerId → bracket entrantId
	for (const [swissEid, playerId] of swissEntrantToPlayer) {
		const bracketEid = bracketPlayerToEntrant.get(playerId);
		if (bracketEid) translation.set(swissEid, bracketEid);
	}

	console.log(`[StartGG] Bracket entrant translation: ${translation.size} players mapped (swiss→bracket)`);
	return translation;
}

// ── Internal helpers ────────────────────────────────────────────────────

function ensureSync(tournament: TournamentState): StartggSyncState {
	if (!tournament.startggSync) {
		tournament.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
	}
	return tournament.startggSync;
}

function addError(sync: StartggSyncState, matchId: string, message: string) {
	const actionable = `${message}. Try re-reporting matches that aren't showing as reported on StartGG.`;
	sync.errors = [{ matchId, message: actionable, ts: Date.now() }, ...sync.errors].slice(0, 20);
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
 * Convert preview set IDs to real IDs and cache them on every match.
 *
 * Reports a dummy result on the first preview set to trigger StartGG's preview→real
 * conversion, resets it, waits for real IDs, and caches them. This makes all subsequent
 * match reports instant (set IDs already resolved).
 *
 * NOTE: This "starts" the pool on StartGG, making re-seeding impossible. If pairings
 * need to change (misreport fix), the user must manually reset the phase on StartGG
 * first, then click "Phase Reset Done" in MSV Hub to re-seed and re-convert.
 *
 * Caller must set startggSync.cacheReady = false and save before calling.
 * Sets cacheReady = true when done.
 */
export async function triggerConversionAndCache(
	_stale: TournamentState,
	roundNumber: number,
	phaseGroupId: number
): Promise<void> {
	const startTime = Date.now();
	console.log(`[conversion] Starting for round ${roundNumber}, PG ${phaseGroupId}`);

	// Fetch sets — retry if empty (phase might still be resetting on StartGG)
	let nodes: GqlNode[] = [];
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 2000));
		try {
			const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId }, { delay: 0 });
			nodes = (data?.phaseGroup?.sets?.nodes ?? []) as GqlNode[];
		} catch { /* retry */ }
		if (nodes.length > 0) break;
		console.log(`[conversion] Attempt ${attempt + 1}: 0 sets returned, retrying...`);
	}
	console.log(`[conversion] Got ${nodes.length} sets`);

	// ALWAYS do a dummy report + reset — no conditions, no checks
	const dummySet = nodes.find((n) =>
		n.slots?.length >= 2 && n.slots[0]?.entrant?.id && n.slots[1]?.entrant?.id
	);
	if (dummySet) {
		const dummyWinnerId = Number(dummySet.slots[0].entrant!.id);
		console.log(`[conversion] Dummy report on set ${dummySet.id}, winner ${dummyWinnerId}`);
		const reportResult = await reportSet(String(dummySet.id), dummyWinnerId, {})
			.catch((e) => { console.log(`[conversion] Dummy report error: ${e}`); return { ok: false as const }; });
		console.log(`[conversion] Dummy report result: ok=${reportResult.ok}`);
		if (reportResult.ok) {
			const realSetId = reportResult.reportedSetId ?? String(dummySet.id);
			console.log(`[conversion] Resetting set ${realSetId}`);
			await resetSet(realSetId).catch(() => {});
		}

		// Wait for real IDs if we had preview sets
		if (String(dummySet.id).startsWith('preview_')) {
			console.log('[conversion] Waiting for preview→real conversion...');
			nodes = [];
			for (let retry = 1; retry <= 10; retry++) {
				await new Promise<void>((r) => setTimeout(r, retry <= 3 ? 2000 : 4000));
				try {
					const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId }, { delay: 0 });
					nodes = (data?.phaseGroup?.sets?.nodes ?? []) as GqlNode[];
				} catch { /* continue */ }
				if (nodes.length > 0) { console.log(`[conversion] Got ${nodes.length} real sets after ${retry} retries`); break; }
			}
		}
	} else {
		console.log('[conversion] No suitable set found for dummy report');
	}

	// Safe merge: re-load latest state so we never overwrite concurrent match results
	const fresh = await getActiveTournament();
	if (!fresh) return;

	const round = fresh.rounds.find((r) => r.number === roundNumber);
	if (round && nodes.length > 0) {
		const entrantMap = new Map(fresh.entrants.map((e) => [e.id, e]));
		applyNodesToRound(nodes, round, entrantMap);
	}

	// Ensure the "Preparing" banner shows for at least 3 seconds so the user
	// sees confirmation that the conversion ran.
	const elapsed = Date.now() - startTime;
	if (elapsed < 3000) await new Promise<void>((r) => setTimeout(r, 3000 - elapsed));

	const sync = ensureSync(fresh);
	sync.cacheReady = true;
	await saveTournament(fresh);
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

	// Resolve the StartGG set ID. findSetInPhaseGroup already retries internally
	// during the preview→real conversion window, so no outer retry loop needed.
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

	const reportExtra = {
		loserEntrantId: loserEntrant.startggEntrantId,
		winnerScore,
		loserScore,
		isDQ: match.isDQ
	};

	let result = await reportSet(setId, winnerEntrant.startggEntrantId, reportExtra);

	// If we used a cached preview ID and the report failed, the phase group has already
	// converted to real IDs (another match triggered the conversion first). Re-lookup.
	if (!result.ok && setId.startsWith('preview_')) {
		const pgId = tournament.startggPhase1Groups?.[roundNumber - 1]?.id;
		if (pgId) {
			match.startggSetId = undefined;
			const freshId = await findSetInPhaseGroup(
				pgId,
				topEntrant.startggEntrantId,
				botEntrant.startggEntrantId
			).catch(() => null);
			if (freshId && !freshId.startsWith('preview_')) {
				setId = freshId;
				result = await reportSet(setId, winnerEntrant.startggEntrantId, reportExtra);
			}
		}
	}

	// If the set is already completed (misreport fix or re-report), reset first then re-report.
	if (!result.ok && result.error?.includes('Cannot report completed set')) {
		const resetResult = await resetSet(setId);
		if (resetResult.ok) {
			result = await reportSet(setId, winnerEntrant.startggEntrantId, reportExtra);
		}
	}

	if (result.ok) {
		match.startggSetId = result.reportedSetId ?? setId;
		clearErrorsForMatch(sync, match.id);

		// If we just reported a preview set, StartGG converts the whole phase group to real
		// IDs. Cache all real set IDs on the tournament object so subsequent reports in the
		// same request resolve from cache. The PATCH handler does a safe-merge save, so
		// these cached IDs will be persisted for future requests too.
		if (setId.startsWith('preview_')) {
			const pgId = tournament.startggPhase1Groups?.[roundNumber - 1]?.id;
			if (pgId) {
				// Quick attempt: try to get real IDs immediately (works if conversion is fast)
				try {
					const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: pgId }, { delay: 0 });
					const nodes = (data?.phaseGroup?.sets?.nodes ?? []) as GqlNode[];
					if (nodes.length > 0) {
						const round = tournament.rounds.find((r) => r.number === roundNumber);
						if (round) applyNodesToRound(nodes, round, entrantMap);
					}
				} catch { /* best effort — findSetInPhaseGroup retry will handle it */ }
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

	// Brackets are separate events on StartGG with different entrant IDs.
	// Translate Swiss entrant IDs → bracket entrant IDs via the player ID cache.
	const bracketEventId = _bracketName === 'main'
		? tournament.startggMainBracketEventId
		: tournament.startggRedemptionBracketEventId;

	if (!bracketEventId) {
		console.log(`[StartGG] No ${_bracketName} bracket event ID configured — skipping sync`);
		return { ok: true };
	}

	// Translate Swiss entrant IDs to bracket entrant IDs via findSetByEntrants
	// which searches by entrant ID within an event. We need to use bracket-event
	// entrant IDs, so first translate via the player ID mapping.
	const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
	let bracketTopEntrantId = topEntrant.startggEntrantId;
	let bracketBotEntrantId = botEntrant.startggEntrantId;
	let bracketWinnerEntrantId = winnerEntrant.startggEntrantId;

	if (swissPgId) {
		// Use the cached translation or build it
		if (!_bracketEntrantCache) {
			_bracketEntrantCache = new Map();
		}
		const cacheKey = `${_bracketName}-${bracketEventId}`;
		let translation = _bracketEntrantCache.get(cacheKey);
		if (!translation) {
			translation = await buildBracketEntrantTranslation(swissPgId, bracketEventId);
			if (translation.size > 0) _bracketEntrantCache.set(cacheKey, translation);
		}
		bracketTopEntrantId = translation.get(topEntrant.startggEntrantId) ?? topEntrant.startggEntrantId;
		bracketBotEntrantId = translation.get(botEntrant.startggEntrantId) ?? botEntrant.startggEntrantId;
		bracketWinnerEntrantId = translation.get(winnerEntrant.startggEntrantId) ?? winnerEntrant.startggEntrantId;
	}

	let setId = match.startggSetId ?? null;
	if (!setId) {
		setId = await findSetByEntrants(
			bracketEventId,
			bracketTopEntrantId,
			bracketBotEntrantId
		).catch(() => null);
	}

	if (!setId) {
		const msg = `Bracket set not found on StartGG for ${topEntrant.gamerTag} vs ${botEntrant.gamerTag}`;
		addError(sync, match.id, msg);
		return { ok: false, error: msg };
	}

	const loserEntrant = winnerEntrant === topEntrant ? botEntrant : topEntrant;
	const bracketLoserEntrantId = winnerEntrant === topEntrant ? bracketBotEntrantId : bracketTopEntrantId;
	const winnerScore = match.winnerId === match.topPlayerId ? match.topScore : match.bottomScore;
	const loserScore  = match.winnerId === match.topPlayerId ? match.bottomScore : match.topScore;

	// Build per-game character data from match's topCharacters/bottomCharacters
	const gameCharacters: { entrantId: number; characters: string[] }[] = [];
	if (match.topCharacters?.length) {
		gameCharacters.push({ entrantId: bracketTopEntrantId, characters: match.topCharacters });
	}
	if (match.bottomCharacters?.length) {
		gameCharacters.push({ entrantId: bracketBotEntrantId, characters: match.bottomCharacters });
	}

	const reportExtra = {
		loserEntrantId: bracketLoserEntrantId,
		winnerScore,
		loserScore,
		isDQ: match.isDQ,
		gameCharacters: !match.isDQ && gameCharacters.length > 0 ? gameCharacters : undefined,
		gameWinners: !match.isDQ ? match.gameWinners : undefined,
		topEntrantId: bracketTopEntrantId,
		bottomEntrantId: bracketBotEntrantId
	};

	let result = await reportSet(setId, bracketWinnerEntrantId, reportExtra);

	// If set is already completed (dummy conversion leftover or misreport), reset then re-report
	if (!result.ok && result.error?.includes('Cannot report completed set')) {
		const resetResult = await resetSet(setId);
		if (resetResult.ok) {
			result = await reportSet(setId, bracketWinnerEntrantId, reportExtra);
		}
	}

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
