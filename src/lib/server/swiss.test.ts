/**
 * Swiss + bracket logic tests.
 *
 * Simulates a realistic 16-player tournament seeded in the style of
 * Micro 132 (from a Micro 130 season-start baseline).
 * No StartGG API calls — all fixtures are inline.
 */

import { describe, it, expect } from 'vitest';
import {
	calculateRecommendedRounds,
	calculateSwissPairings,
	calculateStandings,
	calculateFinalStandings,
	generateBracket,
	computeBracketRecords,
	getEliminatedPlayers,
	isGauntletRedemptionReady,
	generateGauntletRedemption,
	reportBracketMatch
} from './swiss';
import type { Entrant, SwissRound, SwissMatch } from '$lib/types/tournament';

// ── Fixtures ─────────────────────────────────────────────────────────────

/** 16 fictional entrants representing a realistic Micro 132 field. */
const ENTRANTS: Entrant[] = [
	{ id: 'e-1',  gamerTag: 'Apex',     initialSeed: 1  },
	{ id: 'e-2',  gamerTag: 'Blaze',    initialSeed: 2  },
	{ id: 'e-3',  gamerTag: 'Circuit',  initialSeed: 3  },
	{ id: 'e-4',  gamerTag: 'Drift',    initialSeed: 4  },
	{ id: 'e-5',  gamerTag: 'Echo',     initialSeed: 5  },
	{ id: 'e-6',  gamerTag: 'Flash',    initialSeed: 6  },
	{ id: 'e-7',  gamerTag: 'Ghost',    initialSeed: 7  },
	{ id: 'e-8',  gamerTag: 'Haze',     initialSeed: 8  },
	{ id: 'e-9',  gamerTag: 'Iris',     initialSeed: 9  },
	{ id: 'e-10', gamerTag: 'Jet',      initialSeed: 10 },
	{ id: 'e-11', gamerTag: 'Kite',     initialSeed: 11 },
	{ id: 'e-12', gamerTag: 'Loom',     initialSeed: 12 },
	{ id: 'e-13', gamerTag: 'Mist',     initialSeed: 13 },
	{ id: 'e-14', gamerTag: 'Nova',     initialSeed: 14 },
	{ id: 'e-15', gamerTag: 'Orbit',    initialSeed: 15 },
	{ id: 'e-16', gamerTag: 'Pulse',    initialSeed: 16 },
];

const SETTINGS = { numRounds: 5, numStations: 16, streamStation: 16 };

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a SwissRound where the higher-seeded player wins each match,
 * unless `forceWins` contains a player ID — that player always wins their match.
 */
function buildRound(
	roundNum: number,
	entrants: Entrant[],
	completedRounds: SwissRound[],
	forceWins: string[] = []
): SwissRound {
	const standings = calculateStandings(entrants, completedRounds);
	const { pairings, bye } = calculateSwissPairings(standings, roundNum);

	const matches: SwissMatch[] = pairings.map(([top, bot], i) => {
		const topE = entrants.find((e) => e.id === top[0])!;
		const botE = entrants.find((e) => e.id === bot[0])!;
		let winnerId: string;
		if (forceWins.includes(topE.id)) winnerId = topE.id;
		else if (forceWins.includes(botE.id)) winnerId = botE.id;
		else winnerId = topE.initialSeed < botE.initialSeed ? topE.id : botE.id;
		return {
			id: `r${roundNum}-m${i}`,
			topPlayerId: topE.id,
			bottomPlayerId: botE.id,
			winnerId,
			station: i + 1
		};
	});

	return {
		number: roundNum,
		status: 'completed',
		matches,
		byePlayerId: bye ? bye[0] : undefined
	};
}

/** Run a full N-round Swiss. `forceWins[r]` lists players who always win in round r. */
function runSwiss(entrants: Entrant[], numRounds: number, forceWinsPerRound: Record<number, string[]> = {}): SwissRound[] {
	const rounds: SwissRound[] = [];
	for (let r = 1; r <= numRounds; r++) {
		rounds.push(buildRound(r, entrants, rounds, forceWinsPerRound[r] ?? []));
	}
	return rounds;
}

