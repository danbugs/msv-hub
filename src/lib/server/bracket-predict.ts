import {
	gql, TOURNAMENT_QUERY, PLAYER_RECENT_STANDINGS_QUERY, fetchAllSets, extractPlayerId, extractGamerTag
} from './startgg';

function getStandardBracketOrder(bracketSize: number): number[] {
	let positions = [0];
	for (let round = 1; round < bracketSize; round *= 2) {
		const next: number[] = [];
		for (const p of positions) {
			next.push(p);
			next.push(2 * round - 1 - p);
		}
		positions = next;
	}
	return positions;
}

export interface PredictedMatchup {
	seed1: number;
	seed2: number;
	tag1: string;
	tag2: string;
	playerId1?: number;
	playerId2?: number;
	round: string;
	bracket: 'winners' | 'losers';
}

/**
 * Simulate a DE bracket assuming seeds hold. Returns all predicted matchups.
 * Focuses on top `maxSeed` seeds for relevance.
 */
export function predictBracketMatchups(
	entrants: { seedNum: number; gamerTag: string; playerId?: number }[],
	maxSeed = 32
): PredictedMatchup[] {
	const n = entrants.length;
	if (n < 2) return [];
	const bracketSize = Math.pow(2, Math.ceil(Math.log2(n)));
	const order = getStandardBracketOrder(bracketSize);

	const sorted = [...entrants].sort((a, b) => a.seedNum - b.seedNum);

	// Build initial bracket slots: seed index → entrant (or null for BYE)
	type Slot = { seed: number; tag: string; playerId?: number } | null;
	const slots: Slot[] = order.map((idx) =>
		idx < sorted.length
			? { seed: sorted[idx].seedNum, tag: sorted[idx].gamerTag, playerId: sorted[idx].playerId }
			: null
	);

	const matchups: PredictedMatchup[] = [];
	const relevant = (s: Slot) => s !== null && s.seed <= maxSeed;

	// Simulate winners bracket
	let winnersRound = slots;
	let losersPool: Slot[] = [];
	let roundNum = 1;

	while (winnersRound.length >= 2) {
		const nextWinners: Slot[] = [];
		const roundLosers: Slot[] = [];
		const numMatches = winnersRound.length / 2;

		for (let i = 0; i < numMatches; i++) {
			const a = winnersRound[i * 2];
			const b = winnersRound[i * 2 + 1];

			if (a && b) {
				if (relevant(a) || relevant(b)) {
					const label = numMatches === 1 ? 'WF'
						: numMatches === 2 ? `WSF ${i + 1}`
						: `WR${roundNum} M${i + 1}`;
					matchups.push({
						seed1: a.seed, seed2: b.seed,
						tag1: a.tag, tag2: b.tag,
						playerId1: a.playerId, playerId2: b.playerId,
						round: label, bracket: 'winners'
					});
				}
				// Higher seed (lower number) wins
				const winner = a.seed < b.seed ? a : b;
				const loser = a.seed < b.seed ? b : a;
				nextWinners.push(winner);
				roundLosers.push(loser);
			} else {
				nextWinners.push(a ?? b);
				roundLosers.push(null);
			}
		}

		losersPool.push(...roundLosers);
		winnersRound = nextWinners;
		roundNum++;
	}

	// Simulate losers bracket
	// L1: pairs of WR1 losers (index 0+1, 2+3, etc.)
	const wr1Losers = losersPool.splice(0, Math.pow(2, Math.ceil(Math.log2(n))) / 2);
	let losersRound: Slot[] = [];

	// LR1: pair adjacent WR1 losers
	for (let i = 0; i < wr1Losers.length; i += 2) {
		const a = wr1Losers[i];
		const b = wr1Losers[i + 1] ?? null;
		if (a && b) {
			if (relevant(a) || relevant(b)) {
				matchups.push({
					seed1: a.seed, seed2: b.seed,
					tag1: a.tag, tag2: b.tag,
					playerId1: a.playerId, playerId2: b.playerId,
					round: `LR1 M${Math.floor(i / 2) + 1}`, bracket: 'losers'
				});
			}
			losersRound.push(a.seed < b.seed ? a : b);
		} else {
			losersRound.push(a ?? b);
		}
	}

	// Subsequent losers rounds alternate between:
	// Even LR: survivors face drop-ins from winners (reversed)
	// Odd LR: survivors face each other
	let lrNum = 2;
	let dropInIdx = 0;

	while (losersRound.length >= 2 || (losersPool.length > 0 && losersRound.length >= 1)) {
		const nextLosers: Slot[] = [];

		if (lrNum % 2 === 0 && dropInIdx < losersPool.length) {
			// Even LR: face winners drop-ins
			const dropIns = losersPool.slice(dropInIdx, dropInIdx + losersRound.length);
			dropInIdx += losersRound.length;
			const reversed = [...dropIns].reverse();

			for (let i = 0; i < losersRound.length; i++) {
				const a = losersRound[i];
				const b = reversed[i] ?? null;
				if (a && b) {
					if (relevant(a) || relevant(b)) {
						matchups.push({
							seed1: a.seed, seed2: b.seed,
							tag1: a.tag, tag2: b.tag,
							playerId1: a.playerId, playerId2: b.playerId,
							round: `LR${lrNum} M${i + 1}`, bracket: 'losers'
						});
					}
					nextLosers.push(a.seed < b.seed ? a : b);
				} else {
					nextLosers.push(a ?? b);
				}
			}
		} else {
			// Odd LR: pair up survivors
			for (let i = 0; i < losersRound.length; i += 2) {
				const a = losersRound[i];
				const b = losersRound[i + 1] ?? null;
				if (a && b) {
					if (relevant(a) || relevant(b)) {
						const label = losersRound.length === 2 ? `LSF ${Math.floor(i / 2) + 1}`
							: `LR${lrNum} M${Math.floor(i / 2) + 1}`;
						matchups.push({
							seed1: a.seed, seed2: b.seed,
							tag1: a.tag, tag2: b.tag,
							playerId1: a.playerId, playerId2: b.playerId,
							round: label, bracket: 'losers'
						});
					}
					nextLosers.push(a.seed < b.seed ? a : b);
				} else {
					nextLosers.push(a ?? b);
				}
			}
		}

		losersRound = nextLosers;
		lrNum++;
		if (losersRound.length <= 1 && dropInIdx >= losersPool.length) break;
	}

	// Grand finals: winners champion vs losers champion
	if (winnersRound.length === 1 && losersRound.length === 1) {
		const a = winnersRound[0];
		const b = losersRound[0];
		if (a && b && (relevant(a) || relevant(b))) {
			matchups.push({
				seed1: a.seed, seed2: b.seed,
				tag1: a.tag, tag2: b.tag,
				playerId1: a.playerId, playerId2: b.playerId,
				round: 'GF', bracket: 'winners'
			});
		}
	}

	return matchups;
}

function pairKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSetBasic(node: Record<string, any>, tournamentName: string): {
	p1: number; p2: number; tag1: string; tag2: string; event: string;
} | null {
	if (!node) return null;
	const displayScore: string = node.displayScore ?? '';
	if (displayScore.toUpperCase().includes('DQ')) return null;
	if (!node.winnerId) return null;
	const slots = node.slots ?? [];
	if (slots.length !== 2) return null;

	const players = slots.map((slot: { entrant?: { id?: number; participants?: { player?: { id?: number; gamerTag?: string } }[] } }) => {
		const entrant = slot.entrant;
		if (!entrant) return null;
		const playerId = extractPlayerId(entrant);
		if (playerId === null) return null;
		return { playerId, tag: extractGamerTag(entrant) };
	});

	if (!players[0] || !players[1]) return null;
	return {
		p1: players[0].playerId, p2: players[1].playerId,
		tag1: players[0].tag, tag2: players[1].tag,
		event: tournamentName
	};
}

export interface HistoricalMatch {
	player1Id: number;
	player2Id: number;
	tag1: string;
	tag2: string;
	event: string;
}

function addMatch(
	matches: Map<string, HistoricalMatch>,
	parsed: { p1: number; p2: number; tag1: string; tag2: string; event: string },
	playerIds: Set<number>
) {
	if (!playerIds.has(parsed.p1) && !playerIds.has(parsed.p2)) return;
	const key = pairKey(parsed.p1, parsed.p2);
	if (!matches.has(key)) {
		matches.set(key, {
			player1Id: Math.min(parsed.p1, parsed.p2),
			player2Id: Math.max(parsed.p1, parsed.p2),
			tag1: parsed.p1 < parsed.p2 ? parsed.tag1 : parsed.tag2,
			tag2: parsed.p1 < parsed.p2 ? parsed.tag2 : parsed.tag1,
			event: parsed.event
		});
	}
}

