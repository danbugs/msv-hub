/**
 * Swiss pairing engine — ported from daness_v2.py
 *
 * Handles: pairing with rematch avoidance, standings, Cinderella bonuses,
 * final standings, bracket generation, station assignment, stream recommendations.
 */

import type {
	Entrant,
	SwissMatch,
	SwissRound,
	PlayerStanding,
	FinalStanding,
	StreamRecommendation,
	TournamentSettings
} from '$lib/types/tournament';

// ── Standings ────────────────────────────────────────────────────────────

export function calculateStandings(
	entrants: Entrant[],
	rounds: SwissRound[]
): Map<string, PlayerStanding> {
	const standings = new Map<string, PlayerStanding>();

	for (const e of entrants) {
		standings.set(e.id, {
			gamerTag: e.gamerTag,
			entrantId: e.id,
			seed: e.initialSeed,
			wins: 0,
			losses: 0,
			opponents: [],
			opponentWins: 0,
			byes: 0
		});
	}

	for (const round of rounds) {
		if (round.byePlayerId) {
			const s = standings.get(round.byePlayerId);
			if (s) {
				s.wins++;
				s.byes++;
				s.opponents.push('BYE');
			}
		}

		for (const match of round.matches) {
			if (!match.winnerId) continue;
			const top = standings.get(match.topPlayerId);
			const bot = standings.get(match.bottomPlayerId);
			if (!top || !bot) continue;

			top.opponents.push(match.bottomPlayerId);
			bot.opponents.push(match.topPlayerId);

			if (match.winnerId === match.topPlayerId) {
				top.wins++;
				bot.losses++;
			} else {
				bot.wins++;
				top.losses++;
			}
		}
	}

	// Calculate opponent wins
	for (const [, info] of standings) {
		for (const oppId of info.opponents) {
			const opp = standings.get(oppId);
			if (opp) info.opponentWins += opp.wins;
		}
	}

	return standings;
}

// ── Recommended rounds ───────────────────────────────────────────────────

export function calculateRecommendedRounds(numPlayers: number, numSetups?: number): number | null {
	if (numPlayers <= 0) return 3;

	const idealRounds = Math.min(5, Math.max(3, Math.ceil(Math.log2(numPlayers))));

	if (numSetups === undefined) return idealRounds;

	const matchesPerRound = Math.floor(numPlayers / 2);

	if (numSetups >= matchesPerRound) return idealRounds;
	if (numSetups < Math.floor(matchesPerRound / 2)) return null; // unrunnable

	// Only reduce rounds when shortage is significant (>20% of matches)
	const shortage = matchesPerRound - numSetups;
	if (shortage <= Math.floor(matchesPerRound * 0.2)) return idealRounds;
	if (shortage <= Math.floor(matchesPerRound * 0.5)) return Math.max(3, idealRounds - 1);
	return Math.max(3, idealRounds - 2);
}

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────

