#!/usr/bin/env npx tsx
/**
 * Interactive StartGG test harness.
 *
 * Usage:
 *   npx tsx scripts/startgg-test-harness.ts <phaseGroupId>
 *
 * Steps:
 *   1. Pulls all set IDs + entrant names in the phase group
 *   2. Lets you pick a set and report it
 *   3. Tries to report the same set again (should fail)
 *   4. Pulls all set IDs again (shows updated state)
 *   5. Tries to report again
 *
 * Requires STARTGG_TOKEN in ../.env
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ── Load .env ──
const envPath = path.resolve(import.meta.dirname ?? __dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
	const match = line.match(/^([A-Z_]+)=(.*)$/);
	if (match) process.env[match[1]] = match[2];
}

const TOKEN = process.env.STARTGG_TOKEN;
if (!TOKEN) { console.error('STARTGG_TOKEN not found in .env'); process.exit(1); }

const API = 'https://api.start.gg/gql/alpha';

// ── GraphQL helpers ──

async function gql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>): Promise<T | null> {
	const res = await fetch(API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ query, variables })
	});
	if (res.status === 429) {
		console.log('⚠ Rate limited, waiting 10s...');
		await new Promise(r => setTimeout(r, 10000));
		return gql(query, variables);
	}
	const json = await res.json();
	if (json.errors?.length) {
		console.error('GraphQL errors:', json.errors.map((e: { message: string }) => e.message).join('; '));
		return null;
	}
	return json.data as T;
}

// ── Queries ──

const SETS_QUERY = `
query PhaseGroupSets($pgId: ID!) {
  phaseGroup(id: $pgId) {
    sets(page: 1, perPage: 64, sortType: STANDARD) {
      nodes {
        id
        fullRoundText
        winnerId
        slots {
          entrant { id name }
        }
      }
    }
  }
}`;

const REPORT_MUTATION = `
mutation ReportSet($setId: ID!, $winnerId: Int!, $isDQ: Boolean, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, isDQ: $isDQ, gameData: $gameData) {
    id
    state
  }
}`;

const RESET_MUTATION = `
mutation ResetSet($setId: ID!) {
  resetSet(setId: $setId) { id }
}`;

// ── Types ──

interface SetNode {
	id: number | string;
	fullRoundText: string | null;
	winnerId: number | null;
	slots: { entrant: { id: number; name: string } | null }[];
}

// ── Readline ──

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

// ── Main ──

async function fetchSets(pgId: number): Promise<SetNode[]> {
	const data = await gql<{ phaseGroup: { sets: { nodes: SetNode[] } } }>(SETS_QUERY, { pgId });
	return data?.phaseGroup?.sets?.nodes ?? [];
}

function printSets(sets: SetNode[]) {
	console.log(`\n${'─'.repeat(80)}`);
	console.log(`  #  │ Set ID            │ Status     │ Match`);
	console.log(`${'─'.repeat(80)}`);
	for (let i = 0; i < sets.length; i++) {
		const s = sets[i];
		const p1 = s.slots[0]?.entrant?.name ?? '???';
		const p2 = s.slots[1]?.entrant?.name ?? '???';
		const status = s.winnerId ? `✓ done` : 'open  ';
		const winner = s.winnerId
			? ` → ${s.slots.find(sl => sl.entrant?.id === s.winnerId)?.entrant?.name ?? '?'}`
			: '';
		console.log(`  ${String(i + 1).padStart(2)} │ ${String(s.id).padStart(17)} │ ${status} │ ${p1} vs ${p2}${winner}`);
	}
	console.log(`${'─'.repeat(80)}\n`);
}

async function reportSet(setId: string | number, winnerId: number, winnerScore: number, loserScore: number): Promise<boolean> {
	console.log(`\n→ Reporting set ${setId}: winner=${winnerId}, score=${winnerScore}-${loserScore}`);
	const data = await gql(REPORT_MUTATION, {
		setId: String(setId),
		winnerId,
		isDQ: false,
		gameData: [
			{ winnerId, gameNum: 1 },
			{ winnerId, gameNum: 2 },
			...(loserScore >= 1 ? [{ winnerId, gameNum: 3 }] : [])
		]
	});
	if (data) {
		console.log('  ✓ Report succeeded:', JSON.stringify(data));
		return true;
	}
	console.log('  ✗ Report FAILED (see errors above)');
	return false;
}

async function resetSet(setId: string | number): Promise<boolean> {
	console.log(`\n→ Resetting set ${setId}...`);
	const data = await gql(RESET_MUTATION, { setId: String(setId) });
	if (data) {
		console.log('  ✓ Reset succeeded');
		return true;
	}
	console.log('  ✗ Reset FAILED');
	return false;
}

async function main() {
	const pgId = Number(process.argv[2]);
	if (!pgId) {
		console.error('Usage: npx tsx scripts/startgg-test-harness.ts <phaseGroupId>');
		console.error('  e.g. npx tsx scripts/startgg-test-harness.ts 3251998');
		process.exit(1);
	}

	console.log(`\n╔══════════════════════════════════════════════════╗`);
	console.log(`║  StartGG Test Harness — Phase Group ${pgId}  ║`);
	console.log(`╚══════════════════════════════════════════════════╝`);

	// ── Step 1: Pull all sets ──
	console.log('\n[Step 1] Fetching all sets...');
	let sets = await fetchSets(pgId);
	if (!sets.length) { console.error('No sets found!'); process.exit(1); }
	printSets(sets);

	// ── Step 2: Pick a set to report ──
	const openSets = sets.filter(s => !s.winnerId);
	if (openSets.length === 0) {
		console.log('All sets are already reported. Pick one to reset first?');
		const resetIdx = await ask('Enter set # to reset (or "skip"): ');
		if (resetIdx !== 'skip') {
			const idx = Number(resetIdx) - 1;
			if (sets[idx]) {
				await resetSet(sets[idx].id);
				sets = await fetchSets(pgId);
				printSets(sets);
			}
		}
	}

	const pickIdx = await ask('Enter set # to report (or "q" to quit): ');
	if (pickIdx === 'q') { rl.close(); return; }
	const setIdx = Number(pickIdx) - 1;
	const targetSet = sets[setIdx];
	if (!targetSet) { console.error('Invalid set #'); rl.close(); return; }

	const p1 = targetSet.slots[0]?.entrant;
	const p2 = targetSet.slots[1]?.entrant;
	if (!p1 || !p2) { console.error('Set has missing entrants'); rl.close(); return; }

	console.log(`\nSelected: ${p1.name} (${p1.id}) vs ${p2.name} (${p2.id})`);
	const winnerPick = await ask(`Who wins? [1] ${p1.name}  [2] ${p2.name}: `);
	const winner = winnerPick === '2' ? p2 : p1;
	const scorePick = await ask('Score? [1] 2-0  [2] 2-1: ');
	const loserScore = scorePick === '2' ? 1 : 0;

	// ── Step 2b: Report ──
	console.log(`\n[Step 2] Reporting: ${winner.name} wins 2-${loserScore}`);
	const ok1 = await reportSet(targetSet.id, winner.id, 2, loserScore);

	// ── Step 3: Try to report again (should fail) ──
	console.log(`\n[Step 3] Trying to report same set again (should fail)...`);
	const ok2 = await reportSet(targetSet.id, winner.id, 2, loserScore);
	console.log(ok2 ? '  ⚠ Unexpectedly succeeded!' : '  ✓ Correctly rejected re-report');

	// ── Step 4: Pull sets again ──
	console.log(`\n[Step 4] Fetching sets again (check updated state)...`);
	sets = await fetchSets(pgId);
	printSets(sets);

	// Note the set ID might have changed (preview → real)
	const updatedSet = sets.find(s => {
		const ids = s.slots.map(sl => sl.entrant?.id).filter(Boolean);
		return ids.includes(p1.id) && ids.includes(p2.id);
	});
	const currentSetId = updatedSet?.id ?? targetSet.id;
	if (String(currentSetId) !== String(targetSet.id)) {
		console.log(`  ℹ Set ID changed: ${targetSet.id} → ${currentSetId} (preview → real conversion)`);
	}

	// ── Step 5: Try to report again using current set ID ──
	console.log(`\n[Step 5] Trying to report again with current set ID ${currentSetId}...`);
	const ok3 = await reportSet(currentSetId, winner.id, 2, loserScore);
	console.log(ok3 ? '  ⚠ Unexpectedly succeeded!' : '  ✓ Correctly rejected re-report');

	// ── Optional: Reset ──
	const doReset = await ask('\nReset this set? [y/n]: ');
	if (doReset === 'y') {
		await resetSet(currentSetId);
		console.log('\nFinal state:');
		printSets(await fetchSets(pgId));
	}

	console.log('\nDone!');
	rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
