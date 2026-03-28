#!/usr/bin/env npx tsx
/**
 * Interactive StartGG test harness.
 *
 * Usage:
 *   npx tsx scripts/startgg-test-harness.ts <event-url-or-slug>
 *
 * Example:
 *   npx tsx scripts/startgg-test-harness.ts https://www.start.gg/tournament/micro-132/event/ultimate-singles
 *   npx tsx scripts/startgg-test-harness.ts tournament/micro-132/event/ultimate-singles
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

const EVENT_BY_SLUG = `
query EventBySlug($slug: String!) {
  event(slug: $slug) { id name }
}`;

const EVENT_PHASES = `
query EventPhases($eventId: ID!) {
  event(id: $eventId) {
    phases { id name numSeeds }
  }
}`;

const PHASE_GROUPS = `
query PhaseGroups($phaseId: ID!) {
  phase(id: $phaseId) {
    phaseGroups(query: { page: 1, perPage: 64 }) {
      nodes { id displayIdentifier }
    }
  }
}`;

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
mutation ReportSet($setId: ID!, $winnerId: ID!, $isDQ: Boolean, $gameData: [BracketSetGameDataInput]) {
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

interface Phase { id: number; name: string; numSeeds: number }
interface PhaseGroup { id: number; displayIdentifier: string }
interface SetNode {
	id: number | string;
	fullRoundText: string | null;
	winnerId: number | null;
	slots: { entrant: { id: number; name: string } | null }[];
}

// ── Readline ──

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

// ── Helpers ──

function normalizeSlug(input: string): string {
	return input
		.replace(/^https?:\/\/[^/]+\//i, '')
		.replace(/^\/+|\/+$/g, '');
}

async function fetchSets(pgId: number, retryOnEmpty = true): Promise<SetNode[]> {
	const data = await gql<{ phaseGroup: { sets: { nodes: SetNode[] } } }>(SETS_QUERY, { pgId });
	let nodes = data?.phaseGroup?.sets?.nodes ?? [];

	// After the first preview set is reported, StartGG converts all preview sets to real IDs.
	// During this conversion (~5-30s) the API returns 0 sets. Retry with back-off.
	if (nodes.length === 0 && retryOnEmpty) {
		for (let attempt = 1; attempt <= 6; attempt++) {
			const waitSec = attempt * 5;
			process.stdout.write(`  ⏳ No sets returned (preview→real conversion in progress), retrying in ${waitSec}s... (${attempt}/6)\r`);
			await new Promise(r => setTimeout(r, waitSec * 1000));
			const retry = await gql<{ phaseGroup: { sets: { nodes: SetNode[] } } }>(SETS_QUERY, { pgId });
			nodes = retry?.phaseGroup?.sets?.nodes ?? [];
			if (nodes.length > 0) {
				console.log('  ✓ Sets loaded after preview→real conversion                                        ');
				break;
			}
		}
	}

	return nodes;
}

function printSets(sets: SetNode[]) {
	console.log(`\n${'─'.repeat(90)}`);
	console.log(`  #  │ Set ID            │ Status     │ Match`);
	console.log(`${'─'.repeat(90)}`);
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
	console.log(`${'─'.repeat(90)}\n`);
}

/** Returns { ok, error? } so callers can inspect failure reason. */
async function reportSetRaw(setId: string | number, winnerId: number, loserEntrantId: number, loserScore: number, isDQ: boolean): Promise<{ ok: boolean; error?: string; data?: unknown }> {
	const w = String(winnerId);
	const l = String(loserEntrantId);

	const variables: Record<string, unknown> = {
		setId: String(setId),
		winnerId: String(winnerId),
		isDQ
	};

	if (!isDQ) {
		let gameData;
		if (loserScore === 0) {
			gameData = [{ winnerId: w, gameNum: 1 }, { winnerId: w, gameNum: 2 }];
		} else {
			gameData = [{ winnerId: w, gameNum: 1 }, { winnerId: l, gameNum: 2 }, { winnerId: w, gameNum: 3 }];
		}
		variables.gameData = gameData;
	}

	// Bypass gql() to get the raw error message
	const res = await fetch(API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ query: REPORT_MUTATION, variables })
	});

	if (res.status === 429) {
		console.log('  ⚠ Rate limited, waiting 10s...');
		await new Promise(r => setTimeout(r, 10000));
		return reportSetRaw(setId, winnerId, loserEntrantId, loserScore, isDQ);
	}

	const json = await res.json();
	if (json.errors?.length) {
		const msg = json.errors.map((e: { message: string }) => e.message).join('; ');
		return { ok: false, error: msg };
	}
	return { ok: true, data: json.data };
}

