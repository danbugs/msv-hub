#!/usr/bin/env node
/**
 * Fetch matchup data for baseline-seeded players, detect collisions,
 * and output a fixed seeding that respects DE tier boundaries.
 */
import { readFileSync } from 'node:fs';

try {
	const env = readFileSync('.env', 'utf8');
	for (const line of env.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) process.env[m[1]] = m[2];
	}
} catch (e) { console.error('Failed to load .env:', e.message); process.exit(1); }

const TOKEN = process.env.STARTGG_TOKEN;
const GQL = 'https://api.start.gg/gql/alpha';

const BASELINE = [
	'Ouch!?', 'Boongly4', 'Vertigo', 'MOX', 'mr. money',
	'Bunky', 'Spikefire', 'Mossayef', 'GEEK', 'TetraTheThief',
	'RedX', 'Hahahahahahahahahahaha00', 'TG', 'Apex', 'Cash', 'noelle204',
	'kazuYoshi', 'SLett', 'skyes', 'Little Cheese', 'Dantotto', 'Jon Z',
	'alexasf', 'Car', 'Cooolth', 'Frog', 'Salade au Thon', 'Dreigon',
	'BIGTGDAIRFAN600', 'ImSoChove', 'KORCAmeep', 'Taima', 'BrenX1', 'Praxis',
	'bob', 'mellowo', 'Rautava', 'Kenshiro', 'Kyo', 'Kannyobi', 'redbebber',
	'Bon', 'WilloTillo', 'Nel', 'Ticolol', 'Momonokill', 'Jkami',
	'Joey Jojo Jr. Shabadoo', 'Ruby | SadEgg', 'MuteD', 'LeeWillin',
	'HunterBot', 'Xidrion', 'Bochito', 'jojo558', 'Theory', 'Aqwess',
	'Coppp89', 'CosmicTB', 'Binc', 'Aru', 'john larp', 'Luke', 'Dokiume'
];

const REGIONAL_PATTERNS = [
	/macro/i, /alpine arena/i, /peak pressure/i, /^out of pools/i,
	/^freestyle/i, /uvic.*monthly/i, /pataka/i
];
function isRegional(name) { return REGIONAL_PATTERNS.some(p => p.test(name)); }

async function gql(q, vars) {
	const r = await fetch(GQL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ query: q, variables: vars })
	});
	const j = await r.json();
	return j.data;
}

// Step 1: Look up player IDs from Macro 7
console.log('[1] Looking up player IDs...');
const tData = await gql(`query($slug: String!) {
	tournament(slug: $slug) {
		events { entrants(query: { perPage: 100 }) {
			nodes { participants { player { id gamerTag } } }
		} }
	}
}`, { slug: 'macrospacing-vancouver-7' });

const tagToId = new Map();
for (const evt of tData?.tournament?.events ?? []) {
	for (const ent of evt.entrants?.nodes ?? []) {
		const p = ent.participants?.[0]?.player;
		if (p?.id) tagToId.set(p.gamerTag.toLowerCase(), p.id);
	}
}

const entrants = BASELINE.map((tag, i) => ({
	seedNum: i + 1,
	gamerTag: tag,
	playerId: tagToId.get(tag.toLowerCase())
}));

const missing = entrants.filter(e => !e.playerId);
if (missing.length) console.log(`  Missing player IDs: ${missing.map(e => e.gamerTag).join(', ')}`);
console.log(`  Found ${entrants.length - missing.length}/${entrants.length} player IDs`);

// Step 2: Fetch recent matchups
console.log('\n[2] Scanning recent matchups (5-month window)...');
const SETS_QUERY = `query($playerId: ID!, $perPage: Int!, $page: Int!) {
	player(id: $playerId) {
		sets(perPage: $perPage, page: $page) {
			pageInfo { totalPages }
			nodes {
				displayScore winnerId
				event { tournament { name startAt } }
				slots { entrant { participants { player { id gamerTag } } } }
			}
		}
	}
}`;

const cutoff = Date.now() / 1000 - 5 * 30 * 86400;
const matches = new Map();
function pairKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

