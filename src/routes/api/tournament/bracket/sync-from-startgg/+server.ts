import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { fetchAllSets, fetchAllEntrants, gql, PHASE_GROUP_SEEDS_QUERY } from '$lib/server/startgg';
import { generateBracket, reportBracketMatch } from '$lib/server/swiss';
import type { BracketMatch } from '$lib/types/tournament';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GqlRecord = Record<string, any>;

/**
 * POST — Sync bracket state FROM StartGG.
 * Regenerates a fresh bracket, then applies all reported results from StartGG.
 * This brings MSV Hub in line with whatever state StartGG is in.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.finalStandings) return Response.json({ error: 'No final standings' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const bracketName = (body as { bracketName?: string }).bracketName as 'main' | 'redemption' | undefined;
	if (!bracketName) return Response.json({ error: 'bracketName required' }, { status: 400 });

	const eventId = bracketName === 'main'
		? tournament.startggMainBracketEventId
		: tournament.startggRedemptionBracketEventId;
	if (!eventId) return Response.json({ error: `No ${bracketName} bracket event linked` }, { status: 400 });

	const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
	if (!swissPgId) return Response.json({ error: 'No Swiss phase group' }, { status: 400 });

	// Step 1: Build player ID translation (bracket entrant ID → MSV Hub entrant ID)
	// Swiss seeds: Swiss entrant ID → player ID
	const swissSeedsData = await gql<{ phaseGroup: { seeds: { nodes: GqlRecord[] } } }>(
		PHASE_GROUP_SEEDS_QUERY, { phaseGroupId: swissPgId, page: 1, perPage: 64 }, { delay: 0 }
	).catch(() => null);
	const swissSeeds = swissSeedsData?.phaseGroup?.seeds?.nodes ?? [];
	const swissEntrantToPlayer = new Map<number, number>();
	for (const s of swissSeeds) {
		const eid = s.entrant?.id;
		const pid = s.entrant?.participants?.[0]?.player?.id;
		if (eid && pid) swissEntrantToPlayer.set(Number(eid), Number(pid));
	}

	// MSV Hub entrant: Swiss entrant ID → MSV Hub ID
	const swissToMsvHub = new Map<number, string>();
	for (const e of tournament.entrants) {
		if (e.startggEntrantId) swissToMsvHub.set(e.startggEntrantId, e.id);
	}

	// Player ID → MSV Hub ID (via Swiss entrant)
	const playerToMsvHub = new Map<number, string>();
	for (const [swissEid, playerId] of swissEntrantToPlayer) {
		const msvId = swissToMsvHub.get(swissEid);
		if (msvId) playerToMsvHub.set(playerId, msvId);
	}

	// Bracket entrants: bracket entrant ID → player ID
	const bracketEntrants = await fetchAllEntrants(eventId, undefined).catch(() => []);
	const bracketEntrantToMsvHub = new Map<number, string>();
	for (const e of bracketEntrants as GqlRecord[]) {
		const eid = e.id;
		const pid = e.participants?.[0]?.player?.id;
		if (eid && pid) {
			const msvId = playerToMsvHub.get(Number(pid));
			if (msvId) bracketEntrantToMsvHub.set(Number(eid), msvId);
		}
	}

	// Step 2: Fetch all sets from StartGG
	const sets = await fetchAllSets(eventId, undefined, 0);

	// Step 3: Regenerate a fresh bracket
	const standings = tournament.finalStandings;
	const players = bracketName === 'main'
		? standings.filter((s) => s.bracket === 'main').map((s) => ({ entrantId: s.entrantId, seed: s.rank }))
		: standings.filter((s) => s.bracket === 'redemption').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));

	if (!tournament.brackets) {
		return Response.json({ error: 'No brackets' }, { status: 400 });
	}

	let bracket = generateBracket(bracketName, players, standings);

	type Slot = { entrant?: { id?: number } };
	function identifierToMatchIndex(id: string): number {
		if (!id) return -1;
		let n = 0;
		for (let i = 0; i < id.length; i++) n = n * 26 + (id.charCodeAt(i) - 64);
		return n - 1;
	}

	/** Classify set by its bracket side based on StartGG's 'round' field (positive=W, negative=L). */
	function bucketOf(set: GqlRecord): 'W' | 'L' | 'GF' | 'GFR' | null {
		const text = String(set.fullRoundText ?? '');
		if (text === 'Grand Final Reset') return 'GFR';
		if (text === 'Grand Final') return 'GF';
		const round = Number(set.round);
		if (round > 0) return 'W';
		if (round < 0) return 'L';
		return null;
	}

	const reportedSets = (sets as GqlRecord[]).filter((s) => s.winnerId);
	const debug: string[] = [];
	debug.push(`Reported sets on StartGG: ${reportedSets.length}, bracket matches: ${bracket.matches.length}`);

	// Group sets by bracket side and round, sorted in apply order
	const wSetsByRound = new Map<number, GqlRecord[]>();
	const lSetsByRound = new Map<number, GqlRecord[]>();
	let gfSet: GqlRecord | null = null;
	let gfrSet: GqlRecord | null = null;
	for (const s of reportedSets) {
		const b = bucketOf(s);
		const r = Math.abs(Number(s.round ?? 0));
		if (b === 'W') { if (!wSetsByRound.has(r)) wSetsByRound.set(r, []); wSetsByRound.get(r)!.push(s); }
		else if (b === 'L') { if (!lSetsByRound.has(r)) lSetsByRound.set(r, []); lSetsByRound.get(r)!.push(s); }
		else if (b === 'GF') gfSet = s;
		else if (b === 'GFR') gfrSet = s;
	}

	let synced = 0;
	const applied = new Set<string>();

	function parseScores(set: GqlRecord, msvE1: string, msvE2: string, match: BracketMatch): { topScore?: number; bottomScore?: number } {
		const ds = set.displayScore as string | undefined;
		if (!ds) return {};
		const parts = ds.split(' - ');
		if (parts.length !== 2) return {};
		const s1 = Number(parts[0].replace(/[^0-9]/g, ''));
		const s2 = Number(parts[1].replace(/[^0-9]/g, ''));
		if (isNaN(s1) || isNaN(s2)) return {};
		if (msvE1 === match.topPlayerId) return { topScore: s1, bottomScore: s2 };
		return { topScore: s2, bottomScore: s1 };
	}

	/**
	 * Apply sets scoped to a single bracket side (W or L) and round.
	 * 1. Override player assignments on round-N matches from StartGG's set identifiers
	 * 2. Apply winners via reportBracketMatch (which advances players to round N+1)
	 */
	function applyRound(side: 'W' | 'L', round: number, setsInRound: GqlRecord[]) {
		// Which match ID prefix identifies this side in the generated bracket?
		const idPrefix = side === 'W' ? `${bracketName}-W${round}-` : `${bracketName}-L${round}-`;
		const roundMatches = bracket.matches.filter((m: BracketMatch) => m.id.startsWith(idPrefix));

		// Step 1: Override pairings from StartGG for this round
		for (const s of setsInRound) {
			const idx = identifierToMatchIndex(s.identifier as string);
			// StartGG assigns identifiers globally across WB & LB → find the idx within this round
			// by matching to an MSV match at that matchIndex on THIS side.
			const slots = (s.slots ?? []) as Slot[];
			const sgE1 = Number(slots[0]?.entrant?.id);
			const sgE2 = Number(slots[1]?.entrant?.id);
			const msvE1 = bracketEntrantToMsvHub.get(sgE1);
			const msvE2 = bracketEntrantToMsvHub.get(sgE2);
			if (!msvE1 || !msvE2) continue;
			// Prefer matching by identifier-derived index, but fall back to finding a match
			// with both players on this side (whose players already correctly advanced).
			let msvMatch = roundMatches.find((m) => m.matchIndex === idx);
			if (!msvMatch || (msvMatch.topPlayerId && msvMatch.topPlayerId !== msvE1 && msvMatch.topPlayerId !== msvE2)) {
				msvMatch = roundMatches.find((m) =>
					(m.topPlayerId === msvE1 && m.bottomPlayerId === msvE2) ||
					(m.topPlayerId === msvE2 && m.bottomPlayerId === msvE1)
				) ?? msvMatch;
			}
			if (!msvMatch) continue;
			msvMatch.topPlayerId = msvE1;
			msvMatch.bottomPlayerId = msvE2;
			msvMatch.winnerId = undefined; // clear any stale winner before reporting
		}

		// Step 2: Apply winners
		for (const s of setsInRound) {
			if (applied.has(String(s.id))) continue;
			const slots = (s.slots ?? []) as Slot[];
			const sgE1 = Number(slots[0]?.entrant?.id);
			const sgE2 = Number(slots[1]?.entrant?.id);
			const msvE1 = bracketEntrantToMsvHub.get(sgE1);
			const msvE2 = bracketEntrantToMsvHub.get(sgE2);
			const msvWinner = bracketEntrantToMsvHub.get(Number(s.winnerId));
			if (!msvE1 || !msvE2 || !msvWinner) {
				debug.push(`  ${s.fullRoundText} set ${s.id}: couldn't map entrants ${sgE1}/${sgE2}/${s.winnerId}`);
				continue;
			}
			const match = bracket.matches.find((m: BracketMatch) =>
				m.id.startsWith(idPrefix) &&
				((m.topPlayerId === msvE1 && m.bottomPlayerId === msvE2) ||
				 (m.topPlayerId === msvE2 && m.bottomPlayerId === msvE1))
			);
			if (!match) {
				debug.push(`  ${s.fullRoundText} set ${s.id} (${sgE1} vs ${sgE2}): no ${idPrefix} match in MSV`);
				continue;
			}
			const { topScore, bottomScore } = parseScores(s, msvE1, msvE2, match);
			try {
				bracket = reportBracketMatch(bracket, match.id, msvWinner, undefined, undefined, topScore, bottomScore);
				const updated = bracket.matches.find((m: BracketMatch) => m.id === match.id);
				if (updated) updated.startggSetId = String(s.id);
				applied.add(String(s.id));
				synced++;
			} catch (e) {
				debug.push(`  ${s.fullRoundText} set ${s.id}: reportBracketMatch threw: ${String(e).slice(0, 120)}`);
			}
		}
	}

	// Winners bracket first, round by round
	const wRounds = [...wSetsByRound.keys()].sort((a, b) => a - b);
	for (const r of wRounds) applyRound('W', r, wSetsByRound.get(r)!);

	// Losers bracket second, round by round
	const lRounds = [...lSetsByRound.keys()].sort((a, b) => a - b);
	for (const r of lRounds) applyRound('L', r, lSetsByRound.get(r)!);

	// Grand Final
	function applyGF(s: GqlRecord, idContains: string, idNotContains?: string) {
		const slots = (s.slots ?? []) as Slot[];
		const sgE1 = Number(slots[0]?.entrant?.id);
		const sgE2 = Number(slots[1]?.entrant?.id);
		const msvE1 = bracketEntrantToMsvHub.get(sgE1);
		const msvE2 = bracketEntrantToMsvHub.get(sgE2);
		const msvWinner = bracketEntrantToMsvHub.get(Number(s.winnerId));
		if (!msvE1 || !msvE2 || !msvWinner) return;
		const match = bracket.matches.find((m: BracketMatch) =>
			m.id.includes(idContains) && (!idNotContains || !m.id.includes(idNotContains))
		);
		if (!match) { debug.push(`  ${s.fullRoundText} set ${s.id}: no ${idContains} match in MSV`); return; }
		match.topPlayerId = msvE1;
		match.bottomPlayerId = msvE2;
		match.winnerId = undefined;
		const { topScore, bottomScore } = parseScores(s, msvE1, msvE2, match);
		try {
			bracket = reportBracketMatch(bracket, match.id, msvWinner, undefined, undefined, topScore, bottomScore);
			const updated = bracket.matches.find((m: BracketMatch) => m.id === match.id);
			if (updated) updated.startggSetId = String(s.id);
			applied.add(String(s.id));
			synced++;
		} catch (e) {
			debug.push(`  ${s.fullRoundText} set ${s.id}: reportBracketMatch threw: ${String(e).slice(0, 120)}`);
		}
	}
	if (gfSet) applyGF(gfSet, '-GF-', '-GFR-');
	if (gfrSet) applyGF(gfrSet, '-GFR-');

	const notFound = reportedSets.length - synced;

	// Log unmatched
	if (notFound > 0 && notFound < 30) {
		for (const set of reportedSets) {
			if (applied.has(String(set.id))) continue;
			const slots = set.slots ?? [];
			const sgE1 = Number(slots[0]?.entrant?.id);
			const sgE2 = Number(slots[1]?.entrant?.id);
			debug.push(`  Unmatched: "${set.fullRoundText}" set ${set.id} (entrants ${sgE1} vs ${sgE2})`);
		}
	}

	tournament.brackets[bracketName] = bracket;

	// Clear errors for this bracket
	if (tournament.startggSync) {
		tournament.startggSync.errors = tournament.startggSync.errors.filter(
			(e) => !bracket.matches.some((m: BracketMatch) => m.id === e.matchId)
		);
	}

	await saveTournament(tournament);
	return Response.json({ ok: true, bracketName, synced, notFound, totalSetsOnStartGG: reportedSets.length, debug });
};