async function fetchSetsFromEvent(
	eventId: number, tournamentName: string,
	matches: Map<string, HistoricalMatch>, playerIds: Set<number>
) {
	const rawSets = await fetchAllSets(eventId);
	for (const raw of rawSets) {
		const parsed = parseSetBasic(raw, tournamentName);
		if (parsed) addMatch(matches, parsed, playerIds);
	}
}

interface StandingsResult {
	player: {
		id: number; gamerTag: string;
		recentStandings: {
			placement: number;
			entrant: { event: { id: number; numEntrants: number; isOnline: boolean; tournament: { name: string; startAt: number } } };
		}[];
	};
}

/**
 * Fetch recent matchups for a set of player IDs.
 * - Last ~1 month of MSV weeklies
 * - Last ~4 months of MSV macros (32+ entrants)
 * - Last ~4 months of external offline regionals (32+ entrants) discovered via top players' recent standings
 */
export async function fetchRecentMatchups(
	targetNumber: number,
	playerIds: Set<number>
): Promise<Map<string, HistoricalMatch>> {
	const matches = new Map<string, HistoricalMatch>();

	const fourMonthsAgo = Date.now() / 1000 - 4 * 30 * 86400;
	const oneMonthAgo = Date.now() / 1000 - 30 * 86400;

	// ── 1. MSV weeklies (last 4) ──
	const weeklyStart = Math.max(1, targetNumber - 4);
	const weeklySlugs: string[] = [];
	for (let n = weeklyStart; n < targetNumber; n++) {
		weeklySlugs.push(`microspacing-vancouver-${n}`);
	}

	// ── 2. MSV macros (last 10, filtered by date) ──
	const macroSlugs: string[] = [];
	for (let n = 1; n <= 10; n++) {
		macroSlugs.push(`macrospacing-vancouver-${n}`);
	}

	interface TournamentQueryResult { tournament: { id: number; name: string; startAt: number; events: { id: number; name: string; numEntrants: number }[] } | null }

	for (const slug of [...weeklySlugs, ...macroSlugs]) {
		const data = await gql<TournamentQueryResult>(TOURNAMENT_QUERY, { slug });
		if (!data?.tournament) continue;

		const startAt = data.tournament.startAt ?? 0;
		const isMacro = slug.startsWith('macro');

		if (isMacro) {
			if (startAt < fourMonthsAgo) continue;
			const hasLargeEvent = data.tournament.events?.some((e) => (e.numEntrants ?? 0) >= 32);
			if (!hasLargeEvent) continue;
		} else {
			if (startAt < oneMonthAgo) continue;
		}

		for (const event of data.tournament.events ?? []) {
			await fetchSetsFromEvent(event.id, data.tournament.name, matches, playerIds);
		}
	}

	// ── 3. External regionals: query top 16 players' recent standings ──
	const playerIdArr = [...playerIds].slice(0, 16);
	const seenEventIds = new Set<number>();
	const regionalEvents: { eventId: number; tournamentName: string }[] = [];

	for (const pid of playerIdArr) {
		const data = await gql<StandingsResult>(PLAYER_RECENT_STANDINGS_QUERY, { playerId: pid });
		if (!data?.player?.recentStandings) continue;

		for (const s of data.player.recentStandings) {
			const evt = s.entrant?.event;
			if (!evt) continue;
			if (seenEventIds.has(evt.id)) continue;

			const startAt = evt.tournament?.startAt ?? 0;
			if (startAt < fourMonthsAgo) continue;
			if ((evt.numEntrants ?? 0) < 32) continue;
			if (evt.isOnline) continue;

			const name = evt.tournament?.name ?? '';
			if (/microspacing|macrospacing/i.test(name)) continue;

			seenEventIds.add(evt.id);
			regionalEvents.push({ eventId: evt.id, tournamentName: name });
		}
	}

	for (const { eventId, tournamentName } of regionalEvents) {
		await fetchSetsFromEvent(eventId, tournamentName, matches, playerIds);
	}

	return matches;
}