const playerIds = entrants.filter(e => e.playerId).map(e => e.playerId);
let scanned = 0;
for (const pid of playerIds) {
	let page = 1, totalPages = 1, reachedCutoff = false;
	while (page <= totalPages && page <= 3 && !reachedCutoff) {
		const data = await gql(SETS_QUERY, { playerId: pid, perPage: 50, page });
		if (!data?.player?.sets?.nodes) break;
		totalPages = data.player.sets.pageInfo?.totalPages ?? 1;

		for (const set of data.player.sets.nodes) {
			const startAt = set.event?.tournament?.startAt ?? 0;
			if (startAt > 0 && startAt < cutoff) { reachedCutoff = true; continue; }
			const ds = set.displayScore ?? '';
			if (ds.toUpperCase().includes('DQ') || !set.winnerId) continue;
			const slots = set.slots ?? [];
			if (slots.length !== 2) continue;
			const players = slots.map(s => {
				const p = s.entrant?.participants?.[0]?.player;
				return p?.id ? { id: p.id, tag: p.gamerTag } : null;
			});
			if (!players[0] || !players[1]) continue;

			const key = pairKey(players[0].id, players[1].id);
			const eventName = set.event?.tournament?.name ?? 'Unknown';
			const regional = isRegional(eventName);
			const existing = matches.get(key);
			if (!existing) {
				matches.set(key, {
					player1Id: Math.min(players[0].id, players[1].id),
					player2Id: Math.max(players[0].id, players[1].id),
					tag1: players[0].id < players[1].id ? players[0].tag : players[1].tag,
					tag2: players[0].id < players[1].id ? players[1].tag : players[0].tag,
					event: eventName, startAt, count: 1, isRegional: regional
				});
			} else {
				existing.count++;
				if (regional) existing.isRegional = true;
				if (startAt > existing.startAt) {
					existing.event = eventName;
					existing.startAt = startAt;
				}
			}
		}
		page++;
		await new Promise(r => setTimeout(r, 350));
	}
	scanned++;
	if (scanned % 10 === 0) process.stdout.write(`  ${scanned}/${playerIds.length}\n`);
}
console.log(`  Scanned ${scanned} players, found ${matches.size} matchup pairs`);

// Step 3: Predict bracket matchups and find collisions
function getStandardBracketOrder(bracketSize) {
	let positions = [0];
	for (let round = 1; round < bracketSize; round *= 2) {
		const next = [];
		for (const p of positions) { next.push(p); next.push(2 * round - 1 - p); }
		positions = next;
	}
	return positions;
}

function predictMatchups(ents) {
	const n = ents.length;
	if (n < 2) return [];
	const bracketSize = Math.pow(2, Math.ceil(Math.log2(n)));
	const order = getStandardBracketOrder(bracketSize);
	const sorted = [...ents].sort((a, b) => a.seedNum - b.seedNum);
	const slots = order.map(idx => idx < sorted.length ? sorted[idx] : null);
	const matchups = [];

	let winnersRound = slots;
	let losersPool = [];
	let roundNum = 1;

	while (winnersRound.length >= 2) {
		const nextWinners = [];
		const roundLosers = [];
		const numMatches = winnersRound.length / 2;
		for (let i = 0; i < numMatches; i++) {
			const a = winnersRound[i * 2];
			const b = winnersRound[i * 2 + 1];
			if (a && b) {
				const label = numMatches === 1 ? 'WF' : numMatches === 2 ? `WSF ${i+1}` : `WR${roundNum} M${i+1}`;
				matchups.push({ seed1: a.seedNum, seed2: b.seedNum, tag1: a.gamerTag, tag2: b.gamerTag, playerId1: a.playerId, playerId2: b.playerId, round: label, bracket: 'winners' });
				const winner = a.seedNum < b.seedNum ? a : b;
				const loser = a.seedNum < b.seedNum ? b : a;
				nextWinners.push(winner);
				roundLosers.push(loser);
			} else { nextWinners.push(a ?? b); roundLosers.push(null); }
		}
		losersPool.push(...roundLosers);
		winnersRound = nextWinners;
		roundNum++;
	}

	const wr1Losers = losersPool.splice(0, bracketSize / 2);
	let losersRound = [];
	for (let i = 0; i < wr1Losers.length; i += 2) {
		const a = wr1Losers[i], b = wr1Losers[i + 1] ?? null;
		if (a && b) {
			matchups.push({ seed1: a.seedNum, seed2: b.seedNum, tag1: a.gamerTag, tag2: b.gamerTag, playerId1: a.playerId, playerId2: b.playerId, round: `LR1 M${Math.floor(i/2)+1}`, bracket: 'losers' });
			losersRound.push(a.seedNum < b.seedNum ? a : b);
		} else { losersRound.push(a ?? b); }
	}

	let lrNum = 2, dropInIdx = 0;
	while (losersRound.length >= 2 || (losersPool.length > 0 && losersRound.length >= 1)) {
		const nextLosers = [];
		if (lrNum % 2 === 0 && dropInIdx < losersPool.length) {
			const dropIns = losersPool.slice(dropInIdx, dropInIdx + losersRound.length);
			dropInIdx += losersRound.length;
			let ordered;
			const n = dropIns.length;
			if (n >= 16) {
				ordered = [...dropIns].reverse();
			} else if (n >= 8) {
				const half = Math.floor(n / 2);
				ordered = [...dropIns.slice(0, half).reverse(), ...dropIns.slice(half).reverse()];
			} else {
				const half = Math.floor(n / 2);
				ordered = [...dropIns.slice(half), ...dropIns.slice(0, half)];
			}
			for (let i = 0; i < losersRound.length; i++) {
				const a = losersRound[i], b = ordered[i] ?? null;
				if (a && b) {
					matchups.push({ seed1: a.seedNum, seed2: b.seedNum, tag1: a.gamerTag, tag2: b.gamerTag, playerId1: a.playerId, playerId2: b.playerId, round: `LR${lrNum} M${i+1}`, bracket: 'losers' });
					nextLosers.push(a.seedNum < b.seedNum ? a : b);
				} else { nextLosers.push(a ?? b); }
			}
		} else {
			for (let i = 0; i < losersRound.length; i += 2) {
				const a = losersRound[i], b = losersRound[i + 1] ?? null;
				if (a && b) {
					const label = losersRound.length === 2 ? `LSF ${Math.floor(i/2)+1}` : `LR${lrNum} M${Math.floor(i/2)+1}`;
					matchups.push({ seed1: a.seedNum, seed2: b.seedNum, tag1: a.gamerTag, tag2: b.gamerTag, playerId1: a.playerId, playerId2: b.playerId, round: label, bracket: 'losers' });
					nextLosers.push(a.seedNum < b.seedNum ? a : b);
				} else { nextLosers.push(a ?? b); }
			}
		}
		losersRound = nextLosers;
		lrNum++;
		if (losersRound.length <= 1 && dropInIdx >= losersPool.length) break;
	}

	if (winnersRound.length === 1 && losersRound.length === 1) {
		const a = winnersRound[0], b = losersRound[0];
		if (a && b) matchups.push({ seed1: a.seedNum, seed2: b.seedNum, tag1: a.gamerTag, tag2: b.gamerTag, playerId1: a.playerId, playerId2: b.playerId, round: 'GF', bracket: 'winners' });
	}
	return matchups;
}