function mulberry32(seed: number) {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── Swiss pairing ────────────────────────────────────────────────────────

type PlayerEntry = [string, PlayerStanding]; // [entrantId, standing]

export function calculateSwissPairings(
	standings: Map<string, PlayerStanding>,
	roundNumber: number
): { pairings: [PlayerEntry, PlayerEntry][]; bye: PlayerEntry | null } {
	const totalPlayers = standings.size;
	const isPowerOf2 = (totalPlayers & (totalPlayers - 1)) === 0 && totalPlayers > 0;

	// Date-based variance seed
	const today = new Date();
	const weekSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
	const rng = mulberry32(weekSeed);

	function canPair(p1: PlayerEntry, p2: PlayerEntry): boolean {
		return !p1[1].opponents.includes(p2[0]) && !p2[1].opponents.includes(p1[0]);
	}

	function getPairingQuality(p1: PlayerEntry, p2: PlayerEntry): number {
		const seedDiff = Math.abs(p1[1].seed - p2[1].seed);
		// Heavy penalty for matching players with different win-loss differentials
		const recordDiff = Math.abs((p1[1].wins - p1[1].losses) - (p2[1].wins - p2[1].losses));
		const recordPenalty = recordDiff * 200;
		if (isPowerOf2) return seedDiff + recordPenalty;
		if (seedDiff <= 1 && p1[1].wins + p1[1].losses <= 2) return 1000 + recordPenalty;
		return seedDiff * 0.5 + recordPenalty;
	}

	// Group players by record
	const groups = new Map<string, PlayerEntry[]>();
	for (const [id, info] of standings) {
		const key = `${info.wins}-${info.losses}`;
		const group = groups.get(key) ?? [];
		group.push([id, info]);
		groups.set(key, group);
	}

	// Sort groups: wins desc, losses asc
	const sortedGroups = [...groups.entries()].sort((a, b) => {
		const [aw, al] = a[0].split('-').map(Number);
		const [bw, bl] = b[0].split('-').map(Number);
		if (aw !== bw) return bw - aw;
		return al - bl;
	});

	// ── Backtracking matcher ──────────────────────────────────────────

	function findPerfectMatchingBacktrack(
		players: PlayerEntry[],
		currentMatching: [PlayerEntry, PlayerEntry][] = [],
		usedPlayers: Set<string> = new Set()
	): [PlayerEntry, PlayerEntry][] | null {
		if (usedPlayers.size === players.length) return currentMatching;

		let p1: PlayerEntry | null = null;
		for (const p of players) {
			if (!usedPlayers.has(p[0])) { p1 = p; break; }
		}
		if (!p1) return currentMatching;

		const validOpponents: [PlayerEntry, number][] = [];
		for (const p2 of players) {
			if (!usedPlayers.has(p2[0]) && p1[0] !== p2[0] && canPair(p1, p2)) {
				validOpponents.push([p2, getPairingQuality(p1, p2)]);
			}
		}
		validOpponents.sort((a, b) => a[1] - b[1]);

		for (const [p2] of validOpponents) {
			const newMatching: [PlayerEntry, PlayerEntry][] = [...currentMatching, [p1!, p2]];
			const newUsed = new Set(usedPlayers);
			newUsed.add(p1![0]);
			newUsed.add(p2[0]);

			const result = findPerfectMatchingBacktrack(players, newMatching, newUsed);
			if (result && result.length * 2 === players.length) return result;
		}

		return null;
	}

	function findPerfectMatchingLargeGroup(
		players: PlayerEntry[]
	): [PlayerEntry, PlayerEntry][] | null {
		const n = players.length;
		if (n % 2 !== 0) return null;
		const half = n / 2;

		// Strategy 1: Swiss-style top-half vs bottom-half
		const sorted = [...players].sort((a, b) => a[1].seed - b[1].seed + (rng() - 0.5) * 3);
		const swissPairs: [PlayerEntry, PlayerEntry][] = [];
		const usedIndices = new Set<number>();

		for (let i = 0; i < half; i++) {
			if (usedIndices.has(i)) continue;
			for (let offset = 0; offset < 3; offset++) {
				const j = i + half + (offset > 0 ? offset - 1 : 0);
				if (j >= 0 && j < n && !usedIndices.has(j) && canPair(sorted[i], sorted[j])) {
					swissPairs.push([sorted[i], sorted[j]]);
					usedIndices.add(i);
					usedIndices.add(j);
					break;
				}
			}
		}
		if (swissPairs.length === half) return swissPairs;

		// Strategy 2: Greedy weighted matching
		const validPairings: [number, number, number][] = [];
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				if (canPair(players[i], players[j])) {
					validPairings.push([i, j, getPairingQuality(players[i], players[j])]);
				}
			}
		}
		validPairings.sort((a, b) => a[2] - b[2]);

		const matched = new Set<number>();
		const resultPairs: [PlayerEntry, PlayerEntry][] = [];

		for (const [i, j] of validPairings) {
			if (!matched.has(i) && !matched.has(j)) {
				resultPairs.push([players[i], players[j]]);
				matched.add(i);
				matched.add(j);
				if (resultPairs.length === half) return resultPairs;
			}
		}

		// Strategy 3: Backtrack remaining
		if (resultPairs.length > half - 2) {
			const remaining = players.filter((_, i) => !matched.has(i));
			if (remaining.length <= 4) {
				const extra = findPerfectMatchingBacktrack(remaining);
				if (extra) return [...resultPairs, ...extra];
			}
		}

		return null;
	}

	function findValidPairingForGroup(players: PlayerEntry[]): [PlayerEntry, PlayerEntry][] | null {
		if (players.length === 0) return [];
		if (players.length === 1) return null;

		// Sort by seed with random variance
		const withRandom = players.map((p) => [p, rng()] as [PlayerEntry, number]);
		withRandom.sort((a, b) => a[0][1].seed + a[1] * 3 - (b[0][1].seed + b[1] * 3));
		const sorted = withRandom.map((x) => x[0]);

		if (sorted.length <= 8) return findPerfectMatchingBacktrack(sorted);
		return findPerfectMatchingLargeGroup(sorted);
	}

	// ── Main pairing logic ────────────────────────────────────────────

	const pairings: [PlayerEntry, PlayerEntry][] = [];
	const used = new Set<string>();

	// Round 1: all players are 0-0 — use deterministic seed-order pairing (1 vs N/2+1,
	// 2 vs N/2+2, …) to match StartGG's seeded-event pairings exactly.
	if (roundNumber === 1) {
		const allPlayers = [...standings.entries()].sort((a, b) => a[1].seed - b[1].seed);
		let byeEntry: PlayerEntry | null = null;
		const toMatch = [...allPlayers];
		if (toMatch.length % 2 === 1) {
			byeEntry = toMatch.pop()!;
		}
		const half = toMatch.length / 2;
		for (let i = 0; i < half; i++) {
			pairings.push([toMatch[i], toMatch[i + half]]);
		}
		return { pairings, bye: byeEntry };
	}

	for (const [, players] of sortedGroups) {
		const available = players.filter((p) => !used.has(p[0]));
		if (available.length < 2) {
			// All go to unpaired
			continue;
		}

		let heldOut: PlayerEntry | null = null;
		if (available.length % 2 === 1) {
			// Hold out player with most flexibility for cross-group pairing
			let bestPlayer: PlayerEntry | null = null;
			let bestFlex = -1;
			for (const player of available) {
				let flex = 0;
				for (const other of available) {
					if (other[0] !== player[0] && canPair(player, other)) flex++;
				}
				if (flex > bestFlex) { bestFlex = flex; bestPlayer = player; }
			}
			if (bestPlayer) {
				heldOut = bestPlayer;
				available.splice(available.indexOf(heldOut), 1);
			}
		}

		const groupPairings = findValidPairingForGroup(available);
		if (groupPairings) {
			for (const [p1, p2] of groupPairings) {
				used.add(p1[0]);
				used.add(p2[0]);
			}
			pairings.push(...groupPairings);
		} else {
			// Fallback: greedy
			const temp = [...available];
			while (temp.length >= 2) {
				const p1 = temp[0];
				let bestOpp: PlayerEntry | null = null;
				let bestQuality = Infinity;
				for (const p2 of temp.slice(1)) {
					if (canPair(p1, p2)) {
						const q = getPairingQuality(p1, p2);
						if (q < bestQuality) { bestQuality = q; bestOpp = p2; }
					}
				}
				if (bestOpp) {
					pairings.push([p1, bestOpp]);
					used.add(p1[0]);
					used.add(bestOpp[0]);
					temp.splice(temp.indexOf(p1), 1);
					temp.splice(temp.indexOf(bestOpp), 1);
				} else {
					break;
				}
			}
		}
	}

	// Handle unpaired players (cross-group pairing)
	const unpaired = [...standings.entries()]
		.filter(([id]) => !used.has(id))
		.map(([id, info]) => [id, info] as PlayerEntry)
		.sort((a, b) => -(a[1].wins - a[1].losses) - (-(b[1].wins - b[1].losses)) || a[1].seed - b[1].seed + (rng() - 0.5) * 2);

	let bye: PlayerEntry | null = null;

	if (unpaired.length % 2 === 1) {
		// Assign bye to player with fewest byes (then best record, then best seed)
		const sorted = [...unpaired].sort(
			(a, b) => a[1].byes - b[1].byes || -(a[1].wins - a[1].losses) - (-(b[1].wins - b[1].losses)) || a[1].seed - b[1].seed
		);
		bye = sorted[0];
		unpaired.splice(unpaired.indexOf(bye), 1);
	}

	if (unpaired.length >= 2) {
		const crossPairs = findValidPairingForGroup(unpaired);
		if (crossPairs) {
			for (const [p1, p2] of crossPairs) {
				used.add(p1[0]);
				used.add(p2[0]);
			}
			pairings.push(...crossPairs);
		} else {
			// Last resort: pair sequentially
			for (let i = 0; i < unpaired.length - 1; i += 2) {
				pairings.push([unpaired[i], unpaired[i + 1]]);
				used.add(unpaired[i][0]);
				used.add(unpaired[i + 1][0]);
			}
		}
	}

	return { pairings, bye };
}

