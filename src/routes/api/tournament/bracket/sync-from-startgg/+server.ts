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

	const debug: string[] = [];
	debug.push(`Reported sets on StartGG: ${(sets as GqlRecord[]).filter((s) => s.winnerId).length}, bracket matches: ${bracket.matches.length}`);

	// Classify each StartGG set by its bracket side + round.
	// StartGG: round>0 = winners, round<0 = losers. fullRoundText for GF/GFR.
	type Bucket = 'W' | 'L' | 'GF' | 'GFR';
	function bucketOf(s: GqlRecord): Bucket | null {
		const text = String(s.fullRoundText ?? '');
		if (text === 'Grand Final Reset') return 'GFR';
		if (text === 'Grand Final') return 'GF';
		const r = Number(s.round);
		if (r > 0) return 'W';
		if (r < 0) return 'L';
		return null;
	}

	// Group all sets (reported or not) by bucket+round so we can map StartGG structure → MSV matches
	const setsByKey = new Map<string, GqlRecord[]>();
	for (const s of sets as GqlRecord[]) {
		const b = bucketOf(s);
		if (!b) continue;
		const key = (b === 'GF' || b === 'GFR') ? b : `${b}${Math.abs(Number(s.round))}`;
		if (!setsByKey.has(key)) setsByKey.set(key, []);
		setsByKey.get(key)!.push(s);
	}

	// Helper: MSV match ID prefix for a bucket/round
	function msvMatchesFor(key: string): BracketMatch[] {
		if (key === 'GF') return bracket.matches.filter((m) => m.id.includes('-GF-') && !m.id.includes('-GFR-'));
		if (key === 'GFR') return bracket.matches.filter((m) => m.id.includes('-GFR-'));
		const side = key[0] as 'W' | 'L';
		const round = Number(key.slice(1));
		const prefix = `${bracketName}-${side}${round}-`;
		return bracket.matches.filter((m) => m.id.startsWith(prefix));
	}

	function parseScores(s: GqlRecord, msvE1Id: string, topId: string | undefined): { topScore?: number; bottomScore?: number } {
		const ds = s.displayScore as string | undefined;
		if (!ds) return {};
		const parts = ds.split(' - ');
		if (parts.length !== 2) return {};
		const s1 = Number(parts[0].replace(/[^0-9]/g, ''));
		const s2 = Number(parts[1].replace(/[^0-9]/g, ''));
		if (isNaN(s1) || isNaN(s2)) return {};
		if (msvE1Id === topId) return { topScore: s1, bottomScore: s2 };
		return { topScore: s2, bottomScore: s1 };
	}

	let synced = 0;
	let unmatched = 0;

	// For each group, sort StartGG sets by identifier, sort MSV matches by matchIndex,
	// and align 1:1. Directly set player/winner/score data on each MSV match.
	for (const [key, setsInGroup] of setsByKey) {
		const msvMatches = msvMatchesFor(key).sort((a, b) => a.matchIndex - b.matchIndex);
		// Sort StartGG sets by identifier (A, B, ... AA, AB, ...) — lexicographic works for these
		const sortedSets = [...setsInGroup].sort((a, b) => {
			const ai = String(a.identifier ?? '');
			const bi = String(b.identifier ?? '');
			if (ai.length !== bi.length) return ai.length - bi.length;
			return ai.localeCompare(bi);
		});

		if (sortedSets.length !== msvMatches.length) {
			debug.push(`  ${key}: StartGG has ${sortedSets.length} sets, MSV has ${msvMatches.length} matches — size mismatch`);
		}

		const n = Math.min(sortedSets.length, msvMatches.length);
		for (let i = 0; i < n; i++) {
			const s = sortedSets[i];
			const m = msvMatches[i];
			const slots = (s.slots ?? []) as Slot[];
			const sgE1 = Number(slots[0]?.entrant?.id);
			const sgE2 = Number(slots[1]?.entrant?.id);
			const msvE1 = sgE1 ? bracketEntrantToMsvHub.get(sgE1) : undefined;
			const msvE2 = sgE2 ? bracketEntrantToMsvHub.get(sgE2) : undefined;
			const sgWinnerId = Number(s.winnerId);
			const msvWinner = sgWinnerId ? bracketEntrantToMsvHub.get(sgWinnerId) : undefined;

			// Assign players (StartGG is source of truth). Missing slots → leave undefined.
			m.topPlayerId = msvE1;
			m.bottomPlayerId = msvE2;
			m.startggSetId = String(s.id);

			if (msvWinner && (msvWinner === msvE1 || msvWinner === msvE2)) {
				m.winnerId = msvWinner;
				const { topScore, bottomScore } = parseScores(s, msvE1!, m.topPlayerId);
				m.topScore = topScore;
				m.bottomScore = bottomScore;
				synced++;
			} else {
				m.winnerId = undefined;
				m.topScore = undefined;
				m.bottomScore = undefined;
				if (sgWinnerId) {
					debug.push(`  ${key} set ${s.id}: couldn't map winner ${sgWinnerId}`);
					unmatched++;
				}
			}
		}
	}

	const totalReported = (sets as GqlRecord[]).filter((s) => s.winnerId).length;
	const notFound = totalReported - synced;

	tournament.brackets[bracketName] = bracket;

	// Clear errors for this bracket
	if (tournament.startggSync) {
		tournament.startggSync.errors = tournament.startggSync.errors.filter(
			(e) => !bracket.matches.some((m: BracketMatch) => m.id === e.matchId)
		);
	}

	await saveTournament(tournament);
	return Response.json({ ok: true, bracketName, synced, notFound, totalSetsOnStartGG: totalReported, debug });
};
