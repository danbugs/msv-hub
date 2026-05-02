/**
 * StartGG result reporter.
 *
 * All functions are best-effort: they never throw. Errors are returned as
 * { ok: false, error } so the caller can store them and surface them in the UI
 * without blocking the MSV Hub match flow.
 */

import { findSetInPhaseGroup, findSetByEntrants, reportSet, resetSet, gql, PHASE_GROUP_SETS_QUERY, PHASE_GROUP_SEEDS_QUERY, fetchAllEntrants } from '$lib/server/startgg';
import { fetchAdminPhaseGroupSets, fetchAdminPhaseGroupSetsRaw, completeSetViaAdminRest } from '$lib/server/startgg-admin';
import { saveTournament, getActiveTournament } from '$lib/server/store';
import type { TournamentState, SwissMatch, BracketMatch, StartggSyncState } from '$lib/types/tournament';

// ── Bracket entrant ID translation cache ─────────────────────────────────
// Swiss and bracket events have different entrant IDs for the same players.
// This cache maps Swiss entrant ID → bracket entrant ID via player ID matching.
let _bracketEntrantCache: Map<string, Map<number, number>> | null = null;

// Bracket phase group ID cache — each bracket event has one phase group.
const _bracketPgIdCache = new Map<number, number>();
async function getBracketPhaseGroupId(bracketEventId: number): Promise<number | null> {
	const cached = _bracketPgIdCache.get(bracketEventId);
	if (cached) return cached;
	const epData = await gql<{ event: { phases: { id: number }[] } }>(
		'query($eventId:ID!){event(id:$eventId){phases{id}}}', { eventId: bracketEventId }, { delay: 0 }
	).catch(() => null);
	const bPhaseId = epData?.event?.phases?.[0]?.id;
	if (!bPhaseId) return null;
	const { fetchPhaseGroups: fpg } = await import('$lib/server/startgg');
	const groups = await fpg(bPhaseId).catch(() => []);
	const pgId = (groups as { id?: number }[])[0]?.id;
	if (pgId) {
		_bracketPgIdCache.set(bracketEventId, pgId);
		return pgId;
	}
	return null;
}

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
	const trimmed = message.replace(/\.+\s*$/, ''); // strip trailing periods
	const actionable = `${trimmed}. Try "Sync from StartGG" to pull the latest state, or re-report matches that aren't showing as reported.`;
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
	console.log(`[cache] Caching preview set IDs for round ${roundNumber}, PG ${phaseGroupId}`);

	// Fetch preview set IDs via GQL. Keep retrying until sets exist (StartGG takes
	// time to generate after pushPairings for R2+). Preview IDs work for reporting.
	let nodes: GqlNode[] = [];
	for (let attempt = 0; attempt < 10; attempt++) {
		if (attempt > 0) await new Promise<void>((r) => setTimeout(r, attempt <= 3 ? 1500 : 3000));
		try {
			const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId }, { delay: 0 });
			nodes = (data?.phaseGroup?.sets?.nodes ?? []) as GqlNode[];
		} catch { /* retry */ }
		// Require sets WITH entrants populated (empty preview slots are useless)
		const hasEntrants = nodes.some((n) =>
			(n.slots ?? []).every((s) => s.entrant?.id)
		);
		if (hasEntrants) break;
	}
	console.log(`[cache] Got ${nodes.length} sets via GQL`);

	const fresh = await getActiveTournament();
	if (!fresh) return;

	const round = fresh.rounds.find((r) => r.number === roundNumber);
	if (round && nodes.length > 0) {
		const entrantMap = new Map(fresh.entrants.map((e) => [e.id, e]));
		applyNodesToRound(nodes, round, entrantMap);
	}

	const sync = ensureSync(fresh);
	sync.cacheReady = true;
	await saveTournament(fresh);
}

/**
 * After the first preview set is reported (triggering conversion), instantly
 * fetch all real set IDs via the admin REST endpoint and cache them.
 */