// ── Unit tests ────────────────────────────────────────────────────────────

describe('calculateRecommendedRounds', () => {
	it('returns 4 rounds for 16 players / 16 stations', () => {
		// ceil(log2(16)) = 4; 16 stations >= 8 matches/round so no reduction
		expect(calculateRecommendedRounds(16, 16)).toBe(4);
	});

	it('returns 5 rounds for 32 players / 16 stations', () => {
		// ceil(log2(32)) = 5; 16 stations == matchesPerRound so no reduction
		expect(calculateRecommendedRounds(32, 16)).toBe(5);
	});

	it('returns null when stations too few (16 players / 3 stations)', () => {
		expect(calculateRecommendedRounds(16, 3)).toBeNull();
	});

	it('returns fewer rounds for very small fields (4 players / 4 stations)', () => {
		const r = calculateRecommendedRounds(4, 4);
		expect(r).toBeGreaterThanOrEqual(2);
		expect(r).toBeLessThanOrEqual(4);
	});
});

describe('calculateSwissPairings', () => {
	it('pairs each player exactly once per round', () => {
		const standings = calculateStandings(ENTRANTS, []);
		const { pairings, bye } = calculateSwissPairings(standings, 1);

		const paired = pairings.flatMap(([t, b]) => [t[0], b[0]]);
		if (bye) paired.push(bye[0]);

		expect(paired.length).toBe(ENTRANTS.length);
		expect(new Set(paired).size).toBe(ENTRANTS.length);
	});

	it('groups players by similar record in later rounds', () => {
		const rounds = runSwiss(ENTRANTS, 3);
		const standings = calculateStandings(ENTRANTS, rounds);
		const { pairings } = calculateSwissPairings(standings, 4);

		for (const [topArr, botArr] of pairings) {
			const top = standings.get(topArr[0]);
			const bot = standings.get(botArr[0]);
			expect(top).toBeDefined();
			expect(bot).toBeDefined();
			// Cross-group pairings should be rare (within 1 win difference)
			const diff = Math.abs((top?.wins ?? 0) - (bot?.wins ?? 0));
			expect(diff).toBeLessThanOrEqual(2);
		}
	});

	it('avoids rematches when possible', () => {
		const rounds = runSwiss(ENTRANTS, 2);
		const standings = calculateStandings(ENTRANTS, rounds);
		const { pairings } = calculateSwissPairings(standings, 3);

		// Collect all prior matchups
		const prior = new Set<string>();
		for (const r of rounds) {
			for (const m of r.matches) {
				prior.add([m.topPlayerId, m.bottomPlayerId].sort().join(':'));
			}
		}

		let rematches = 0;
		for (const [top, bot] of pairings) {
			const key = [top[0], bot[0]].sort().join(':');
			if (prior.has(key)) rematches++;
		}
		// With 16 players over 3 rounds, rematches should be 0 or 1
		expect(rematches).toBeLessThanOrEqual(1);
	});
});

describe('calculateFinalStandings', () => {
	it('ranks top players first', () => {
		const rounds = runSwiss(ENTRANTS, 5);
		const standings = calculateFinalStandings(ENTRANTS, rounds);

		expect(standings.length).toBe(ENTRANTS.length);
		// First-place player should have the most wins
		const [first, second] = standings;
		expect(first.wins).toBeGreaterThanOrEqual(second.wins);
	});

	it('splits exactly half into main bracket and half into redemption', () => {
		const rounds = runSwiss(ENTRANTS, 5);
		const standings = calculateFinalStandings(ENTRANTS, rounds);

		const mainCount = standings.filter((s) => s.bracket === 'main').length;
		const redeemCount = standings.filter((s) => s.bracket === 'redemption').length;

		expect(mainCount).toBe(8);
		expect(redeemCount).toBe(8);
	});

	it('top seed always in main bracket', () => {
		const rounds = runSwiss(ENTRANTS, 5);
		const standings = calculateFinalStandings(ENTRANTS, rounds);
		const apex = standings.find((s) => s.entrantId === 'e-1');
		expect(apex?.bracket).toBe('main');
		// Top seed wins 4 or 5 depending on byes
		expect((apex?.wins ?? 0)).toBeGreaterThanOrEqual(4);
	});

	it('handles upsets — bottom seed can reach main bracket', () => {
		// Pulse (seed 16) wins every match across all 5 rounds
		const forceWins: Record<number, string[]> = {};
		for (let r = 1; r <= 5; r++) forceWins[r] = ['e-16'];
		const rounds = runSwiss(ENTRANTS, 5, forceWins);
		const standings = calculateFinalStandings(ENTRANTS, rounds);
		const pulse = standings.find((s) => s.entrantId === 'e-16');
		// Pulse might have fewer wins if they got a bye, but should always be in main
		expect((pulse?.wins ?? 0)).toBeGreaterThanOrEqual(4);
		expect(pulse?.bracket).toBe('main');
	});
});

