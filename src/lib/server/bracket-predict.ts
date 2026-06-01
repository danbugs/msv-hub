import {
	gql, extractPlayerId, extractGamerTag
} from './startgg';
import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';

const MATCHUP_CACHE_KEY = 'matchups:recent:v8';
const MATCHUP_CACHE_TTL = 6 * 60 * 60;
const SCAN_DELAY = 400;

const PLAYER_SETS_QUERY = `
query PlayerRecentSets($playerId: ID!, $perPage: Int!, $page: Int!) {
  player(id: $playerId) {
    id
    gamerTag
    sets(perPage: $perPage, page: $page) {
      pageInfo { totalPages }
      nodes {
        displayScore
        winnerId
        event { tournament { name startAt } }
        slots {
          entrant {
            participants { player { id gamerTag } }
          }
        }
      }
    }
  }
}`;

function tryGetRedis(): Redis | null {
	try {
		const url = env.UPSTASH_REDIS_REST_URL;
		const token = env.UPSTASH_REDIS_REST_TOKEN;
		if (!url || !token) return null;
		return new Redis({ url, token });
	} catch { return null; }
}

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

export function predictBracketMatchups(
	entrants: { seedNum: number; gamerTag: string; playerId?: number }[]
): PredictedMatchup[] {
	const n = entrants.length;
	if (n < 2) return [];
	const bracketSize = Math.pow(2, Math.ceil(Math.log2(n)));
	const order = getStandardBracketOrder(bracketSize);

	const sorted = [...entrants].sort((a, b) => a.seedNum - b.seedNum);

	type Slot = { seed: number; tag: string; playerId?: number } | null;
	const slots: Slot[] = order.map((idx) =>
		idx < sorted.length
			? { seed: sorted[idx].seedNum, tag: sorted[idx].gamerTag, playerId: sorted[idx].playerId }
			: null
	);

	const matchups: PredictedMatchup[] = [];

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
				const label = numMatches === 1 ? 'WF'
					: numMatches === 2 ? `WSF ${i + 1}`
					: `WR${roundNum} M${i + 1}`;
				matchups.push({
					seed1: a.seed, seed2: b.seed,
					tag1: a.tag, tag2: b.tag,
					playerId1: a.playerId, playerId2: b.playerId,
					round: label, bracket: 'winners'
				});
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

	const wr1Losers = losersPool.splice(0, Math.pow(2, Math.ceil(Math.log2(n))) / 2);
	let losersRound: Slot[] = [];

	for (let i = 0; i < wr1Losers.length; i += 2) {
		const a = wr1Losers[i];
		const b = wr1Losers[i + 1] ?? null;
		if (a && b) {
			matchups.push({
				seed1: a.seed, seed2: b.seed,
				tag1: a.tag, tag2: b.tag,
				playerId1: a.playerId, playerId2: b.playerId,
				round: `LR1 M${Math.floor(i / 2) + 1}`, bracket: 'losers'
			});
			losersRound.push(a.seed < b.seed ? a : b);
		} else {
			losersRound.push(a ?? b);
		}
	}

	let lrNum = 2;
	let dropInIdx = 0;

	while (losersRound.length >= 2 || (losersPool.length > 0 && losersRound.length >= 1)) {
		const nextLosers: Slot[] = [];

		if (lrNum % 2 === 0 && dropInIdx < losersPool.length) {
			const dropIns = losersPool.slice(dropInIdx, dropInIdx + losersRound.length);
			dropInIdx += losersRound.length;
			const dropNumber = lrNum / 2;
			const ordered = dropNumber % 2 === 1 ? [...dropIns].reverse() : dropIns;

			for (let i = 0; i < losersRound.length; i++) {
				const a = losersRound[i];
				const b = ordered[i] ?? null;
				if (a && b) {
					matchups.push({
						seed1: a.seed, seed2: b.seed,
						tag1: a.tag, tag2: b.tag,
						playerId1: a.playerId, playerId2: b.playerId,
						round: `LR${lrNum} M${i + 1}`, bracket: 'losers'
					});
					nextLosers.push(a.seed < b.seed ? a : b);
				} else {
					nextLosers.push(a ?? b);
				}
			}
		} else {
			for (let i = 0; i < losersRound.length; i += 2) {
				const a = losersRound[i];
				const b = losersRound[i + 1] ?? null;
				if (a && b) {
					const label = losersRound.length === 2 ? `LSF ${Math.floor(i / 2) + 1}`
						: `LR${lrNum} M${Math.floor(i / 2) + 1}`;
					matchups.push({
						seed1: a.seed, seed2: b.seed,
						tag1: a.tag, tag2: b.tag,
						playerId1: a.playerId, playerId2: b.playerId,
						round: label, bracket: 'losers'
					});
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

	if (winnersRound.length === 1 && losersRound.length === 1) {
		const a = winnersRound[0];
		const b = losersRound[0];
		if (a && b) {
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

// Max drift from original seed, aligned with DE placement tiers (powers of 2).
function maxSwapDist(seedNum: number): number {
	if (seedNum <= 2) return 1;
	if (seedNum <= 4) return 1;
	if (seedNum <= 8) return 2;
	if (seedNum <= 16) return 3;
	if (seedNum <= 32) return 4;
	return 6;
}

export function resolveCollisions(
	entrants: { seedNum: number; gamerTag: string; playerId?: number }[],
	recentMatches: Map<string, HistoricalMatch>
): { fixed: { seedNum: number; gamerTag: string; playerId?: number }[]; swaps: { from: string; to: string; fromSeed: number; toSeed: number }[] } {
	const fixed = entrants.map(e => ({ ...e }));
	const swaps: { from: string; to: string; fromSeed: number; toSeed: number }[] = [];

	// Track each player's original index so cascading swaps can't drift them too far.
	const origIdx = new Map<string, number>();
	fixed.forEach((e, i) => origIdx.set(e.gamerTag, i));

	for (let attempt = 0; attempt < 20; attempt++) {
		fixed.forEach((e, i) => e.seedNum = i + 1);
		const matchups = predictBracketMatchups(fixed);
		const collisions = matchups.filter(m =>
			m.playerId1 && m.playerId2 && recentMatches.has(pairKey(m.playerId1, m.playerId2))
		);
		if (collisions.length === 0) break;

		collisions.sort((a, b) => {
			const ma = recentMatches.get(pairKey(a.playerId1!, a.playerId2!));
			const mb = recentMatches.get(pairKey(b.playerId1!, b.playerId2!));
			return (mb ? collisionPriority(mb) : 0) - (ma ? collisionPriority(ma) : 0);
		});

		let resolved = false;
		for (const c of collisions) {
			const idxA = fixed.findIndex(e => e.playerId === c.playerId1);
			const idxB = fixed.findIndex(e => e.playerId === c.playerId2);
			if (idxA === -1 || idxB === -1) continue;

			for (const swapFrom of [Math.max(idxA, idxB), Math.min(idxA, idxB)]) {
				const other = swapFrom === idxA ? idxB : idxA;
				const dist = maxSwapDist(swapFrom + 1);
				let bestTo = -1;
				let bestCount = collisions.length;

				const lo = Math.max(0, swapFrom - dist);
				const hi = Math.min(fixed.length - 1, swapFrom + dist);
				for (let to = lo; to <= hi; to++) {
					if (to === swapFrom || to === other) continue;
					// Check that neither player would drift beyond their tier's max from original seed.
					const origA = origIdx.get(fixed[swapFrom].gamerTag)!;
					const origB = origIdx.get(fixed[to].gamerTag)!;
					if (Math.abs(to - origA) > maxSwapDist(origA + 1)) continue;
					if (Math.abs(swapFrom - origB) > maxSwapDist(origB + 1)) continue;

					[fixed[swapFrom], fixed[to]] = [fixed[to], fixed[swapFrom]];
					fixed.forEach((e, i) => e.seedNum = i + 1);
					const cnt = predictBracketMatchups(fixed).filter(m =>
						m.playerId1 && m.playerId2 && recentMatches.has(pairKey(m.playerId1, m.playerId2))
					).length;
					[fixed[swapFrom], fixed[to]] = [fixed[to], fixed[swapFrom]];
					fixed.forEach((e, i) => e.seedNum = i + 1);
					if (cnt < bestCount || (cnt === bestCount && bestTo !== -1 && Math.abs(to - swapFrom) < Math.abs(bestTo - swapFrom))) {
						bestCount = cnt;
						bestTo = to;
					}
				}

				if (bestTo !== -1 && bestCount < collisions.length) {
					swaps.push({
						from: fixed[swapFrom].gamerTag, to: fixed[bestTo].gamerTag,
						fromSeed: fixed[swapFrom].seedNum, toSeed: fixed[bestTo].seedNum
					});
					[fixed[swapFrom], fixed[bestTo]] = [fixed[bestTo], fixed[swapFrom]];
					fixed.forEach((e, i) => e.seedNum = i + 1);
					resolved = true;
					break;
				}
			}
			if (resolved) break;
		}
		if (!resolved) break;
	}

	return { fixed, swaps };
}

export interface HistoricalMatch {
	player1Id: number;
	player2Id: number;
	tag1: string;
	tag2: string;
	event: string;
	startAt: number;
	count: number;
	isRegional: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePlayerSet(node: Record<string, any>): {
	p1: number; p2: number; tag1: string; tag2: string; event: string; startAt: number;
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
		event: node.event?.tournament?.name ?? 'Unknown',
		startAt: node.event?.tournament?.startAt ?? 0
	};
}

const REGIONAL_PATTERNS = [
	/macro/i, /alpine arena/i, /peak pressure/i, /out of pools/i
];

function isRegionalEvent(name: string): boolean {
	return REGIONAL_PATTERNS.some(p => p.test(name));
}

function collisionPriority(match: HistoricalMatch): number {
	let score = match.count * 10;
	const now = Date.now() / 1000;
	const daysAgo = Math.max(0, (now - match.startAt) / 86400);
	score += Math.max(0, 8 - daysAgo) * 2;
	if (match.isRegional) score += 50;
	return score;
}

async function computeRecentMatchups(
	playerIds: number[]
): Promise<Map<string, HistoricalMatch>> {
	const matches = new Map<string, HistoricalMatch>();
	const twoMonthsAgo = Date.now() / 1000 - 2 * 30 * 86400;

	for (const pid of playerIds) {
		let page = 1;
		let totalPages = 1;
		let reachedCutoff = false;

		while (page <= totalPages && page <= 3 && !reachedCutoff) {
			const data = await gql<{
				player: { sets: { pageInfo: { totalPages: number }; nodes: Record<string, unknown>[] } } | null
			}>(PLAYER_SETS_QUERY, { playerId: pid, perPage: 50, page }, { delay: SCAN_DELAY });

			if (!data?.player?.sets?.nodes) break;
			totalPages = data.player.sets.pageInfo?.totalPages ?? 1;

			for (const setNode of data.player.sets.nodes) {
				const sn = setNode as Record<string, unknown>;
				const startAt = ((sn.event as Record<string, unknown> | undefined)?.tournament as Record<string, unknown> | undefined)?.startAt as number | undefined ?? 0;
				if (startAt > 0 && startAt < twoMonthsAgo) {
					reachedCutoff = true;
					continue;
				}

				const parsed = parsePlayerSet(sn);
				if (!parsed) continue;

				const key = pairKey(parsed.p1, parsed.p2);
				const existing = matches.get(key);
				const regional = isRegionalEvent(parsed.event);
				if (!existing) {
					matches.set(key, {
						player1Id: Math.min(parsed.p1, parsed.p2),
						player2Id: Math.max(parsed.p1, parsed.p2),
						tag1: parsed.p1 < parsed.p2 ? parsed.tag1 : parsed.tag2,
						tag2: parsed.p1 < parsed.p2 ? parsed.tag2 : parsed.tag1,
						event: parsed.event,
						startAt: parsed.startAt,
						count: 1,
						isRegional: regional
					});
				} else {
					existing.count++;
					if (regional) existing.isRegional = true;
					if (parsed.startAt > existing.startAt) {
						existing.event = parsed.event;
						existing.startAt = parsed.startAt;
						existing.tag1 = parsed.p1 < parsed.p2 ? parsed.tag1 : parsed.tag2;
						existing.tag2 = parsed.p1 < parsed.p2 ? parsed.tag2 : parsed.tag1;
					}
				}
			}

			page++;
		}
	}

	return matches;
}

export async function fetchRecentMatchups(
	entrants: { seedNum: number; playerId?: number }[]
): Promise<Map<string, HistoricalMatch>> {
	const allPlayerIds = new Set(
		entrants.map(e => e.playerId).filter((id): id is number => id != null)
	);
	const redis = tryGetRedis();

	// Try Redis cache (avoids ~50s StartGG scan on repeat calls)
	if (redis) {
		try {
			const cached = await redis.get<[string, HistoricalMatch][]>(MATCHUP_CACHE_KEY);
			if (cached) {
				const filtered = new Map<string, HistoricalMatch>();
				for (const [key, match] of cached) {
					if (allPlayerIds.has(match.player1Id) || allPlayerIds.has(match.player2Id)) {
						filtered.set(key, match);
					}
				}
				return filtered;
			}
		} catch { /* proceed to compute */ }
	}

	// Query all players' recent sets — covers MSV, Tempo, SFU, UBC, KPU, regionals, etc.
	const idsToQuery = entrants
		.filter(e => e.playerId != null)
		.sort((a, b) => a.seedNum - b.seedNum)
		.map(e => e.playerId!);
	const all = await computeRecentMatchups(idsToQuery);

	if (redis) {
		try {
			await redis.set(MATCHUP_CACHE_KEY, [...all.entries()], { ex: MATCHUP_CACHE_TTL });
		} catch { /* cache write failed */ }
	}

	const filtered = new Map<string, HistoricalMatch>();
	for (const [key, match] of all) {
		if (allPlayerIds.has(match.player1Id) || allPlayerIds.has(match.player2Id)) {
			filtered.set(key, match);
		}
	}
	return filtered;
}
