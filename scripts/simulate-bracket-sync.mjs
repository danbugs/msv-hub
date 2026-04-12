#!/usr/bin/env node
/**
 * Simulate the bracket sync logic end-to-end against real StartGG data.
 * Uses the exact grouping + normalization code from the production sync endpoint.
 *
 * Usage: node scripts/simulate-bracket-sync.mjs <bracketEventId> <swissPgId>
 */
import { readFileSync } from 'node:fs';
try {
	const env = readFileSync('.env', 'utf8');
	for (const line of env.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) process.env[m[1]] = m[2];
	}
} catch {}

const TOKEN = process.env.STARTGG_TOKEN;
const eventId = Number(process.argv[2]);
const swissPgId = Number(process.argv[3]);
if (!TOKEN || !eventId || !swissPgId) {
	console.error('Usage: node scripts/simulate-bracket-sync.mjs <bracketEventId> <swissPgId>');
	process.exit(1);
}

async function gql(query, variables) {
	const res = await fetch('https://api.start.gg/gql/alpha', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
		body: JSON.stringify({ query, variables })
	});
	const j = await res.json();
	return j.data;
}

// Fetch all sets
const allSets = [];
let page = 1;
while (true) {
	const d = await gql(`
		query($eventId: ID!, $page: Int!, $perPage: Int!) {
			event(id: $eventId) {
				sets(page: $page, perPage: $perPage, sortType: STANDARD) {
					pageInfo { totalPages }
					nodes {
						id identifier round fullRoundText winnerId displayScore
						slots { entrant { id participants { player { id gamerTag } } } }
					}
				}
			}
		}`, { eventId, page, perPage: 64 });
	const nodes = d?.event?.sets?.nodes ?? [];
	allSets.push(...nodes);
	const tp = d?.event?.sets?.pageInfo?.totalPages ?? 1;
	if (page >= tp) break;
	page++;
}

// Fetch Swiss seeds + bracket entrants for player ID mapping
const swissData = await gql(`query($pg:ID!){phaseGroup(id:$pg){seeds(query:{page:1,perPage:64}){nodes{id entrant{id participants{player{id}}}}}}}`, { pg: swissPgId });
const swissSeeds = swissData?.phaseGroup?.seeds?.nodes ?? [];
const bracketData = await gql(`query($e:ID!){event(id:$e){entrants(query:{page:1,perPage:64}){nodes{id participants{player{id gamerTag}}}}}}`, { e: eventId });
const bracketEntrants = bracketData?.event?.entrants?.nodes ?? [];

console.log(`Sets: ${allSets.length}, Swiss seeds: ${swissSeeds.length}, Bracket entrants: ${bracketEntrants.length}`);

// Build bracket entrant ID → player ID, and player → fake MSV Hub ID
// For simulation, we just use the player's gamerTag as the "MSV Hub ID"
const bracketEntrantToMsv = new Map();
for (const e of bracketEntrants) {
	const tag = e.participants?.[0]?.player?.gamerTag;
	if (tag) bracketEntrantToMsv.set(Number(e.id), tag);
}

// --- Now replicate the sync grouping logic ---
function bucketOf(s) {
	const text = String(s.fullRoundText ?? '');
	if (text === 'Grand Final Reset') return 'GFR';
	if (text === 'Grand Final') return 'GF';
	const r = Number(s.round);
	if (r > 0) return 'W';
	if (r < 0) return 'L';
	return null;
}

const wRounds = new Set();
const lRounds = new Set();
for (const s of allSets) {
	const b = bucketOf(s);
	const r = Number(s.round);
	if (b === 'W') wRounds.add(r);
	else if (b === 'L') lRounds.add(Math.abs(r));
}
const wMap = new Map();
[...wRounds].sort((a, b) => a - b).forEach((r, i) => wMap.set(r, i + 1));
const lMap = new Map();
[...lRounds].sort((a, b) => a - b).forEach((r, i) => lMap.set(r, i + 1));

console.log('W round mapping:', Object.fromEntries(wMap));
console.log('L round mapping:', Object.fromEntries(lMap));

const setsByKey = new Map();
for (const s of allSets) {
	const b = bucketOf(s);
	if (!b) continue;
	let key;
	if (b === 'GF' || b === 'GFR') key = b;
	else if (b === 'W') key = `W${wMap.get(Number(s.round))}`;
	else key = `L${lMap.get(Math.abs(Number(s.round)))}`;
	if (!setsByKey.has(key)) setsByKey.set(key, []);
	setsByKey.get(key).push(s);
}

// Simulate per-group alignment
const keys = [...setsByKey.keys()].sort((a, b) => {
	const order = (k) => k === 'GF' ? 1000 : k === 'GFR' ? 1001 : (k[0] === 'W' ? 0 : 500) + Number(k.slice(1));
	return order(a) - order(b);
});

let totalSynced = 0;
let totalReported = 0;

for (const key of keys) {
	const setsInGroup = setsByKey.get(key);
	const sorted = [...setsInGroup].sort((a, b) => {
		const ai = String(a.identifier ?? '');
		const bi = String(b.identifier ?? '');
		if (ai.length !== bi.length) return ai.length - bi.length;
		return ai.localeCompare(bi);
	});
	console.log(`\n─── ${key}: ${sorted.length} sets ───`);
	for (let i = 0; i < sorted.length; i++) {
		const s = sorted[i];
		const sgE1 = Number(s.slots[0]?.entrant?.id);
		const sgE2 = Number(s.slots[1]?.entrant?.id);
		const sgWin = Number(s.winnerId);
		const msvE1 = bracketEntrantToMsv.get(sgE1);
		const msvE2 = bracketEntrantToMsv.get(sgE2);
		const msvWin = sgWin ? bracketEntrantToMsv.get(sgWin) : undefined;
		const wouldSetWinner = msvWin && (msvWin === msvE1 || msvWin === msvE2);
		if (sgWin) totalReported++;
		if (wouldSetWinner) totalSynced++;
		const status = sgWin ? (wouldSetWinner ? '✓' : '✗ WINNER NOT MAPPED') : '(unreported)';
		console.log(`  [${i}] ${s.identifier.padEnd(3)} ${String(msvE1).padEnd(12)} vs ${String(msvE2).padEnd(12)} → winner ${msvWin || '-'} ${status}`);
	}
}

console.log(`\n=== Simulated: ${totalSynced}/${totalReported} matches would sync ===`);