async function doReport(setId: string | number, winnerId: number, loserEntrantId: number, loserScore: number, isDQ: boolean): Promise<boolean> {
	const label = isDQ ? 'DQ' : `2-${loserScore}`;
	console.log(`\n→ Reporting set ${setId}: winner=${winnerId}, ${label}`);

	let result = await reportSetRaw(setId, winnerId, loserEntrantId, loserScore, isDQ);

	// If set is already completed, auto-reset and re-report (mirrors app behavior)
	if (!result.ok && result.error?.includes('Cannot report completed set')) {
		console.log('  ⚠ Set already completed — resetting first...');
		const resetOk = await resetSet(setId);
		if (resetOk) {
			result = await reportSetRaw(setId, winnerId, loserEntrantId, loserScore, isDQ);
		}
	}

	if (result.ok) {
		console.log('  ✓ Report succeeded:', JSON.stringify(result.data));
		return true;
	}
	console.log(`  ✗ Report FAILED: ${result.error}`);
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

// ── Main ──

async function main() {
	const input = process.argv.slice(2).join(' ').trim();
	if (!input) {
		console.error('Usage: npx tsx scripts/startgg-test-harness.ts <event-url-or-slug>');
		console.error('  e.g. npx tsx scripts/startgg-test-harness.ts https://www.start.gg/tournament/micro-132/event/ultimate-singles');
		process.exit(1);
	}

	const slug = normalizeSlug(input);
	console.log(`\n╔══════════════════════════════════════════════════════════╗`);
	console.log(`║  StartGG Test Harness                                   ║`);
	console.log(`╚══════════════════════════════════════════════════════════╝`);
	console.log(`  Event slug: ${slug}`);

	// ── Step 1: Resolve event ──
	console.log('\n[Step 1] Resolving event...');
	const eventData = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG, { slug });
	if (!eventData?.event) { console.error('Event not found!'); process.exit(1); }
	const { id: eventId, name: eventName } = eventData.event;
	console.log(`  ✓ ${eventName} (ID: ${eventId})`);

	// ── Step 2: List phases ──
	console.log('\n[Step 2] Fetching phases...');
	const phaseData = await gql<{ event: { phases: Phase[] } }>(EVENT_PHASES, { eventId });
	const phases = phaseData?.event?.phases ?? [];
	if (!phases.length) { console.error('No phases found!'); process.exit(1); }

	console.log('');
	for (let i = 0; i < phases.length; i++) {
		console.log(`  [${i + 1}] ${phases[i].name} (ID: ${phases[i].id}, ${phases[i].numSeeds} seeds)`);
	}

	const phaseChoice = await ask('\nPick a phase #: ');
	const phase = phases[Number(phaseChoice) - 1];
	if (!phase) { console.error('Invalid phase #'); rl.close(); return; }

	// ── Step 3: List phase groups ──
	console.log(`\n[Step 3] Fetching phase groups for "${phase.name}"...`);
	const pgData = await gql<{ phase: { phaseGroups: { nodes: PhaseGroup[] } } }>(PHASE_GROUPS, { phaseId: phase.id });
	const groups = pgData?.phase?.phaseGroups?.nodes ?? [];
	if (!groups.length) { console.error('No phase groups found!'); rl.close(); return; }

	let pgId: number;
	if (groups.length === 1) {
		pgId = groups[0].id;
		console.log(`  Using phase group ${pgId}`);
	} else {
		console.log('');
		for (let i = 0; i < groups.length; i++) {
			console.log(`  [${i + 1}] Pool ${groups[i].displayIdentifier} (ID: ${groups[i].id})`);
		}
		const pgChoice = await ask('\nPick a phase group #: ');
		const pg = groups[Number(pgChoice) - 1];
		if (!pg) { console.error('Invalid #'); rl.close(); return; }
		pgId = pg.id;
	}

	// ── Interactive loop ──
	while (true) {
		console.log('\n[Fetching sets...]');
		let sets = await fetchSets(pgId);
		if (!sets.length) { console.log('No sets found in this phase group.'); break; }
		printSets(sets);

		console.log('Commands:');
		console.log('  <#>        — report that set');
		console.log('  r <#>      — reset that set');
		console.log('  refresh    — re-fetch sets');
		console.log('  phase      — switch phase');
		console.log('  q          — quit');

		const cmd = (await ask('\n> ')).trim().toLowerCase();
		if (cmd === 'q') break;
		if (cmd === 'refresh') continue;
		if (cmd === 'phase') {
			// Re-pick phase
			console.log('');
			for (let i = 0; i < phases.length; i++) {
				console.log(`  [${i + 1}] ${phases[i].name} (ID: ${phases[i].id})`);
			}
			const pc = await ask('\nPick a phase #: ');
			const p = phases[Number(pc) - 1];
			if (!p) { console.log('Invalid'); continue; }
			const pgd = await gql<{ phase: { phaseGroups: { nodes: PhaseGroup[] } } }>(PHASE_GROUPS, { phaseId: p.id });
			const gs = pgd?.phase?.phaseGroups?.nodes ?? [];
			if (!gs.length) { console.log('No phase groups'); continue; }
			if (gs.length === 1) { pgId = gs[0].id; }
			else {
				for (let i = 0; i < gs.length; i++) console.log(`  [${i + 1}] Pool ${gs[i].displayIdentifier} (ID: ${gs[i].id})`);
				const gc = await ask('Pick a phase group #: ');
				const g = gs[Number(gc) - 1];
				if (!g) { console.log('Invalid'); continue; }
				pgId = g.id;
			}
			continue;
		}

		// Reset command: "r 3"
		const resetMatch = cmd.match(/^r\s+(\d+)$/);
		if (resetMatch) {
			const idx = Number(resetMatch[1]) - 1;
			if (sets[idx]) await resetSet(sets[idx].id);
			else console.log('Invalid set #');
			continue;
		}

		// Report command: just a number
		const setIdx = Number(cmd) - 1;
		if (isNaN(setIdx) || !sets[setIdx]) { console.log('Unknown command or invalid set #'); continue; }

		const targetSet = sets[setIdx];
		const p1 = targetSet.slots[0]?.entrant;
		const p2 = targetSet.slots[1]?.entrant;
		if (!p1 || !p2) { console.log('Set has missing entrants'); continue; }

		console.log(`\n  ${p1.name} (entrant ${p1.id}) vs ${p2.name} (entrant ${p2.id})`);
		if (targetSet.winnerId) {
			const winnerName = targetSet.slots.find(sl => sl.entrant?.id === targetSet.winnerId)?.entrant?.name ?? '?';
			console.log(`  Already reported: ${winnerName} won`);
			console.log(`  (will auto-reset before re-reporting)`);
		}

		const winnerPick = await ask(`  Who wins? [1] ${p1.name}  [2] ${p2.name}: `);
		const winner = winnerPick === '2' ? p2 : p1;
		const loser = winnerPick === '2' ? p1 : p2;

		const scorePick = await ask('  Score? [1] 2-0  [2] 2-1  [3] DQ: ');
		const isDQ = scorePick === '3';
		const loserScore = scorePick === '2' ? 1 : 0;

		const label = isDQ ? 'DQ' : `2-${loserScore}`;
		console.log(`\n  Reporting: ${winner.name} wins ${label}`);
		await doReport(targetSet.id, winner.id, loser.id, loserScore, isDQ);
	}

	console.log('\nDone!');
	rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