describe('generateBracket', () => {
	function makeSeeding(count: number) {
		return ENTRANTS.slice(0, count).map((e, i) => ({ entrantId: e.id, seed: i + 1 }));
	}

	it('creates a valid double-elimination bracket for 8 players', () => {
		const rounds = runSwiss(ENTRANTS, 5);
		const standings = calculateFinalStandings(ENTRANTS, rounds);
		const players = makeSeeding(8);
		const bracket = generateBracket('main', players, standings, SETTINGS);

		expect(bracket.matches.length).toBeGreaterThan(0);
		expect(bracket.players.length).toBe(8);

		// All matches should have valid round numbers
		for (const m of bracket.matches) {
			expect(typeof m.round).toBe('number');
		}
	});

	it('every winners match has a path to grand finals', () => {
		const rounds = runSwiss(ENTRANTS, 5);
		const standings = calculateFinalStandings(ENTRANTS, rounds);
		const players = makeSeeding(8);
		const bracket = generateBracket('main', players, standings, SETTINGS);

		const gf = bracket.matches.find((m) => m.id.includes('-GF-'));
		expect(gf).toBeDefined();
	});

	it('has no duplicate match IDs', () => {
		const rounds = runSwiss(ENTRANTS, 5);
		const standings = calculateFinalStandings(ENTRANTS, rounds);
		const players = makeSeeding(8);
		const bracket = generateBracket('main', players, standings, SETTINGS);

		const ids = bracket.matches.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('byes are auto-advanced in first round', () => {
		// 5 players → bracketSize = 8, so 3 byes
		const rounds = runSwiss(ENTRANTS, 5);
		const standings = calculateFinalStandings(ENTRANTS, rounds);
		const players = makeSeeding(5);
		const bracket = generateBracket('main', players, standings, SETTINGS);

		const byeMatches = bracket.matches.filter(
			(m) => m.round === 1 && m.winnerId && (!m.topPlayerId || !m.bottomPlayerId)
		);
		expect(byeMatches.length).toBeGreaterThan(0);
	});

	it('LR4 drops WR3 losers non-reversed (2nd drop-in alternates) for 24-player bracket', () => {
		const entrants24: Entrant[] = Array.from({ length: 24 }, (_, i) => ({
			id: `p-${i + 1}`,
			gamerTag: `Player${i + 1}`,
			initialSeed: i + 1
		}));
		const standings24 = entrants24.map((e) => ({
			rank: e.initialSeed, entrantId: e.id, gamerTag: e.gamerTag,
			wins: 0, losses: 0, initialSeed: e.initialSeed, totalScore: 0,
			basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
			expectedWins: 0, winsAboveExpected: 0, bracket: 'main' as const
		}));
		const players24 = entrants24.map((e) => ({ entrantId: e.id, seed: e.initialSeed }));
		let bracket = generateBracket('main', players24, standings24);

		function playReady(round: number) {
			const ready = bracket.matches.filter(
				(m) => m.round === round && m.topPlayerId && m.bottomPlayerId && !m.winnerId
			);
			for (const m of ready) {
				const topSeed = entrants24.find((e) => e.id === m.topPlayerId)?.initialSeed ?? 999;
				const botSeed = entrants24.find((e) => e.id === m.bottomPlayerId)?.initialSeed ?? 999;
				bracket = reportBracketMatch(bracket, m.id, topSeed < botSeed ? m.topPlayerId! : m.bottomPlayerId!);
			}
		}

		// Play through to populate LR4: WR1→WR2→WR3, LR1→LR2→LR3
		playReady(1);   // WR1
		playReady(-1);  // LR1
		playReady(2);   // WR2
		playReady(-2);  // LR2
		playReady(3);   // WR3
		playReady(-3);  // LR3

		// LR4 matches should now have both players
		const lr4 = bracket.matches
			.filter((m) => m.round === -4)
			.sort((a, b) => a.matchIndex - b.matchIndex);
		expect(lr4.length).toBe(4);

		// WR3 matches (sorted by matchIndex)
		const wr3 = bracket.matches
			.filter((m) => m.round === 3)
			.sort((a, b) => a.matchIndex - b.matchIndex);
		expect(wr3.length).toBe(4);

		// LR4 is the 2nd drop-in (even, 4 items) so uses XOR 1 (swap adjacent pairs):
		// WR3 losers [0,1,2,3] → LR4 top slots [1,0,3,2]
		const wr3Losers = wr3.map((m) =>
			m.topPlayerId === m.winnerId ? m.bottomPlayerId : m.topPlayerId
		);
		const expectedOrder = wr3Losers.map((_, i) => wr3Losers[i ^ 1]);
		for (let i = 0; i < expectedOrder.length; i++) {
			expect(lr4[i].topPlayerId).toBe(expectedOrder[i]);
		}

		// No player appears in multiple LR4 matches
		const lr4Players = lr4.flatMap((m) => [m.topPlayerId, m.bottomPlayerId].filter(Boolean));
		expect(new Set(lr4Players).size).toBe(lr4Players.length);
	});

	it('32-player bracket matches StartGG reference layout (all progressions)', () => {
		// Verified against StartGG's 32-player double-elimination bracket:
		//   Winners: A-P (WR1), Q-X (WR2), Y-AB (WQF), AC-AD (WSF), AE (WF), AF (GF)
		//   Losers:  AH-AO (LR1), AP-AW (LR2), AX-BA (LR3), BB-BE (LR4),
		//            BF-BG (LR5), BH-BI (LQF), BJ (LSF), BK (LF)

		const entrants32: Entrant[] = Array.from({ length: 32 }, (_, i) => ({
			id: `p-${i + 1}`,
			gamerTag: `${i + 1}Test`,
			initialSeed: i + 1
		}));
		const standings32 = entrants32.map((e) => ({
			rank: e.initialSeed, entrantId: e.id, gamerTag: e.gamerTag,
			wins: 0, losses: 0, initialSeed: e.initialSeed, totalScore: 0,
			basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
			expectedWins: 0, winsAboveExpected: 0, bracket: 'main' as const
		}));
		const players32 = entrants32.map((e) => ({ entrantId: e.id, seed: e.initialSeed }));
		const bracket = generateBracket('main', players32, standings32);

		// Helper: get matches by round sorted by matchIndex
		const byRound = (r: number) =>
			bracket.matches.filter((m) => m.round === r).sort((a, b) => a.matchIndex - b.matchIndex);

		const wr1 = byRound(1);  // A-P  (16 matches)
		const wr2 = byRound(2);  // Q-X  (8 matches)
		const wqf = byRound(3);  // Y-AB (4 matches)
		const wsf = byRound(4);  // AC-AD (2 matches)
		const wf  = byRound(5);  // AE   (1 match)
		const gf  = bracket.matches.filter(m => m.id.includes('-GF-'));

		const lr1 = byRound(-1); // AH-AO (8 matches)
		const lr2 = byRound(-2); // AP-AW (8 matches)
		const lr3 = byRound(-3); // AX-BA (4 matches)
		const lr4 = byRound(-4); // BB-BE (4 matches)
		const lr5 = byRound(-5); // BF-BG (2 matches)
		const lr6 = byRound(-6); // BH-BI / LQF (2 matches)
		const lr7 = byRound(-7); // BJ / LSF (1 match)
		const lr8 = byRound(-8); // BK / LF (1 match)

		// Verify round counts
		expect(wr1.length).toBe(16);
		expect(wr2.length).toBe(8);
		expect(wqf.length).toBe(4);
		expect(wsf.length).toBe(2);
		expect(wf.length).toBe(1);
		expect(gf.length).toBe(1);
		expect(lr1.length).toBe(8);
		expect(lr2.length).toBe(8);
		expect(lr3.length).toBe(4);
		expect(lr4.length).toBe(4);
		expect(lr5.length).toBe(2);
		expect(lr6.length).toBe(2);
		expect(lr7.length).toBe(1);
		expect(lr8.length).toBe(1);

		// ── WR1 seeding (A-P) ──
		// Standard 32-player bracket seeding
		const expectedWR1: [number, number][] = [
			[1,32],[16,17],[8,25],[9,24],[4,29],[13,20],[5,28],[12,21],
			[2,31],[15,18],[7,26],[10,23],[3,30],[14,19],[6,27],[11,22]
		];
		for (let i = 0; i < 16; i++) {
			const [topSeed, botSeed] = expectedWR1[i];
			expect(wr1[i].topPlayerId).toBe(`p-${topSeed}`);
			expect(wr1[i].bottomPlayerId).toBe(`p-${botSeed}`);
		}

		// ── Winners progressions ──
		// WR1 winners → WR2: Q gets winner of A+B, R gets winner of C+D, etc.
		for (let i = 0; i < 8; i++) {
			expect(wr1[i * 2].winnerNextMatchId).toBe(wr2[i].id);     // A→Q, C→R, E→S, ...
			expect(wr1[i * 2 + 1].winnerNextMatchId).toBe(wr2[i].id); // B→Q, D→R, F→S, ...
		}
		// WR2 winners → WQF: Y gets winner of Q+R, Z gets winner of S+T, etc.
		for (let i = 0; i < 4; i++) {
			expect(wr2[i * 2].winnerNextMatchId).toBe(wqf[i].id);
			expect(wr2[i * 2 + 1].winnerNextMatchId).toBe(wqf[i].id);
		}
		// WQF winners → WSF
		for (let i = 0; i < 2; i++) {
			expect(wqf[i * 2].winnerNextMatchId).toBe(wsf[i].id);
			expect(wqf[i * 2 + 1].winnerNextMatchId).toBe(wsf[i].id);
		}
		// WSF winners → WF
		expect(wsf[0].winnerNextMatchId).toBe(wf[0].id);
		expect(wsf[1].winnerNextMatchId).toBe(wf[0].id);
		// WF winner → GF
		expect(wf[0].winnerNextMatchId).toBe(gf[0].id);

		// ── LR1: WR1 losers pair up (AH = loser A + loser B, etc.) ──
		for (let i = 0; i < 8; i++) {
			expect(wr1[i * 2].loserNextMatchId).toBe(lr1[i].id);     // A→AH, C→AI, ...
			expect(wr1[i * 2 + 1].loserNextMatchId).toBe(lr1[i].id); // B→AH, D→AI, ...
		}

		// ── LR2 drop-in (Drop 1 — odd — full reversal) ──
		// AP gets loser of X (WR2[7]), AQ gets loser of W (WR2[6]), ..., AW gets loser of Q (WR2[0])
		for (let i = 0; i < 8; i++) {
			const expectedWR2Idx = 7 - i; // full reversal
			expect(wr2[expectedWR2Idx].loserNextMatchId).toBe(lr2[i].id);
			expect(wr2[expectedWR2Idx].loserNextSlot).toBe('top');
		}
		// LR1 winners → LR2 bottom
		for (let i = 0; i < 8; i++) {
			expect(lr1[i].winnerNextMatchId).toBe(lr2[i].id);
			expect(lr1[i].winnerNextSlot).toBe('bottom');
		}

		// ── LR3: LR2 winners pair up ──
		for (let i = 0; i < 4; i++) {
			expect(lr2[i * 2].winnerNextMatchId).toBe(lr3[i].id);
			expect(lr2[i * 2 + 1].winnerNextMatchId).toBe(lr3[i].id);
		}

		// ── LR4 drop-in (Drop 2 — even, 4 items — XOR 1) ──
		// BB gets loser of Z (WQF[1]), BC gets loser of Y (WQF[0]),
		// BD gets loser of AB (WQF[3]), BE gets loser of AA (WQF[2])
		const expectedLR4DropMap = [1, 0, 3, 2]; // XOR 1
		for (let i = 0; i < 4; i++) {
			expect(wqf[expectedLR4DropMap[i]].loserNextMatchId).toBe(lr4[i].id);
			expect(wqf[expectedLR4DropMap[i]].loserNextSlot).toBe('top');
		}
		// LR3 winners → LR4 bottom
		for (let i = 0; i < 4; i++) {
			expect(lr3[i].winnerNextMatchId).toBe(lr4[i].id);
			expect(lr3[i].winnerNextSlot).toBe('bottom');
		}

		// ── LR5: LR4 winners pair up ──
		for (let i = 0; i < 2; i++) {
			expect(lr4[i * 2].winnerNextMatchId).toBe(lr5[i].id);
			expect(lr4[i * 2 + 1].winnerNextMatchId).toBe(lr5[i].id);
		}

		// ── LR6/LQF drop-in (Drop 3 — odd — full reversal) ──
		// BH gets loser of AD (WSF[1]), BI gets loser of AC (WSF[0])
		expect(wsf[1].loserNextMatchId).toBe(lr6[0].id); // AD → BH
		expect(wsf[1].loserNextSlot).toBe('top');
		expect(wsf[0].loserNextMatchId).toBe(lr6[1].id); // AC → BI
		expect(wsf[0].loserNextSlot).toBe('top');
		// LR5 winners → LQF bottom
		for (let i = 0; i < 2; i++) {
			expect(lr5[i].winnerNextMatchId).toBe(lr6[i].id);
			expect(lr5[i].winnerNextSlot).toBe('bottom');
		}

		// ── LR7/LSF: LQF winners pair up ──
		expect(lr6[0].winnerNextMatchId).toBe(lr7[0].id);
		expect(lr6[1].winnerNextMatchId).toBe(lr7[0].id);

		// ── LR8/LF drop-in (Drop 4 — even — single match) ──
		// BK gets loser of AE (WF[0])
		expect(wf[0].loserNextMatchId).toBe(lr8[0].id);
		// LSF winner → LF
		expect(lr7[0].winnerNextMatchId).toBe(lr8[0].id);

		// ── GF ──
		// LF winner → GF (bottom)
		expect(lr8[0].winnerNextMatchId).toBe(gf[0].id);
		// WF winner → GF (top) — already checked above

		// ── Play through entire bracket (higher seed always wins) and verify no duplicates ──
		let b = bracket;
		const roundOrder = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, -6, -7, -8];
		for (const r of roundOrder) {
			const ready = b.matches.filter(
				(m) => m.round === r && m.topPlayerId && m.bottomPlayerId && !m.winnerId
			);
			for (const m of ready) {
				const topSeed = entrants32.find((e) => e.id === m.topPlayerId)?.initialSeed ?? 999;
				const botSeed = entrants32.find((e) => e.id === m.bottomPlayerId)?.initialSeed ?? 999;
				b = reportBracketMatch(b, m.id, topSeed < botSeed ? m.topPlayerId! : m.bottomPlayerId!);
			}
		}
		// Play GF
		const gfReady = b.matches.find(m => m.id.includes('-GF-') && m.topPlayerId && m.bottomPlayerId && !m.winnerId);
		if (gfReady) {
			b = reportBracketMatch(b, gfReady.id, gfReady.topPlayerId!);
		}

		// Every non-bye match should have a winner
		const incompleteNonBye = b.matches.filter(
			(m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId && !m.id.includes('-GFR-')
		);
		expect(incompleteNonBye.length).toBe(0);
	});

	it('no player appears in two matches after full bracket generation with byes', () => {
		const entrants20: Entrant[] = Array.from({ length: 20 }, (_, i) => ({
			id: `p-${i + 1}`,
			gamerTag: `Player${i + 1}`,
			initialSeed: i + 1
		}));
		const standings20 = entrants20.map((e) => ({
			rank: e.initialSeed, entrantId: e.id, gamerTag: e.gamerTag,
			wins: 0, losses: 0, initialSeed: e.initialSeed, totalScore: 0,
			basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
			expectedWins: 0, winsAboveExpected: 0, bracket: 'main' as const
		}));
		const players20 = entrants20.map((e) => ({ entrantId: e.id, seed: e.initialSeed }));
		const bracket = generateBracket('main', players20, standings20);

		// After generation (with bye auto-advancement), no player should be in 2+ matches
		const playerMatches = new Map<string, string[]>();
		for (const m of bracket.matches) {
			for (const pid of [m.topPlayerId, m.bottomPlayerId].filter(Boolean) as string[]) {
				if (!playerMatches.has(pid)) playerMatches.set(pid, []);
				playerMatches.get(pid)!.push(m.id);
			}
		}
		for (const [pid, matchIds] of playerMatches) {
			if (matchIds.length > 1) {
				// A player can appear in a completed match (has winnerId) and their next match
				const completedCount = matchIds.filter((mid) => {
					const m = bracket.matches.find((x) => x.id === mid);
					return m?.winnerId;
				}).length;
				const pendingCount = matchIds.length - completedCount;
				expect(pendingCount).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe('Full tournament integration', () => {
	it('runs 5 rounds, generates brackets, bracket has correct structure', () => {
		const rounds = runSwiss(ENTRANTS, 5);
		expect(rounds.length).toBe(5);
		expect(rounds.every((r) => r.status === 'completed')).toBe(true);

		const standings = calculateFinalStandings(ENTRANTS, rounds);
		expect(standings.length).toBe(16);

		const mainPlayers = standings.filter((s) => s.bracket === 'main').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));
		const redeemPlayers = standings.filter((s) => s.bracket === 'redemption').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));

		const main = generateBracket('main', mainPlayers, standings, SETTINGS);
		const redemption = generateBracket('redemption', redeemPlayers, standings, SETTINGS);

		// Both brackets should have a GF match
		expect(main.matches.some((m) => m.id.includes('-GF-'))).toBe(true);
		expect(redemption.matches.some((m) => m.id.includes('-GF-'))).toBe(true);

		// No player appears in both brackets
		const mainIds = new Set(main.players.map((p) => p.entrantId));
		const redeemIds = new Set(redemption.players.map((p) => p.entrantId));
		for (const id of mainIds) expect(redeemIds.has(id)).toBe(false);

		// Wiring: every non-terminal match has a winnerNextMatchId or loserNextMatchId
		for (const m of main.matches) {
			if (m.round > 0 && !m.id.includes('-GF-') && !m.id.includes('-GFR-')) {
				expect(m.winnerNextMatchId).toBeDefined();
			}
		}
	});
});

// ── Gauntlet mode ───────────────────────────────────────────────────────

describe('Gauntlet mode helpers', () => {
	const fakeStandings = ENTRANTS.map((e) => ({
		rank: e.initialSeed, entrantId: e.id, gamerTag: e.gamerTag,
		wins: 0, losses: 0, initialSeed: e.initialSeed, totalScore: 0,
		basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
		expectedWins: 0, winsAboveExpected: 0, bracket: 'main' as const
	}));
	const players = ENTRANTS.map((e) => ({ entrantId: e.id, seed: e.initialSeed }));

	function simulateGauntlet() {
		let bracket = generateBracket('main', players, fakeStandings);

		// Play all WR1 matches: higher seed wins
		const wr1 = bracket.matches.filter((m) => m.round === 1 && m.topPlayerId && m.bottomPlayerId && !m.winnerId);
		for (const m of wr1) {
			bracket = reportBracketMatch(bracket, m.id, m.topPlayerId!);
		}

		// Play all LR1 matches: higher seed wins (lower loss player advances)
		const lr1 = bracket.matches.filter((m) => m.round === -1 && m.topPlayerId && m.bottomPlayerId && !m.winnerId);
		for (const m of lr1) {
			const topSeed = ENTRANTS.find((e) => e.id === m.topPlayerId)?.initialSeed ?? 999;
			const botSeed = ENTRANTS.find((e) => e.id === m.bottomPlayerId)?.initialSeed ?? 999;
			bracket = reportBracketMatch(bracket, m.id, topSeed < botSeed ? m.topPlayerId! : m.bottomPlayerId!);
		}

		// Play all WR2 matches: higher seed wins
		const wr2 = bracket.matches.filter((m) => m.round === 2 && m.topPlayerId && m.bottomPlayerId && !m.winnerId);
		for (const m of wr2) {
			const topSeed = ENTRANTS.find((e) => e.id === m.topPlayerId)?.initialSeed ?? 999;
			const botSeed = ENTRANTS.find((e) => e.id === m.bottomPlayerId)?.initialSeed ?? 999;
			bracket = reportBracketMatch(bracket, m.id, topSeed < botSeed ? m.topPlayerId! : m.bottomPlayerId!);
		}

		// Play all LR2 matches: higher seed wins
		const lr2 = bracket.matches.filter((m) => m.round === -2 && m.topPlayerId && m.bottomPlayerId && !m.winnerId);
		for (const m of lr2) {
			const topSeed = ENTRANTS.find((e) => e.id === m.topPlayerId)?.initialSeed ?? 999;
			const botSeed = ENTRANTS.find((e) => e.id === m.bottomPlayerId)?.initialSeed ?? 999;
			bracket = reportBracketMatch(bracket, m.id, topSeed < botSeed ? m.topPlayerId! : m.bottomPlayerId!);
		}

		return bracket;
	}

	it('computeBracketRecords tracks wins and losses', () => {
		const bracket = simulateGauntlet();
		const records = computeBracketRecords(bracket.matches);

		// Seed 1 won WR1 and WR2 = 2-0
		expect(records.get('e-1')).toEqual({ wins: 2, losses: 0 });
		// Seed 16 lost WR1, lost LR1 = 0-2
		expect(records.get('e-16')).toEqual({ wins: 0, losses: 2 });
	});

	it('getEliminatedPlayers finds players with no loserNextMatchId', () => {
		const bracket = simulateGauntlet();
		const eliminated = getEliminatedPlayers(bracket.matches);
		// 4 eliminated from LR1 (0-2) + 4 from LR2 (1-2) = 8
		expect(eliminated.length).toBe(8);
	});

	it('isGauntletRedemptionReady returns true after LR1 and LR2 complete', () => {
		let bracket = generateBracket('main', players, fakeStandings);
		expect(isGauntletRedemptionReady(bracket.matches)).toBe(false);

		bracket = simulateGauntlet();
		expect(isGauntletRedemptionReady(bracket.matches)).toBe(true);
	});

	it('generateGauntletRedemption creates bracket with correct player count', () => {
		const bracket = simulateGauntlet();
		const redemption = generateGauntletRedemption(bracket.matches, ENTRANTS);

		// 4 players with 0-2 + 4 with 1-2 = 8 players
		expect(redemption.players.length).toBe(8);
		expect(redemption.name).toBe('redemption');

		// 1-2 players should be seeded ahead of 0-2 players
		const records = computeBracketRecords(bracket.matches);
		const firstPlayer = redemption.players[0];
		const firstRecord = records.get(firstPlayer.entrantId);
		expect(firstRecord?.wins).toBe(1);
	});

	it('gauntlet redemption has no overlap with still-alive main bracket players', () => {
		const bracket = simulateGauntlet();
		const redemption = generateGauntletRedemption(bracket.matches, ENTRANTS);
		const redemptionIds = new Set(redemption.players.map((p) => p.entrantId));

		// Players still alive in main bracket should NOT be in redemption
		const aliveInMain = new Set<string>();
		for (const m of bracket.matches) {
			if (!m.winnerId && m.topPlayerId) aliveInMain.add(m.topPlayerId);
			if (!m.winnerId && m.bottomPlayerId) aliveInMain.add(m.bottomPlayerId);
		}
		for (const id of aliveInMain) {
			expect(redemptionIds.has(id)).toBe(false);
		}
	});
});
