import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { fetchAllSets, fetchAllEntrants, gql, PHASE_GROUP_SEEDS_QUERY } from '$lib/server/startgg';
import { generateBracket, reportBracketMatch, assignBracketStations, placeInNextMatch, autoAdvanceByes } from '$lib/server/swiss';
import type { BracketMatch, FinalStanding } from '$lib/types/tournament';

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

	const isGauntlet = tournament.mode === 'gauntlet';
	const allPlayersToMain = tournament.mode === 'gauntlet' || tournament.mode === 'experimental1';
	if (!allPlayersToMain && !tournament.finalStandings) return Response.json({ error: 'No final standings' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const bracketName = (body as { bracketName?: string }).bracketName as 'main' | 'redemption' | undefined;
	if (!bracketName) return Response.json({ error: 'bracketName required' }, { status: 400 });

	const eventId = bracketName === 'main'
		? tournament.startggMainBracketEventId
		: tournament.startggRedemptionBracketEventId;
	if (!eventId) return Response.json({ error: `No ${bracketName} bracket event linked` }, { status: 400 });

	// Build bracket entrant ID → MSV Hub entrant ID translation.
	// For gauntlet, stored IDs may already be bracket IDs, so match by gamerTag.
	// For default, map via Swiss PG → player ID → bracket entrant ID.
	const bracketEntrantToMsvHub = new Map<number, string>();
	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));

	if (allPlayersToMain) {
		// All-to-main modes: match bracket entrants to MSV Hub entrants by gamerTag
		const bracketEntrants = await fetchAllEntrants(eventId, undefined).catch(() => []);
		const tagToMsvId = new Map<string, string>();
		for (const e of tournament.entrants) {
			tagToMsvId.set(e.gamerTag.toLowerCase(), e.id);
		}
		for (const e of bracketEntrants as GqlRecord[]) {
			const eid = e.id;
			const tag = e.participants?.[0]?.player?.gamerTag;
			if (eid && tag) {
				const msvId = tagToMsvId.get(String(tag).toLowerCase());
				if (msvId) bracketEntrantToMsvHub.set(Number(eid), msvId);
			}
		}
	} else {
		const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
		if (!swissPgId) return Response.json({ error: 'No Swiss phase group' }, { status: 400 });

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

		// Bracket entrants: bracket entrant ID → player ID → MSV Hub ID
		const bracketEntrants = await fetchAllEntrants(eventId, undefined).catch(() => []);
		for (const e of bracketEntrants as GqlRecord[]) {
			const eid = e.id;
			const pid = e.participants?.[0]?.player?.id;
			if (eid && pid) {
				const msvId = playerToMsvHub.get(Number(pid));
				if (msvId) bracketEntrantToMsvHub.set(Number(eid), msvId);
			}
		}

		// Fallback: if Swiss PG was empty (stale IDs), try gamerTag matching
		if (bracketEntrantToMsvHub.size === 0) {
			const tagToMsvId = new Map<string, string>();
			for (const e of tournament.entrants) tagToMsvId.set(e.gamerTag.toLowerCase(), e.id);
			for (const e of bracketEntrants as GqlRecord[]) {
				const eid = e.id;
				const tag = e.participants?.[0]?.player?.gamerTag;
				if (eid && tag) {
					const msvId = tagToMsvId.get(String(tag).toLowerCase());
					if (msvId) bracketEntrantToMsvHub.set(Number(eid), msvId);
				}
			}
		}
	}

	// Step 2: Fetch all sets from StartGG
	const sets = await fetchAllSets(eventId, undefined, 0);

	// Step 3: Regenerate a fresh bracket
	let players: { entrantId: string; seed: number }[];
	let standings: FinalStanding[];

	if (allPlayersToMain) {
		const existingBracket = tournament.brackets?.[bracketName];
		if (!existingBracket) return Response.json({ error: `No ${bracketName} bracket in tournament` }, { status: 400 });
		players = existingBracket.players.map((p) => ({ entrantId: p.entrantId, seed: p.seed }));
		standings = players.map((p) => {
			const ent = entrantMap.get(p.entrantId);
			return {
				rank: p.seed, entrantId: p.entrantId, gamerTag: ent?.gamerTag ?? '',
				wins: 0, losses: 0, initialSeed: ent?.initialSeed ?? p.seed, totalScore: 0,
				basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
				expectedWins: 0, winsAboveExpected: 0, bracket: bracketName as 'main' | 'redemption'
			};
		});
	} else {
		standings = tournament.finalStandings!;
		players = bracketName === 'main'
			? standings.filter((s) => s.bracket === 'main').map((s) => ({ entrantId: s.entrantId, seed: s.rank }))
			: standings.filter((s) => s.bracket === 'redemption').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));
	}

	if (!tournament.brackets) {
		return Response.json({ error: 'No brackets' }, { status: 400 });
	}

	let bracket = generateBracket(bracketName, players, standings);
	type Slot = { entrant?: { id?: number } };

	const debug: string[] = [];
	debug.push(`Reported sets on StartGG: ${(sets as GqlRecord[]).filter((s) => s.winnerId).length}, bracket matches: ${bracket.matches.length}`);

	// Classify each StartGG set by its bracket side + round.
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

	const wRounds = new Set<number>();
	const lRounds = new Set<number>();
	for (const s of sets as GqlRecord[]) {
		const b = bucketOf(s);
		const r = Number(s.round);
		if (b === 'W') wRounds.add(r);
		else if (b === 'L') lRounds.add(Math.abs(r));
	}
	const wRoundMap = new Map<number, number>();
	[...wRounds].sort((a, b) => a - b).forEach((r, i) => wRoundMap.set(r, i + 1));
	const lRoundMap = new Map<number, number>();
	[...lRounds].sort((a, b) => a - b).forEach((r, i) => lRoundMap.set(r, i + 1));

	const setsByKey = new Map<string, GqlRecord[]>();
	for (const s of sets as GqlRecord[]) {
		const b = bucketOf(s);
		if (!b) continue;
		let key: string;
		if (b === 'GF' || b === 'GFR') key = b;
		else if (b === 'W') {
			const msvRound = wRoundMap.get(Number(s.round));
			if (!msvRound) continue;
			key = `W${msvRound}`;
		} else {
			const msvRound = lRoundMap.get(Math.abs(Number(s.round)));
			if (!msvRound) continue;
			key = `L${msvRound}`;
		}
		if (!setsByKey.has(key)) setsByKey.set(key, []);
		setsByKey.get(key)!.push(s);
	}

	if (setsByKey.has('GFR') && !bracket.matches.some((m) => m.id.includes('-GFR-'))) {
		const gfMatch = bracket.matches.find((m) => m.id.includes('-GF-') && !m.id.includes('-GFR-'));
		if (gfMatch) {
			bracket.matches.push({
				id: `${bracketName}-GFR-0`,
				round: gfMatch.round + 1,
				matchIndex: 0
			});
		}
	}

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

	// Process rounds in dependency order so losers propagate before
	// downstream rounds are synced. This lets bye detection work correctly
	// in losers rounds (e.g., L1 bye from W1 bye).
	function propagateAndAdvance() {
		for (const m of bracket.matches) {
			if (!m.winnerId || !m.loserNextMatchId || m.loserId) continue;
			const loserId = m.topPlayerId === m.winnerId ? m.bottomPlayerId : m.topPlayerId;
			if (!loserId) continue;
			const next = bracket.matches.find((n) => n.id === m.loserNextMatchId);
			if (next) {
				placeInNextMatch(next, loserId, m.loserNextSlot ?? 'bottom');
				m.loserId = loserId;
			}
		}
		autoAdvanceByes(bracket.matches);
	}

	const wKeys = [...setsByKey.keys()].filter((k) => k.startsWith('W')).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
	const lKeys = [...setsByKey.keys()].filter((k) => k.startsWith('L')).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
	const gfKeys = [...setsByKey.keys()].filter((k) => k === 'GF' || k === 'GFR');
	const roundOrder = [...wKeys, ...lKeys, ...gfKeys];

	for (const key of roundOrder) {
		// Propagate before each round so bye structure is up to date
		propagateAndAdvance();

		const setsInGroup = setsByKey.get(key)!;
		const allMsvMatches = msvMatchesFor(key).sort((a, b) => a.matchIndex - b.matchIndex);
		// Filter out bye matches (auto-advanced with one empty slot) so positional
		// mapping stays aligned with StartGG sets.
		const msvMatches = allMsvMatches.filter(
			(m) => !(m.winnerId && (!m.topPlayerId || !m.bottomPlayerId))
		);
		// Filter out StartGG bye sets (one slot has no entrant) so they don't
		// shift the positional mapping against MSV non-bye matches.
		const sortedSets = [...setsInGroup]
			.filter((s) => {
				const slots = (s.slots ?? []) as Slot[];
				return slots.length >= 2 && slots[0]?.entrant?.id && slots[1]?.entrant?.id;
			})
			.sort((a, b) => {
				const ai = String(a.identifier ?? '');
				const bi = String(b.identifier ?? '');
				if (ai.length !== bi.length) return ai.length - bi.length;
				return ai.localeCompare(bi);
			});

		const msvByeCount = allMsvMatches.length - msvMatches.length;
		const sgByeCount = setsInGroup.length - sortedSets.length;
		debug.push(`${key}: StartGG sets=${sortedSets.length}${sgByeCount ? ` (${sgByeCount} bye sets skipped)` : ''}, MSV matches=${msvMatches.length}${msvByeCount ? ` (${msvByeCount} byes skipped)` : ''}`);
		if (sortedSets.length !== msvMatches.length) {
			debug.push(`  ${key}: SIZE MISMATCH`);
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

			if (sgWinnerId && !msvWinner) {
				debug.push(`  ${key}[${i}] ${s.identifier}: winnerId ${sgWinnerId} not in bracketEntrantToMsvHub (${bracketEntrantToMsvHub.size} entries)`);
			}
			if (sgWinnerId && msvWinner && msvWinner !== msvE1 && msvWinner !== msvE2) {
				debug.push(`  ${key}[${i}] ${s.identifier}: winner ${msvWinner} not in slots (${msvE1}, ${msvE2})`);
			}

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

	// Final propagation after all rounds are synced
	propagateAndAdvance();

	const totalReported = (sets as GqlRecord[]).filter((s) => s.winnerId).length;
	const notFound = totalReported - synced;

	const otherBracket = tournament.brackets[bracketName === 'main' ? 'redemption' : 'main'];
	const otherHasStream = otherBracket?.matches.some((m) => m.isStream && !m.winnerId) ?? false;
	tournament.brackets[bracketName] = assignBracketStations(bracket, tournament.settings, bracketName, otherHasStream);

	if (tournament.startggSync) {
		tournament.startggSync.errors = tournament.startggSync.errors.filter(
			(e) => !bracket.matches.some((m: BracketMatch) => m.id === e.matchId)
		);
		const prefix = `${bracketName}:`;
		tournament.startggSync.pendingBracketMatchIds = tournament.startggSync.pendingBracketMatchIds.filter(
			(id) => !id.startsWith(prefix)
		);
	}

	await saveTournament(tournament);
	return Response.json({ ok: true, bracketName, synced, notFound, totalSetsOnStartGG: totalReported, debug });
};