export async function cacheRealSetIds(
	tournament: TournamentState,
	roundNumber: number,
	phaseGroupId: number
): Promise<void> {
	console.log(`[cache] Fetching real IDs via admin REST for round ${roundNumber}...`);
	const adminSets = await fetchAdminPhaseGroupSets(phaseGroupId).catch(() => []);
	if (adminSets.length === 0) {
		console.log('[cache] Admin REST returned 0 sets');
		return;
	}
	console.log(`[cache] Got ${adminSets.length} real set IDs instantly`);

	const round = tournament.rounds.find((r) => r.number === roundNumber);
	if (!round) return;

	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
	for (const match of round.matches) {
		const top = entrantMap.get(match.topPlayerId);
		const bot = entrantMap.get(match.bottomPlayerId);
		if (!top?.startggEntrantId || !bot?.startggEntrantId) continue;
		const e1 = Number(top.startggEntrantId);
		const e2 = Number(bot.startggEntrantId);
		const adminSet = adminSets.find((s) =>
			(s.entrant1Id === e1 && s.entrant2Id === e2) ||
			(s.entrant1Id === e2 && s.entrant2Id === e1)
		);
		if (adminSet) match.startggSetId = String(adminSet.id);
	}
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
	// Real cached ID → use it directly (instant)
	if (cachedSetId && !cachedSetId.startsWith('preview_')) return cachedSetId;

	const groups = tournament.startggPhase1Groups;
	if (groups && groups[roundNumber - 1]) {
		const pgId = groups[roundNumber - 1].id;
		const e1 = Number(entrantId1), e2 = Number(entrantId2);

		// Try admin REST first — returns real IDs quickly once StartGG commits the
		// phase group. Retry briefly (budget ~6s to stay under Vercel 10s limit).
		for (let attempt = 0; attempt < 4; attempt++) {
			if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1500));
			const adminSets = await fetchAdminPhaseGroupSets(pgId).catch(() => []);
			if (adminSets.length > 0) {
				const m = adminSets.find((s) =>
					(s.entrant1Id === e1 && s.entrant2Id === e2) ||
					(s.entrant1Id === e2 && s.entrant2Id === e1)
				);
				if (m && !isNaN(m.id) && m.id > 0) return String(m.id);
				// Sets exist but this pair isn't there — stop retrying (would be same result)
				break;
			}
		}

		// Preview ID cached? Use it — reporting with preview triggers conversion.
		if (cachedSetId) return cachedSetId;

		// Last resort: GQL lookup
		return findSetInPhaseGroup(pgId, entrantId1, entrantId2).catch(() => null);
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
		const msg = `StartGG entrant IDs not found for ${topEntrant?.gamerTag ?? match.topPlayerId} vs ${botEntrant?.gamerTag ?? match.bottomPlayerId}`;
		addError(sync, match.id, msg);
		return { ok: false, error: msg };
	}

	const pgId = (tournament.startggPhase1Groups?.find(g => g.roundNumber === roundNumber)
		?? tournament.startggPhase1Groups?.[roundNumber - 1])?.id;
	if (!pgId) {
		const msg = `No phase group for round ${roundNumber}`;
		addError(sync, match.id, msg);
		return { ok: false, error: msg };
	}

	const e1Id = Number(topEntrant.startggEntrantId);
	const e2Id = Number(botEntrant.startggEntrantId);
	const winnerScore = match.winnerId === match.topPlayerId ? match.topScore : match.bottomScore;
	const loserScore  = match.winnerId === match.topPlayerId ? match.bottomScore : match.topScore;

	// Report via internal REST API (~500ms-4s per set with concurrency retry).
	// Handles preview→real conversion races and StartGG's per-phase-group write
	// serialization (500 errors) via jittered backoff internally.
	const result = await completeSetViaAdminRest(
		pgId,
		e1Id,
		e2Id,
		winnerEntrant.startggEntrantId,
		winnerScore ?? 2,
		loserScore ?? 0,
		match.isDQ ?? false
	);

	if (result.ok) {
		match.startggSetId = result.realSetId;
		clearErrorsForMatch(sync, match.id);
		return { ok: true };
	} else {
		addError(sync, match.id, result.error ?? 'Unknown StartGG error');
		return { ok: false, error: result.error };
	}
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

	// Translate stored entrant IDs → bracket entrant IDs.
	// Stored IDs may be Swiss or Main bracket IDs; the bracket event has its own IDs.
	if (!_bracketEntrantCache) _bracketEntrantCache = new Map();
	const cacheKey = `${_bracketName}-${bracketEventId}`;
	let translation = _bracketEntrantCache.get(cacheKey);

	if (!translation) {
		const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
		if (swissPgId) {
			translation = await buildBracketEntrantTranslation(swissPgId, bracketEventId);
		}
		if (!translation) translation = new Map();
		// Supplement with gamerTag matching for any players not covered by
		// the player-ID-based translation (handles partial moves, gauntlet mode, etc.)
		const bracketEntrants = await fetchAllEntrants(bracketEventId, undefined).catch(() => []);
		type BracketEnt = { id?: number; participants?: { player?: { gamerTag?: string } }[] };
		const tagToBracketEid = new Map<string, number>();
		for (const e of bracketEntrants as BracketEnt[]) {
			const tag = e.participants?.[0]?.player?.gamerTag;
			if (tag && e.id) tagToBracketEid.set(tag.toLowerCase(), Number(e.id));
		}
		let supplemented = 0;
		for (const [, ent] of entrantMap) {
			if (!ent.startggEntrantId) continue;
			if (translation.has(ent.startggEntrantId)) continue;
			const bracketEid = tagToBracketEid.get(ent.gamerTag.toLowerCase());
			if (bracketEid && bracketEid !== ent.startggEntrantId) {
				translation.set(ent.startggEntrantId, bracketEid);
				supplemented++;
			}
		}
		if (supplemented > 0) console.log(`[StartGG] Bracket entrant translation: ${supplemented} extra players mapped via gamerTag`);
		if (translation.size > 0) _bracketEntrantCache.set(cacheKey, translation);
	}

	let bracketTopEntrantId = translation.get(topEntrant.startggEntrantId) ?? topEntrant.startggEntrantId;
	let bracketBotEntrantId = translation.get(botEntrant.startggEntrantId) ?? botEntrant.startggEntrantId;
	let bracketWinnerEntrantId = translation.get(winnerEntrant.startggEntrantId) ?? winnerEntrant.startggEntrantId;

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

	const hasCharData = !match.isDQ && (gameCharacters.length > 0 || !!match.gameWinners?.length);

	// FAST PATH: for matches without per-game character data (early rounds),
	// use internal REST — same reliable fast path as Swiss reports.
	// Falls through to GQL path on failure (e.g. bracket not yet started → 404).
	if (!hasCharData) {
		const bracketPhaseGroupId = await getBracketPhaseGroupId(bracketEventId);
		if (bracketPhaseGroupId) {
			const result = await completeSetViaAdminRest(
				bracketPhaseGroupId,
				bracketTopEntrantId,
				bracketBotEntrantId,
				bracketWinnerEntrantId,
				winnerScore ?? 2,
				loserScore ?? 0,
				match.isDQ ?? false
			);
			if (result.ok) {
				match.startggSetId = result.realSetId;
				clearErrorsForMatch(sync, match.id);
				sync.pendingBracketMatchIds = sync.pendingBracketMatchIds.filter((id) => id !== pendingKey);
				return { ok: true };
			}
			console.log(`[StartGG] Fast path failed for bracket match: ${result.error} — falling through to GQL`);
		}
	}

	// GQL PATH: handles preview sets, character data, and fast-path fallback
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
		if (!sync.pendingBracketMatchIds.includes(pendingKey)) {
			sync.pendingBracketMatchIds.push(pendingKey);
		}
		return { ok: false, queued: true, error: msg };
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
		sync.pendingBracketMatchIds = sync.pendingBracketMatchIds.filter((id) => id !== pendingKey);

		// If we just reported a preview set, cache all real IDs via admin REST
		if (setId.startsWith('preview_') && bracketEventId) {
			try {
				const epData = await gql<{ event: { phases: { id: number }[] } }>(
					'query($eventId:ID!){event(id:$eventId){phases{id}}}', { eventId: bracketEventId }, { delay: 0 }
				);
				const bPhaseId = epData?.event?.phases?.[0]?.id;
				if (bPhaseId) {
					const { fetchPhaseGroups: fpg } = await import('$lib/server/startgg');
					const bGroups = await fpg(bPhaseId).catch(() => []);
					if (bGroups.length > 0) {
						const adminSets = await fetchAdminPhaseGroupSets(bGroups[0].id).catch(() => []);
						if (adminSets.length > 0 && tournament.brackets) {
							const bracket = tournament.brackets[_bracketName as 'main' | 'redemption'];
							if (bracket) {
								for (const bm of bracket.matches) {
									if (bm.startggSetId) continue;
									const bTopEid = _bracketEntrantCache?.get(`${_bracketName}-${bracketEventId}`)?.get(
										entrantMap.get(bm.topPlayerId ?? '')?.startggEntrantId ?? 0
									);
									const bBotEid = _bracketEntrantCache?.get(`${_bracketName}-${bracketEventId}`)?.get(
										entrantMap.get(bm.bottomPlayerId ?? '')?.startggEntrantId ?? 0
									);
									if (!bTopEid || !bBotEid) continue;
									const as = adminSets.find((s) =>
										(s.entrant1Id === bTopEid && s.entrant2Id === bBotEid) ||
										(s.entrant1Id === bBotEid && s.entrant2Id === bTopEid)
									);
									if (as) bm.startggSetId = String(as.id);
								}
								console.log(`[bracket] Cached real IDs for ${_bracketName} via admin REST`);
							}
						}
					}
				}
			} catch { /* best effort */ }
		}
	} else {
		if (!sync.pendingBracketMatchIds.includes(pendingKey)) {
			sync.pendingBracketMatchIds.push(pendingKey);
		}
		return { ok: false, queued: true, error: result.error ?? 'Unknown StartGG error' };
	}

	return result;
}