// ── Station assignment ───────────────────────────────────────────────────

export function assignStations(
	matches: SwissMatch[],
	settings: TournamentSettings,
	streamRecommendations?: StreamRecommendation[]
): SwissMatch[] {
	const assigned = [...matches];

	// Put best stream match on stream station
	if (streamRecommendations?.length) {
		const streamMatchId = streamRecommendations[0].matchId;
		const idx = assigned.findIndex((m) => m.id === streamMatchId);
		if (idx >= 0) {
			assigned[idx] = { ...assigned[idx], station: settings.streamStation, isStream: true };
		}
	}

	// Assign remaining stations round-robin
	let nextStation = 1;
	for (let i = 0; i < assigned.length; i++) {
		if (assigned[i].station !== undefined) continue;
		// Skip stream station
		while (nextStation === settings.streamStation && assigned.some((m) => m.isStream)) {
			nextStation++;
		}
		if (nextStation > settings.numStations) nextStation = 1;
		assigned[i] = { ...assigned[i], station: nextStation };
		nextStation++;
	}

	return assigned;
}

// ── Bracket station assignment ────────────────────────────────────────────

export function assignBracketStations(bracket: BracketState, settings: TournamentSettings): BracketState {
	const updated = { ...bracket, matches: bracket.matches.map((m) => ({ ...m })) };

	// Find ready matches that don't have a station yet
	const ready = updated.matches.filter(
		(m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId && m.station === undefined
	);
	if (ready.length === 0) return updated;

	// Pick stream match: highest-round ready match (later rounds = more hype)
	const maxReadyRound = Math.max(...ready.map((m) => Math.abs(m.round)));
	const streamCandidate = ready.find((m) => Math.abs(m.round) === maxReadyRound);

	if (streamCandidate) {
		const idx = updated.matches.findIndex((m) => m.id === streamCandidate.id);
		// Clear previous stream designation
		for (let i = 0; i < updated.matches.length; i++) {
			if (updated.matches[i].isStream && updated.matches[i].winnerId) {
				updated.matches[i] = { ...updated.matches[i], isStream: false };
			}
		}
		updated.matches[idx] = { ...updated.matches[idx], station: settings.streamStation, isStream: true };
	}

	// Assign remaining stations
	let nextStation = 1;
	for (let i = 0; i < updated.matches.length; i++) {
		const m = updated.matches[i];
		if (!m.topPlayerId || !m.bottomPlayerId || m.winnerId || m.station !== undefined) continue;
		while (nextStation === settings.streamStation) nextStation++;
		if (nextStation > settings.numStations) nextStation = 1;
		updated.matches[i] = { ...m, station: nextStation };
		nextStation++;
	}

	return updated;
}

// ── Stream recommendations ───────────────────────────────────────────────

export function recommendStreamMatches(
	pairings: [string, string][],
	standings: Map<string, PlayerStanding>,
	entrants: Entrant[],
	recentStreamPlayerIds?: Set<string>
): StreamRecommendation[] {
	const entrantMap = new Map(entrants.map((e) => [e.id, e]));

	const currentRound =
		pairings.length > 0
			? (() => {
				const s = standings.get(pairings[0][0]);
				return s ? s.wins + s.losses + 1 : 1;
			})()
			: 1;

	const totalPlayers = standings.size;

	const scored: StreamRecommendation[] = pairings.map(([topId, botId]) => {
		const top = standings.get(topId)!;
		const bot = standings.get(botId)!;
		let hypeScore = 0;
		const reasons: string[] = [];

		// Factor 1: Critical R5 matches
		if (currentRound === 5) {
			if (top.wins === 2 && top.losses === 2 && bot.wins === 2 && bot.losses === 2) {
				hypeScore += 50;
				reasons.push('Bracket qualification on the line');
			} else if ((top.wins === 3 && bot.wins === 3) || (top.wins === 1 && bot.wins === 1)) {
				hypeScore += 30;
				reasons.push('Final round seeding implications');
			}
		}

		// Factor 2: Elimination pressure
		if (currentRound >= 3) {
			if (top.losses === 2 && bot.losses === 2) {
				hypeScore += 35;
				reasons.push('Elimination zone battle');
			} else if (top.wins === 2 && top.losses === 0 && bot.wins === 2 && bot.losses === 0) {
				hypeScore += 30;
				reasons.push('Clash of the undefeated');
			}
		}

		// Factor 3: David vs Goliath
		const seedDiff = Math.abs(top.seed - bot.seed);
		if (seedDiff >= 12) {
			hypeScore += 15;
			reasons.push('David vs Goliath');
		}

		// Factor 4: High momentum
		if (top.wins >= 2 && bot.wins >= 2 && currentRound >= 3) {
			hypeScore += 10;
			reasons.push('High momentum clash');
		}

		// Penalty for top seeds in early rounds
		if (currentRound <= 3 && (top.seed <= 4 || bot.seed <= 4)) {
			hypeScore -= 10;
		}

		// Penalty for players who were on stream last round
		if (recentStreamPlayerIds?.has(topId) || recentStreamPlayerIds?.has(botId)) {
			hypeScore -= 25;
			reasons.push('⚠ recently on stream');
		}

		const matchId = `r${currentRound}-${topId}-${botId}`;
		return {
			matchId,
			topPlayer: entrantMap.get(topId)?.gamerTag ?? topId,
			bottomPlayer: entrantMap.get(botId)?.gamerTag ?? botId,
			hypeScore: Math.max(0, hypeScore),
			reasons
		};
	});

	return scored.sort((a, b) => b.hypeScore - a.hypeScore);
}

// ── Cinderella bonus ─────────────────────────────────────────────────────

function getExpectedWins(seed: number, totalPlayers: number, numRounds: number): number {
	if (totalPlayers <= 0 || seed <= 0 || seed > totalPlayers) return numRounds / 2.0;
	const normalizedPosition = (seed - 1) / Math.max(1, totalPlayers - 1);
	const winRate =
		normalizedPosition <= 0.5
			? 0.8 - normalizedPosition * 0.6
			: 0.5 - (normalizedPosition - 0.5) * 0.6;
	return winRate * numRounds;
}

function getCinderellaMultiplier(seed: number, totalPlayers: number): number {
	if (totalPlayers <= 0) return 1.0;
	const pct = seed / totalPlayers;
	if (pct <= 0.25) return 0.5;
	if (pct <= 0.5) return 1.0;
	if (pct <= 0.75) return 1.5;
	return 2.0;
}

function calculateCinderellaBonus(
	seed: number,
	wins: number,
	standing: PlayerStanding,
	allStandings: Map<string, PlayerStanding>,
	rounds: SwissRound[],
	totalPlayers: number,
	numRounds: number
): number {
	const expected = getExpectedWins(seed, totalPlayers, numRounds);
	const above = wins - expected;
	let bonus = 0;

	if (above > 0.5) {
		const mult = getCinderellaMultiplier(seed, totalPlayers);

		for (let i = 0; i < Math.floor(above); i++) {
			bonus += (3 + i * 2) * mult;
		}
		const frac = above - Math.floor(above);
		if (frac > 0) bonus += frac * (3 + Math.floor(above) * 2) * mult;

		// Upset bonus
		const sigThreshold = Math.max(8, Math.floor(totalPlayers / 4));
		const bigThreshold = Math.max(12, Math.floor(totalPlayers / 3));
		const hugeThreshold = Math.max(16, Math.floor(totalPlayers / 2));

		for (const oppId of standing.opponents) {
			const opp = allStandings.get(oppId);
			if (!opp) continue;
			const diff = seed - opp.seed;
			if (diff < sigThreshold) continue;

			// Check if we beat this opponent
			for (const round of rounds) {
				for (const match of round.matches) {
					const isThisMatch =
						(match.topPlayerId === standing.entrantId && match.bottomPlayerId === oppId) ||
						(match.bottomPlayerId === standing.entrantId && match.topPlayerId === oppId);
					if (isThisMatch && match.winnerId === standing.entrantId) {
						if (diff >= hugeThreshold) bonus += 5;
						else if (diff >= bigThreshold) bonus += 3;
						else bonus += 2;
					}
				}
			}
		}
	}

	const maxBonus = Math.min(20.0, totalPlayers * 0.625);
	return Math.min(bonus, maxBonus);
}

// ── Final standings ──────────────────────────────────────────────────────

export function calculateFinalStandings(
	entrants: Entrant[],
	rounds: SwissRound[]
): FinalStanding[] {
	const standings = calculateStandings(entrants, rounds);
	const totalPlayers = entrants.length;
	const numRounds = rounds.length;
	const entrantMap = new Map(entrants.map((e) => [e.id, e]));

	const results: Omit<FinalStanding, 'rank' | 'bracket'>[] = [];

	for (const [, info] of standings) {
		const basePoints = totalPlayers - (info.seed - 1);
		let winPoints = 0;
		let lossPoints = 0;

		for (const oppId of info.opponents) {
			const opp = standings.get(oppId);
			if (!opp) continue;
			const oppBase = totalPlayers - (opp.seed - 1);

			// Check if win or loss against this opponent
			for (const round of rounds) {
				for (const match of round.matches) {
					const isMatch =
						(match.topPlayerId === info.entrantId && match.bottomPlayerId === oppId) ||
						(match.bottomPlayerId === info.entrantId && match.topPlayerId === oppId);
					if (!isMatch || !match.winnerId) continue;

					if (match.winnerId === info.entrantId) {
						winPoints += oppBase * 0.1;
					} else {
						lossPoints -= (totalPlayers - oppBase + 1) * 0.05;
					}
				}
			}
		}

		const cinderellaBonus = calculateCinderellaBonus(
			info.seed, info.wins, info, standings, rounds, totalPlayers, numRounds
		);

		const expected = getExpectedWins(info.seed, totalPlayers, numRounds);
		const totalScore = info.wins * 100 + basePoints + winPoints + lossPoints + cinderellaBonus;

		results.push({
			entrantId: info.entrantId,
			gamerTag: entrantMap.get(info.entrantId)?.gamerTag ?? info.gamerTag,
			wins: info.wins,
			losses: info.losses,
			initialSeed: info.seed,
			totalScore,
			basePoints,
			winPoints,
			lossPoints,
			cinderellaBonus,
			expectedWins: expected,
			winsAboveExpected: info.wins - expected
		});
	}

	// Sort by record group then total score
	const recordGroups = new Map<string, typeof results>();
	for (const r of results) {
		const key = `${r.wins}-${r.losses}`;
		const group = recordGroups.get(key) ?? [];
		group.push(r);
		recordGroups.set(key, group);
	}

	for (const [, group] of recordGroups) {
		group.sort((a, b) => b.totalScore - a.totalScore || a.initialSeed - b.initialSeed);
	}

	const sortedKeys = [...recordGroups.keys()].sort((a, b) => {
		const [aw, al] = a.split('-').map(Number);
		const [bw, bl] = b.split('-').map(Number);
		if (aw !== bw) return bw - aw;
		return al - bl;
	});

	const sorted: FinalStanding[] = [];
	let rank = 1;
	const mainSize = Math.ceil(totalPlayers / 2);

	for (const key of sortedKeys) {
		for (const r of recordGroups.get(key)!) {
			sorted.push({
				...r,
				rank,
				bracket: rank <= mainSize ? 'main' : 'redemption'
			});
			rank++;
		}
	}

	return sorted;
}

// ── Bracket generation (Double Elimination) ──────────────────────────────

import type { BracketMatch, BracketState } from '$lib/types/tournament';

export function generateBracket(
	name: string,
	players: { entrantId: string; seed: number }[],
	allStandings: FinalStanding[],
	settings?: TournamentSettings
): BracketState {
	const n = players.length;
	// Pad to next power of 2 for bracket structure
	const bracketSize = Math.pow(2, Math.ceil(Math.log2(n)));
	const numFirstRoundMatches = bracketSize / 2;

	// Optimize arrangement to minimize rematches
	const optimized = optimizeBracketArrangement(players, allStandings);

	const matches: BracketMatch[] = [];
	let matchCounter = 0;

	// ── Winners bracket ──
	const winnersRounds = Math.ceil(Math.log2(bracketSize));

	// First round: seeded matchups (1 vs N, 2 vs N-1, etc.)
	const firstRoundMatches: BracketMatch[] = [];
	for (let i = 0; i < numFirstRoundMatches; i++) {
		const topIdx = i;
		const botIdx = bracketSize - 1 - i;

		const topPlayer = topIdx < optimized.length ? optimized[topIdx].entrantId : undefined;
		const botPlayer = botIdx < optimized.length ? optimized[botIdx].entrantId : undefined;

		const match: BracketMatch = {
			id: `${name}-W${1}-${matchCounter++}`,
			round: 1,
			matchIndex: i,
			topPlayerId: topPlayer,
			bottomPlayerId: botPlayer
		};

		// If only one player (bye), auto-advance
		if (topPlayer && !botPlayer) {
			match.winnerId = topPlayer;
		} else if (!topPlayer && botPlayer) {
			match.winnerId = botPlayer;
		}

		firstRoundMatches.push(match);
	}
	matches.push(...firstRoundMatches);

	// Subsequent winners rounds
	let prevRoundMatches = firstRoundMatches;
	for (let round = 2; round <= winnersRounds; round++) {
		const roundMatches: BracketMatch[] = [];
		for (let i = 0; i < prevRoundMatches.length / 2; i++) {
			const match: BracketMatch = {
				id: `${name}-W${round}-${matchCounter++}`,
				round,
				matchIndex: i
			};
			roundMatches.push(match);

			// Wire up winners from previous round
			const prev1 = prevRoundMatches[i * 2];
			const prev2 = prevRoundMatches[i * 2 + 1];
			prev1.winnerNextMatchId = match.id;
			prev1.winnerNextSlot = 'top';
			prev2.winnerNextMatchId = match.id;
			prev2.winnerNextSlot = 'bottom';
		}
		matches.push(...roundMatches);
		prevRoundMatches = roundMatches;
	}

	// ── Losers bracket ──
	// Structure:
	//   L1        : W1 losers fight each other (2 W1 losers per L1 match)
	//   Even lR   : L(prev) survivors (top) + W(lR/2+1) drop-ins (bottom)
	//   Odd lR ≥3 : L(prev) survivors play each other (count halves)
	const losersRounds = (winnersRounds - 1) * 2;
	let losersPrevMatches: BracketMatch[] = [];

	for (let lRound = 1; lRound <= losersRounds; lRound++) {
		let numMatches: number;
		if (lRound === 1) {
			numMatches = firstRoundMatches.length / 2;
		} else if (lRound % 2 === 0) {
			numMatches = losersPrevMatches.length; // 1:1 with survivors, drop-ins fill other slot
		} else {
			numMatches = Math.floor(losersPrevMatches.length / 2); // pair up survivors
		}

		const roundMatches: BracketMatch[] = [];
		for (let i = 0; i < numMatches; i++) {
			roundMatches.push({
				id: `${name}-L${lRound}-${matchCounter++}`,
				round: -lRound,
				matchIndex: i
			});
		}

		if (lRound === 1) {
			// Wire pairs of W1 losers into each L1 match (top + bottom slot)
			for (let i = 0; i < numMatches; i++) {
				const w1a = firstRoundMatches[i * 2];
				const w1b = firstRoundMatches[i * 2 + 1];
				if (w1a) { w1a.loserNextMatchId = roundMatches[i].id; w1a.loserNextSlot = 'top'; }
				if (w1b) { w1b.loserNextMatchId = roundMatches[i].id; w1b.loserNextSlot = 'bottom'; }
			}
		} else if (lRound % 2 === 0) {
			// Even: L(prev) survivors → top; W(lR/2+1) losers → bottom (cross/reversed to match StartGG)
			const dropWinnersRound = lRound / 2 + 1;
			const winnersDropMatches = matches.filter((m) => m.round === dropWinnersRound);
			for (let i = 0; i < numMatches; i++) {
				const prev = losersPrevMatches[i];
				if (prev) { prev.winnerNextMatchId = roundMatches[i].id; prev.winnerNextSlot = 'top'; }
				const wd = winnersDropMatches[numMatches - 1 - i];
				if (wd) { wd.loserNextMatchId = roundMatches[i].id; wd.loserNextSlot = 'bottom'; }
			}
		} else {
			// Odd ≥ 3: pair up L(prev) survivors
			for (let i = 0; i < numMatches; i++) {
				const prev1 = losersPrevMatches[i * 2];
				const prev2 = losersPrevMatches[i * 2 + 1];
				if (prev1) { prev1.winnerNextMatchId = roundMatches[i].id; prev1.winnerNextSlot = 'top'; }
				if (prev2) { prev2.winnerNextMatchId = roundMatches[i].id; prev2.winnerNextSlot = 'bottom'; }
			}
		}

		matches.push(...roundMatches);
		losersPrevMatches = roundMatches;
	}

	// ── Grand Finals ──
	const gfMatch: BracketMatch = {
		id: `${name}-GF-${matchCounter++}`,
		round: winnersRounds + 1,
		matchIndex: 0
	};

	// Winners finals winner → GF top
	const wf = matches.filter((m) => m.round === winnersRounds);
	if (wf.length === 1) {
		wf[0].winnerNextMatchId = gfMatch.id;
		wf[0].winnerNextSlot = 'top';
	}

	// Losers finals winner → GF bottom
	if (losersPrevMatches.length === 1) {
		losersPrevMatches[0].winnerNextMatchId = gfMatch.id;
		losersPrevMatches[0].winnerNextSlot = 'bottom';
	}

	matches.push(gfMatch);

	// Auto-advance byes in first round
	for (const match of firstRoundMatches) {
		if (match.winnerId && match.winnerNextMatchId) {
			advancePlayer(matches, match);
		}
	}

	const state: BracketState = {
		name,
		type: 'double_elimination',
		players: optimized.map((p, i) => ({ entrantId: p.entrantId, seed: i + 1 })),
		matches,
		currentRound: 1
	};

	return settings ? assignBracketStations(state, settings) : state;
}

function advancePlayer(allMatches: BracketMatch[], completedMatch: BracketMatch) {
	if (!completedMatch.winnerId) return;

	// Advance winner
	if (completedMatch.winnerNextMatchId) {
		const next = allMatches.find((m) => m.id === completedMatch.winnerNextMatchId);
		if (next) {
			if (completedMatch.winnerNextSlot === 'top') next.topPlayerId = completedMatch.winnerId;
			else next.bottomPlayerId = completedMatch.winnerId;
		}
	}

	// Drop loser to losers bracket
	const loserId =
		completedMatch.topPlayerId === completedMatch.winnerId
			? completedMatch.bottomPlayerId
			: completedMatch.topPlayerId;

	if (loserId && completedMatch.loserNextMatchId) {
		const next = allMatches.find((m) => m.id === completedMatch.loserNextMatchId);
		if (next) {
			if (completedMatch.loserNextSlot === 'top') next.topPlayerId = loserId;
			else next.bottomPlayerId = loserId;
		}
		completedMatch.loserId = loserId;
	}
}

export function reportBracketMatch(
	bracket: BracketState,
	matchId: string,
	winnerId: string,
	topCharacters?: string[],
	bottomCharacters?: string[],
	topScore?: number,
	bottomScore?: number,
	settings?: TournamentSettings
): BracketState {
	const updated = { ...bracket, matches: bracket.matches.map((m) => ({ ...m })) };
	const match = updated.matches.find((m) => m.id === matchId);
	if (!match) throw new Error(`Match ${matchId} not found`);

	match.winnerId = winnerId;
	if (topCharacters?.length) match.topCharacters = topCharacters;
	if (bottomCharacters?.length) match.bottomCharacters = bottomCharacters;
	if (topScore !== undefined) match.topScore = topScore;
	if (bottomScore !== undefined) match.bottomScore = bottomScore;

	advancePlayer(updated.matches, match);

	// Grand Finals Reset: if the GF bottom-slot player (losers finalist) wins,
	// create a reset match — no bracket advantage, single game.
	const maxRound = Math.max(...updated.matches.map((m) => m.round));
	const isGF = match.round === maxRound && !match.winnerNextMatchId;
	const isGFReset = match.id.includes('-GFR-');
	if (isGF && !isGFReset && winnerId === match.bottomPlayerId) {
		// Check a reset doesn't already exist
		const resetExists = updated.matches.some((m) => m.id.includes('-GFR-'));
		if (!resetExists) {
			const resetMatch: BracketMatch = {
				id: `${bracket.name}-GFR-0`,
				round: maxRound + 1,
				matchIndex: 0,
				// Original winners finalist is top, losers finalist (who just won GF) is bottom
				topPlayerId: match.topPlayerId,
				bottomPlayerId: match.bottomPlayerId
			};
			updated.matches.push(resetMatch);
		}
	}

	return settings ? assignBracketStations(updated, settings) : updated;
}

function optimizeBracketArrangement(
	players: { entrantId: string; seed: number }[],
	allStandings: FinalStanding[]
): { entrantId: string; seed: number }[] {
	const standingMap = new Map(allStandings.map((s) => [s.entrantId, s]));
	let best = [...players];
	let bestRematches = countBracketRematches(best, standingMap);

	if (bestRematches === 0) return best;

	// Try adjacent swaps
	for (let i = 0; i < players.length - 1; i++) {
		const test = [...best];
		[test[i], test[i + 1]] = [test[i + 1], test[i]];
		const count = countBracketRematches(test, standingMap);
		if (count < bestRematches) {
			best = test;
			bestRematches = count;
		}
	}

	// Try wider swaps if still have rematches
	if (bestRematches > 0) {
		for (let i = 0; i < players.length; i++) {
			for (let j = i + 2; j < Math.min(i + 5, players.length); j++) {
				const test = [...best];
				[test[i], test[j]] = [test[j], test[i]];
				const count = countBracketRematches(test, standingMap);
				if (count < bestRematches) {
					best = test;
					bestRematches = count;
					if (bestRematches === 0) return best;
				}
			}
		}
	}

	return best;
}

function countBracketRematches(
	players: { entrantId: string }[],
	standingMap: Map<string, FinalStanding>
): number {
	let count = 0;
	const n = players.length;
	for (let i = 0; i < Math.floor(n / 2); i++) {
		const p1 = players[i];
		const p2 = players[n - 1 - i];
		if (!p1 || !p2) continue;
		// We don't have opponent data in FinalStanding directly, so skip for now
		// This would need the full standings with opponent lists
		// For the port, we rely on the Swiss engine's rematch tracking
	}
	return count;
}