function maxSwapDist(seedNum) {
	if (seedNum <= 2) return 1;
	if (seedNum <= 4) return 1;
	if (seedNum <= 8) return 2;
	if (seedNum <= 16) return 3;
	if (seedNum <= 32) return 4;
	return 6;
}

function findCollisions(ents) {
	const allPids = new Set(ents.filter(e => e.playerId).map(e => e.playerId));
	return predictMatchups(ents).filter(m =>
		m.playerId1 && m.playerId2 &&
		allPids.has(m.playerId1) && allPids.has(m.playerId2) &&
		matches.has(pairKey(m.playerId1, m.playerId2))
	).map(m => {
		const h = matches.get(pairKey(m.playerId1, m.playerId2));
		return { ...m, count: h?.count ?? 1, isRegional: h?.isRegional ?? false, event: h?.event ?? '' };
	});
}

function collisionPriority(match) {
	let score = match.count * 10;
	const daysAgo = Math.max(0, (Date.now() / 1000 - match.startAt) / 86400);
	score += Math.max(0, 8 - daysAgo) * 2;
	if (match.isRegional) score += 50;
	return score;
}

// Step 4: Resolve collisions
console.log('\n[3] Checking collisions with baseline seeding...');
let collisions = findCollisions(entrants);
console.log(`  Found ${collisions.length} collisions:`);
for (const c of collisions) {
	const tags = [];
	if (c.isRegional) tags.push('regional');
	if (c.count > 1) tags.push(`${c.count}x`);
	console.log(`  ${c.round}: ${c.tag1} (${c.seed1}) vs ${c.tag2} (${c.seed2}) ${tags.length ? `[${tags.join(', ')}]` : ''} @ ${c.event}`);
}

function weightedScore(cols) {
	let score = 0;
	for (const c of cols) {
		const h = matches.get(pairKey(c.playerId1, c.playerId2));
		score += h?.isRegional ? 100 : 1;
	}
	return score;
}

console.log('\n[4] Resolving collisions (tier-respecting swaps, regionals get wider range)...');
const fixed = entrants.map(e => ({ ...e }));
const origIdx = new Map();
fixed.forEach((e, i) => origIdx.set(e.gamerTag, i));
const swaps = [];