// ── Flush pending bracket matches ───────────────────────────────────────

/**
 * Flush all queued bracket match reports after split is confirmed.
 * Sets splitConfirmed=true, processes the queue.
 * Reloads from Redis to pick up matches reported concurrently during the sync.
 * Does NOT save — caller must merge and save to avoid overwriting concurrent changes.
 */
export async function flushPendingBracketMatches(
	tournament: TournamentState,
	log?: (msg: string) => void
): Promise<{ reported: number; failed: number; flushedIds: string[] }> {
	const sync = ensureSync(tournament);
	sync.splitConfirmed = true;
	const _log = log ?? ((msg: string) => console.log(`[flush] ${msg}`));

	// Clear stale entrant translation cache — bracket event entrant IDs may have
	// changed since the cache was built (e.g., players moved between events).
	_bracketEntrantCache = null;

	// Reload from Redis: the caller's `tournament` was loaded at the start of the
	// request and is stale. We need fresh match data (winnerId set by concurrent
	// reports) AND fresh tournament metadata (event IDs, entrants).
	const latest = await getActiveTournament();
	const pendingIds = [
		...new Set([
			...sync.pendingBracketMatchIds,
			...(latest?.startggSync?.pendingBracketMatchIds ?? [])
		])
	];

	if (!latest?.brackets || pendingIds.length === 0) {
		_log('No pending reports to flush');
		return { reported: 0, failed: 0, flushedIds: [] };
	}

	const entrantMap = new Map(latest.entrants.map((e) => [e.id, e]));
	_log(`Flushing ${pendingIds.length} pending report(s)...`);

	let reported = 0;
	let failed = 0;

	for (let i = 0; i < pendingIds.length; i++) {
		const key = pendingIds[i];
		const [bracketName, matchId] = key.split(':') as ['main' | 'redemption', string];
		const bracket = latest.brackets[bracketName];
		if (!bracket) { _log(`  [${i + 1}/${pendingIds.length}] ${key}: bracket not found — skipping`); continue; }

		const match = bracket.matches.find((m) => m.id === matchId);
		if (!match || !match.winnerId) {
			_log(`  [${i + 1}/${pendingIds.length}] ${key}: no winner set — skipping`);
			continue;
		}

		const topTag = entrantMap.get(match.topPlayerId ?? '')?.gamerTag ?? match.topPlayerId;
		const botTag = entrantMap.get(match.bottomPlayerId ?? '')?.gamerTag ?? match.bottomPlayerId;
		_log(`  [${i + 1}/${pendingIds.length}] Reporting ${topTag} vs ${botTag} (${bracketName})...`);

		try {
			const result = await _doReportBracketMatch(latest, bracketName, match, sync, key);
			if (result.ok && !result.queued) {
				reported++;
				_log(`  [${i + 1}/${pendingIds.length}] ✓ Reported`);
			} else {
				failed++;
				_log(`  [${i + 1}/${pendingIds.length}] ✗ ${result.error ?? 'Failed'}${result.queued ? ' (re-queued)' : ''}`);
			}
		} catch (e) {
			failed++;
			const msg = e instanceof Error ? e.message : String(e);
			_log(`  [${i + 1}/${pendingIds.length}] ✗ Unexpected error: ${msg}`);
			if (!sync.pendingBracketMatchIds.includes(key)) {
				sync.pendingBracketMatchIds.push(key);
			}
		}

		// Brief delay between reports to avoid hammering StartGG
		if (i < pendingIds.length - 1) await new Promise<void>((r) => setTimeout(r, 800));
	}

	_log(`Flush complete: ${reported} reported, ${failed} failed`);

	// Immediately persist updated pending IDs to Redis so they clear even if
	// the caller times out before its own merge/save. This is a targeted merge:
	// reload fresh state and only update pendingBracketMatchIds + splitConfirmed.
	if (reported > 0 || failed > 0) {
		const postFlush = await getActiveTournament();
		if (postFlush) {
			if (!postFlush.startggSync) {
				postFlush.startggSync = { splitConfirmed: true, pendingBracketMatchIds: [], errors: [] };
			} else {
				postFlush.startggSync.splitConfirmed = true;
				postFlush.startggSync.pendingBracketMatchIds =
					postFlush.startggSync.pendingBracketMatchIds.filter((id) => !pendingIds.includes(id) || sync.pendingBracketMatchIds.includes(id));
			}
			await saveTournament(postFlush);
			_log('Pending IDs persisted to Redis');
		}
	}

	return { reported, failed, flushedIds: pendingIds };
}
