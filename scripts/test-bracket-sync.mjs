#!/usr/bin/env node
/**
 * Test bracket sync logic against a real StartGG event.
 *
 * Usage:
 *   node scripts/test-bracket-sync.mjs <eventId>
 *
 * Shows how StartGG sets would be grouped and aligned with MSV's match structure.
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
if (!TOKEN) { console.error('STARTGG_TOKEN required'); process.exit(1); }

const eventId = Number(process.argv[2]);
if (!eventId) { console.error('Usage: node scripts/test-bracket-sync.mjs <eventId>'); process.exit(1); }

// Fetch all sets in the event via GQL
const QUERY = `
query EventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { totalPages }
      nodes {
        id
        identifier
        round
        fullRoundText
        winnerId
        displayScore
        slots {
          entrant { id name participants { player { id gamerTag } } }
        }
      }
    }
  }
}`;

const allSets = [];
let page = 1;
while (true) {
	const res = await fetch('https://api.start.gg/gql/alpha', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ query: QUERY, variables: { eventId, page, perPage: 64 } })
	});
	const json = await res.json();
	const nodes = json?.data?.event?.sets?.nodes ?? [];
	allSets.push(...nodes);
	const totalPages = json?.data?.event?.sets?.pageInfo?.totalPages ?? 1;
	if (page >= totalPages) break;
	page++;
}

console.log(`\nEvent ${eventId}: ${allSets.length} sets total\n`);

// Group by bucket + round
function bucketOf(s) {
	const text = String(s.fullRoundText ?? '');
	if (text === 'Grand Final Reset') return 'GFR';
	if (text === 'Grand Final') return 'GF';
	const r = Number(s.round);
	if (r > 0) return 'W';
	if (r < 0) return 'L';
	return null;
}

const groups = new Map();
for (const s of allSets) {
	const b = bucketOf(s);
	if (!b) continue;
	const key = (b === 'GF' || b === 'GFR') ? b : `${b}${Math.abs(Number(s.round))}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(s);
}

// Print each group with its sets sorted by identifier
const ordered = [...groups.keys()].sort((a, b) => {
	// W rounds first, then L rounds, then GF, then GFR
	const order = (k) => {
		if (k === 'GF') return 1000;
		if (k === 'GFR') return 1001;
		const side = k[0]; const r = Number(k.slice(1));
		return side === 'W' ? r : 500 + r;
	};
	return order(a) - order(b);
});

for (const key of ordered) {
	const setsInGroup = groups.get(key);
	const sorted = [...setsInGroup].sort((a, b) => {
		const ai = String(a.identifier ?? '');
		const bi = String(b.identifier ?? '');
		if (ai.length !== bi.length) return ai.length - bi.length;
		return ai.localeCompare(bi);
	});
	console.log(`─── ${key} (${sorted.length} sets, fullRoundText: "${sorted[0]?.fullRoundText}") ───`);
	for (let i = 0; i < sorted.length; i++) {
		const s = sorted[i];
		const p1 = s.slots[0]?.entrant?.participants?.[0]?.player?.gamerTag ?? '?';
		const p2 = s.slots[1]?.entrant?.participants?.[0]?.player?.gamerTag ?? '?';
		const winId = s.winnerId;
		const p1Id = s.slots[0]?.entrant?.id;
		const p2Id = s.slots[1]?.entrant?.id;
		const winTag = winId === p1Id ? p1 : winId === p2Id ? p2 : '?';
		console.log(`  [${i}] ${s.identifier?.padEnd(3)} ${p1.padEnd(15)} vs ${p2.padEnd(15)} → ${winTag.padEnd(15)} ${winId ? '(' + s.displayScore + ')' : '(unreported)'}`);
	}
	console.log();
}