for (let attempt = 0; attempt < 40; attempt++) {
	fixed.forEach((e, i) => e.seedNum = i + 1);
	const cols = findCollisions(fixed);
	if (cols.length === 0) break;

	cols.sort((a, b) => {
		const ma = matches.get(pairKey(a.playerId1, a.playerId2));
		const mb = matches.get(pairKey(b.playerId1, b.playerId2));
		return (mb ? collisionPriority(mb) : 0) - (ma ? collisionPriority(ma) : 0);
	});

	const curScore = weightedScore(cols);
	let resolved = false;
	for (const c of cols) {
		const match = matches.get(pairKey(c.playerId1, c.playerId2));
		const isReg = match?.isRegional ?? false;
		const distMult = isReg ? 2 : 1;
		const idxA = fixed.findIndex(e => e.playerId === c.playerId1);
		const idxB = fixed.findIndex(e => e.playerId === c.playerId2);
		if (idxA === -1 || idxB === -1) continue;

		for (const swapFrom of [Math.max(idxA, idxB), Math.min(idxA, idxB)]) {
			const other = swapFrom === idxA ? idxB : idxA;
			const dist = maxSwapDist(swapFrom + 1) * distMult;
			let bestTo = -1, bestScore = curScore;

			const lo = Math.max(0, swapFrom - dist);
			const hi = Math.min(fixed.length - 1, swapFrom + dist);
			for (let to = lo; to <= hi; to++) {
				if (to === swapFrom || to === other) continue;
				const oA = origIdx.get(fixed[swapFrom].gamerTag);
				const oB = origIdx.get(fixed[to].gamerTag);
				if (Math.abs(to - oA) > maxSwapDist(oA + 1) * distMult) continue;
				if (Math.abs(swapFrom - oB) > maxSwapDist(oB + 1) * distMult) continue;

				[fixed[swapFrom], fixed[to]] = [fixed[to], fixed[swapFrom]];
				fixed.forEach((e, i) => e.seedNum = i + 1);
				const newCols = findCollisions(fixed);
				const s = weightedScore(newCols);
				[fixed[swapFrom], fixed[to]] = [fixed[to], fixed[swapFrom]];
				fixed.forEach((e, i) => e.seedNum = i + 1);
				if (s < bestScore || (s === bestScore && bestTo !== -1 && Math.abs(to - swapFrom) < Math.abs(bestTo - swapFrom))) {
					bestScore = s; bestTo = to;
				}
			}

			if (bestTo !== -1 && bestScore < curScore) {
				const parts = [];
				if (match?.isRegional) parts.push('regional');
				if (match?.count > 1) parts.push(`${match.count}x`);
				const daysAgo = match ? Math.round((Date.now()/1000 - match.startAt)/86400) : 0;
				if (daysAgo <= 7) parts.push('last week');
				else if (daysAgo <= 14) parts.push('2w ago');
				else parts.push(`${Math.round(daysAgo/7)}w ago`);

				console.log(`  Swap: Seed ${fixed[swapFrom].seedNum} ${fixed[swapFrom].gamerTag} ↔ Seed ${fixed[bestTo].seedNum} ${fixed[bestTo].gamerTag} (${parts.join(', ')})`);
				swaps.push({ from: fixed[swapFrom].gamerTag, to: fixed[bestTo].gamerTag });
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

fixed.forEach((e, i) => e.seedNum = i + 1);
const remaining = findCollisions(fixed);

console.log(`\n[5] Result: ${swaps.length} swaps, ${remaining.length} remaining collisions`);
if (remaining.length) {
	console.log('  Remaining (unfixable within tier limits):');
	for (const c of remaining) {
		const tags = [];
		if (c.isRegional) tags.push('regional');
		if (c.count > 1) tags.push(`${c.count}x`);
		console.log(`  ${c.round}: ${c.tag1} (${c.seed1}) vs ${c.tag2} (${c.seed2}) ${tags.length ? `[${tags.join(', ')}]` : ''} @ ${c.event}`);
	}
}

console.log('\n[6] Fixed seeding order:');
for (const e of fixed) {
	const orig = origIdx.get(e.gamerTag) + 1;
	const moved = orig !== e.seedNum ? ` (was ${orig})` : '';
	console.log(`  ${e.seedNum}. ${e.gamerTag}${moved}`);
}

console.log('\n[7] BASELINE_SEEDS array for apply-baseline-seeds.mjs:');
console.log('const BASELINE_SEEDS = [');
for (const e of fixed) {
	console.log(`\t[${e.seedNum}, '${e.gamerTag.replace(/'/g, "\\'")}'],`);
}
console.log('];');
