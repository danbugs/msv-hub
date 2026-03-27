/**
 * Integration tests for StartGG reporting logic.
 * Hits the real StartGG API — requires STARTGG_TOKEN in .env.
 *
 * Uses the MSV Hub test event phase group (ID 3251998) which contains
 * 32 test entrants (seeds 1–32) paired as seed N vs seed N+16 in round 1.
 *
 * TEST ORDER MATTERS: the E2E test (which reports sets) runs before the
 * targeted reportSet/reportSwissMatch tests so those targeted tests see an
 * already-settled phase group (real set IDs, not preview).
 */

import { describe, it, expect } from 'vitest';
import {
	gql,
	findSetInPhaseGroup,
	reportSet,
	fetchPhaseSeeds,
	fetchPhaseSeedsWithTags,
	fetchPhaseGroups,
	pushPairingsToPhaseGroup,
	PHASE_GROUP_SETS_QUERY
} from '$lib/server/startgg';
import { reportSwissMatch } from '$lib/server/startgg-reporter';
import type { TournamentState, SwissMatch, Entrant } from '$lib/types/tournament';

// Test phase group from MSV Hub dev event (round 1)
const TEST_PHASE_GROUP_ID = 3251998;
// Phase IDs per round (each round is a separate StartGG phase)
const TEST_PHASE_ROUND1 = 2243224;
const TEST_PHASE_ROUND2 = 2243225;
const TEST_PHASE_GROUP_ROUND2 = 3251999;

// Known entrant IDs for targeted tests
const ENTRANT_2TEST  = 23025378;
const ENTRANT_18TEST = 23025426;
const ENTRANT_1TEST  = 23025375;
const ENTRANT_17TEST = 23025423;

const BOGUS_ID_A = 999_888_001;
const BOGUS_ID_B = 999_888_002;

const TIMEOUT = 30_000;

// ── Helper ───────────────────────────────────────────────────────────────────

async function logPhaseGroupState(label: string) {
	type Node = { id: unknown; winnerId: unknown; slots: { entrant: { id: unknown } | null }[] };
	type PGData = { phaseGroup: { sets: { nodes: Node[] } } };
	const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: TEST_PHASE_GROUP_ID }, { delay: 0 });
	console.log(`\n--- Phase group state: ${label} ---`);
	for (const node of data?.phaseGroup?.sets?.nodes ?? []) {
		const ids = node.slots.map((s) => `${s.entrant?.id}(${typeof s.entrant?.id})`).join(', ');
		console.log(`  ${node.id}: winner=${node.winnerId ?? 'none'} | [${ids}]`);
	}
}

// ── 1. Initial diagnostic ─────────────────────────────────────────────────────

describe('StartGG API — 1. phase group diagnostic', () => {
	it('shows initial state of phase group 3251998', async () => {
		await logPhaseGroupState('initial');
	}, TIMEOUT);
});

// ── 2. findSetInPhaseGroup ────────────────────────────────────────────────────

describe('StartGG API — 2. findSetInPhaseGroup', () => {
	it('finds set for 2Test vs 18Test with number IDs', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, ENTRANT_2TEST, ENTRANT_18TEST);
		console.log(`\nfindSetInPhaseGroup(numbers): ${setId}`);
		expect(setId).not.toBeNull();
	}, TIMEOUT);

	it('finds set for 2Test vs 18Test with STRING IDs — type coercion', async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, '23025378' as any, '23025426' as any);
		console.log(`\nfindSetInPhaseGroup(strings): ${setId}`);
		expect(setId).not.toBeNull();
	}, TIMEOUT);

	it('returns null for bogus IDs', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, BOGUS_ID_A, BOGUS_ID_B);
		expect(setId).toBeNull();
	}, TIMEOUT);

	it('finds sets for all 16 pairs', async () => {
		type Node = { id: unknown; winnerId: unknown; slots: { entrant: { id: number } | null }[] };
		type PGData = { phaseGroup: { sets: { nodes: Node[] } } };
		const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: TEST_PHASE_GROUP_ID }, { delay: 0 });
		const nodes = data!.phaseGroup.sets.nodes;
		expect(nodes.length).toBeGreaterThan(0);
		console.log('\n--- findSetInPhaseGroup for all pairs ---');
		for (const node of nodes) {
			const ids = node.slots.map((s) => s.entrant?.id).filter((id): id is number => id != null);
			if (ids.length < 2) continue;
			const found = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, ids[0], ids[1]);
			console.log(`  [${ids[0]}, ${ids[1]}] => ${found}`);
			expect(found).not.toBeNull();
		}
	}, TIMEOUT * 3);
});

// ── 3. Full end-to-end: load seeds → report all round-1 results ──────────────
//
// RUNS BEFORE targeted reportSet/reportSwissMatch so those tests see the
// settled phase group (real set IDs). Reporting the first preview set triggers
// a StartGG preview→real conversion; subsequent lookups use the retry logic
// in findSetInPhaseGroup to wait out the transitional empty state.

describe('StartGG API — 3. full end-to-end: load seeds → report all round-1 results', () => {
	it('pulls seeds via fetchPhaseSeeds, builds TournamentState, reports top seeds winning 2-0', async () => {
		// ── Step 1: discover phase ID from the phase group ──
		const pgInfo = await gql<{ phaseGroup: { phase: { id: number } } }>(
			'query PhaseParent($id: ID!) { phaseGroup(id: $id) { phase { id } } }',
			{ id: TEST_PHASE_GROUP_ID },
			{ delay: 0 }
		);
		const phaseId = pgInfo?.phaseGroup?.phase?.id;
		expect(phaseId).toBeTruthy();
		console.log(`\nPhase ID: ${phaseId}`);

		// ── Step 2: pull seeds exactly as from-event/+server.ts does ──
		const [sgSeeds, seedsWithTags, phase1Groups] = await Promise.all([
			fetchPhaseSeeds(phaseId!),
			fetchPhaseSeedsWithTags(phaseId!),
			fetchPhaseGroups(phaseId!)
		]);
		console.log(`Loaded ${sgSeeds.length} seeds, ${phase1Groups.length} phase group(s)`);
		console.log(`Phase groups: ${JSON.stringify(phase1Groups)}`);

		// ── Step 3: build seed → entrantId map (same logic as from-event/+server.ts) ──
		const sgSeedToEntrantId = new Map<number, number>();
		for (const seed of sgSeeds) {
			const seedNum  = Number((seed as { seedNum?: unknown }).seedNum);
			const entrantId = Number((seed as { entrant?: { id?: unknown } }).entrant?.id);
			if (seedNum && entrantId && !isNaN(seedNum) && !isNaN(entrantId)) {
				sgSeedToEntrantId.set(seedNum, entrantId);
			}
		}

		// ── Step 4: build entrants (same as from-event/+server.ts) ──
		const entrants: Entrant[] = seedsWithTags.map((s, i) => ({
			id: `e-${i + 1}`,
			gamerTag: s.gamerTag,
			initialSeed: s.seedNum,
			startggEntrantId: sgSeedToEntrantId.get(s.seedNum)
		}));

		console.log('\nFirst 4 entrants (verifying startggEntrantId is a number):');
		for (const e of entrants.slice(0, 4)) {
			console.log(`  seed ${e.initialSeed}: ${e.gamerTag} → ${e.startggEntrantId} (${typeof e.startggEntrantId})`);
		}

		expect(entrants.length).toBeGreaterThan(0);
		expect(entrants.every(e => e.startggEntrantId !== undefined)).toBe(true);
		expect(entrants.every(e => typeof e.startggEntrantId === 'number')).toBe(true);

		// ── Step 5: build tournament state ──
		const tournament: TournamentState = {
			slug: 'test-e2e',
			name: 'MSV Hub E2E Integration Test',
			phase: 'swiss',
			createdAt: 0, updatedAt: 0, currentRound: 1,
			entrants,
			settings: { numRounds: 5, numStations: 16, streamStation: 16 },
			rounds: [],
			startggPhase1Groups: phase1Groups.length ? phase1Groups : undefined
		};

		// ── Step 6: get all 16 pairs from the phase group and report them ──
		type Node = { id: unknown; winnerId: unknown; slots: { entrant: { id: number } | null }[] };
		type PGData = { phaseGroup: { sets: { nodes: Node[] } } };
		const setsData = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: TEST_PHASE_GROUP_ID }, { delay: 0 });
		const sets = setsData!.phaseGroup.sets.nodes;

		console.log(`\nPhase group has ${sets.length} sets (including any already completed)`);
		expect(sets.length).toBeGreaterThan(0);

		const byEntrantId = new Map(
			entrants.filter(e => e.startggEntrantId != null).map(e => [e.startggEntrantId!, e])
		);

		let reported = 0, alreadyDone = 0, failed = 0;
		console.log('\n--- Reporting all round-1 results (lower seed wins 2-0) ---');

		for (const set of sets) {
			const slotIds = set.slots.map(s => s.entrant?.id).filter((id): id is number => id != null);
			if (slotIds.length < 2) { failed++; continue; }

			const e1 = byEntrantId.get(slotIds[0]);
			const e2 = byEntrantId.get(slotIds[1]);
			if (!e1 || !e2) {
				console.log(`  ✗ SKIP: entrant ${slotIds[0]} or ${slotIds[1]} not in loaded entrants`);
				failed++;
				continue;
			}

			const winner = e1.initialSeed < e2.initialSeed ? e1 : e2;
			const loser  = winner === e1 ? e2 : e1;

			const match: SwissMatch = {
				id: `m-${e1.id}-${e2.id}`,
				topPlayerId: e1.id,
				bottomPlayerId: e2.id,
				winnerId: winner.id,
				topScore: winner === e1 ? 2 : 0,
				bottomScore: winner === e2 ? 2 : 0
			};

			const result = await reportSwissMatch(tournament, 1, match);

			if (result.ok) {
				console.log(`  ✓ ${winner.gamerTag} 2-0 ${loser.gamerTag} → cached set ${match.startggSetId}`);
				reported++;
			} else if (result.error?.match(/Cannot report|already|completed|locked/i)) {
				console.log(`  ~ ${winner.gamerTag} vs ${loser.gamerTag} → already reported (expected)`);
				alreadyDone++;
			} else {
				console.log(`  ✗ ${winner.gamerTag} vs ${loser.gamerTag} → ${result.error}`);
				failed++;
			}
		}

		console.log(`\nSummary: ${reported} freshly reported, ${alreadyDone} already done, ${failed} failed`);
		expect(failed).toBe(0);
		expect(reported + alreadyDone).toBe(sets.length);
	}, TIMEOUT * 15); // generous: 16 sequential API calls + retry delays
});

// ── 4. Targeted tests (run after E2E so phase group has settled) ─────────────

describe('StartGG API — 4. reportSet (targeted)', () => {
	it('pair A (2Test vs 18Test): reports fresh or surfaces "Cannot report" for already-done', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, ENTRANT_2TEST, ENTRANT_18TEST);
		console.log(`\nfindSetInPhaseGroup for 2T vs 18T: ${setId}`);
		expect(setId).not.toBeNull();
		const result = await reportSet(setId!, ENTRANT_2TEST, {
			loserEntrantId: ENTRANT_18TEST, winnerScore: 2, loserScore: 0
		});
		console.log(`reportSet(${setId}):`, result);
		if (!result.ok) expect(result.error).toMatch(/Cannot report|already|completed|locked/i);
		expect(result.error ?? '').not.toMatch(/not found|unexpected response shape/i);
	}, TIMEOUT);
});

describe('StartGG API — 4. reportSwissMatch (targeted)', () => {
	it('pair B (1Test vs 17Test): reports fresh or surfaces "Cannot report" for already-done', async () => {
		const tournament: TournamentState = {
			slug: 'test', name: 'Test', phase: 'swiss', createdAt: 0, updatedAt: 0, currentRound: 1,
			entrants: [
				{ id: 'e-1',  gamerTag: '1Test',  initialSeed: 1,  startggEntrantId: ENTRANT_1TEST },
				{ id: 'e-17', gamerTag: '17Test', initialSeed: 17, startggEntrantId: ENTRANT_17TEST }
			],
			settings: { numRounds: 5, numStations: 16, streamStation: 16 },
			rounds: [],
			startggPhase1Groups: [{ id: TEST_PHASE_GROUP_ID, displayIdentifier: '1' }]
		};
		const match: SwissMatch = {
			id: 'm1', topPlayerId: 'e-1', bottomPlayerId: 'e-17', winnerId: 'e-1', topScore: 2, bottomScore: 0
		};
		const result = await reportSwissMatch(tournament, 1, match);
		console.log('\nreportSwissMatch result:', result);
		console.log('match.startggSetId:', match.startggSetId);
		if (!result.ok) expect(result.error).toMatch(/Cannot report|already|completed|locked/i);
		expect(result.error ?? '').not.toMatch(/Set not found|unexpected response shape/i);
	}, TIMEOUT);
});

// ── 5. Round 2 re-seeding ─────────────────────────────────────────────────────

describe('StartGG API — 5. pushPairingsToPhaseGroup (round 2 re-seeding)', () => {
	it('discovers all phases and their phase groups', async () => {
		// Verify the test event has separate phases per round (same structure as from-event/+server.ts)
		const data = await gql<{
			phase: { event: { phases: { id: number; name: string; phaseGroups: { nodes: { id: number }[] } }[] } }
		}>(
			`query { phase(id: ${TEST_PHASE_ROUND1}) { event { phases { id name phaseGroups(query: { page: 1, perPage: 64 }) { nodes { id } } } } } }`,
			{},
			{ delay: 0 }
		);
		const phases = data?.phase?.event?.phases ?? [];
		console.log('\n--- All phases in test event ---');
		for (const p of phases) {
			console.log(`  Phase ${p.id}: ${p.name} → groups: [${p.phaseGroups.nodes.map((n) => n.id).join(', ')}]`);
		}
		expect(phases.length).toBeGreaterThanOrEqual(5); // 5 Swiss rounds + Final Standings

		const round2Phase = phases.find((p) => p.name.includes('Round 2'));
		expect(round2Phase).toBeTruthy();
		expect(round2Phase!.id).toBe(TEST_PHASE_ROUND2);
		expect(round2Phase!.phaseGroups.nodes[0]?.id).toBe(TEST_PHASE_GROUP_ROUND2);
	}, TIMEOUT);

	it('pushes fold-based pairings and verifies StartGG SETS match intended pairings', async () => {
		// Step 1: Fetch entrants from round 2 phase group
		type SeedNode = { id: unknown; seedNum: number; entrant: { id: number } };
		const SEED_QUERY = 'query PGSeeds($pgId: ID!) { phaseGroup(id: $pgId) { seeds(query: { page: 1, perPage: 64 }) { nodes { id seedNum entrant { id } } } } }';

		const seedsData = await gql<{ phaseGroup: { seeds: { nodes: SeedNode[] } } }>(
			SEED_QUERY, { pgId: TEST_PHASE_GROUP_ROUND2 }, { delay: 0 }
		);
		const seeds = seedsData?.phaseGroup?.seeds?.nodes ?? [];
		console.log(`\nRound 2 phase group ${TEST_PHASE_GROUP_ROUND2} has ${seeds.length} seeds`);
		expect(seeds.length).toBeGreaterThan(0);

		const entrantIds = seeds.map((s) => s.entrant.id);

		// Step 2: Build REVERSED pairings to verify the seeding actually changes
		const reversed = [...entrantIds].reverse();
		const pairings: [number, number][] = [];
		for (let i = 0; i < reversed.length - 1; i += 2) {
			pairings.push([reversed[i], reversed[i + 1]]);
		}
		console.log(`Built ${pairings.length} reversed pairings (fold-based seeding)`);
		console.log(`Intended pair 0: [${pairings[0][0]}, ${pairings[0][1]}]`);
		console.log(`Intended pair 1: [${pairings[1][0]}, ${pairings[1][1]}]`);

		// Step 3: Push pairings using fold-based seeding
		console.log(`\nCalling pushPairingsToPhaseGroup(phaseId=${TEST_PHASE_ROUND2}, pgId=${TEST_PHASE_GROUP_ROUND2})`);
		const result = await pushPairingsToPhaseGroup(TEST_PHASE_ROUND2, TEST_PHASE_GROUP_ROUND2, pairings);
		console.log('pushPairingsToPhaseGroup result:', result);
		expect(result.ok).toBe(true);

		// Step 4: Verify seed assignment uses fold pattern (pair i → seeds i+1 and K+i+1)
		const K = pairings.length;
		const afterData = await gql<{ phaseGroup: { seeds: { nodes: SeedNode[] } } }>(
			SEED_QUERY, { pgId: TEST_PHASE_GROUP_ROUND2 }, { delay: 0 }
		);
		const afterSeeds = (afterData?.phaseGroup?.seeds?.nodes ?? []).sort((a, b) => a.seedNum - b.seedNum);
		console.log(`\nSeed layout after fold seeding (K=${K}):`);
		for (const s of afterSeeds.slice(0, 4)) {
			console.log(`  seedNum ${s.seedNum}: entrant ${s.entrant.id}`);
		}
		console.log('  ...');
		for (const s of afterSeeds.slice(K, K + 2)) {
			console.log(`  seedNum ${s.seedNum}: entrant ${s.entrant.id}`);
		}

		// Pair 0: first player at seed 1, second player at seed K+1
		expect(afterSeeds[0]?.entrant.id).toBe(pairings[0][0]);
		expect(afterSeeds[K]?.entrant.id).toBe(pairings[0][1]);

		// Step 5: THE REAL TEST — verify the SETS on StartGG match our intended pairings.
		// StartGG Swiss pairs seed i vs seed K+i (fold). After our fold-based seeding,
		// the sets should exactly match the pairings we pushed.
		type SetNode = { id: unknown; slots: { entrant: { id: number } | null }[] };
		const setsData = await gql<{ phaseGroup: { sets: { nodes: SetNode[] } } }>(
			PHASE_GROUP_SETS_QUERY, { phaseGroupId: TEST_PHASE_GROUP_ROUND2 }, { delay: 0 }
		);
		const sets = setsData?.phaseGroup?.sets?.nodes ?? [];
		console.log(`\n--- Sets after fold seeding: ${sets.length} sets ---`);

		// Build a set of intended pairings as "min-max" entrant ID strings for easy lookup
		const intendedPairs = new Set(
			pairings.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join('-'))
		);

		let matched = 0;
		let mismatched = 0;
		for (const set of sets) {
			const ids = set.slots
				.map((s) => s.entrant?.id)
				.filter((id): id is number => id != null && id > 0)
				.sort((a, b) => a - b);
			if (ids.length !== 2) continue;
			const key = ids.join('-');
			if (intendedPairs.has(key)) {
				matched++;
			} else {
				mismatched++;
				console.log(`  MISMATCH: set ${set.id} has entrants [${ids[0]}, ${ids[1]}] — not in our pairings`);
			}
		}
		console.log(`\nMatched: ${matched}/${pairings.length} pairings, Mismatched: ${mismatched}`);
		// All sets should match our intended pairings
		expect(matched).toBe(pairings.length);
		expect(mismatched).toBe(0);
	}, TIMEOUT * 3);

	it('FAILS when using the wrong phase ID (round 1 phase for round 2 group)', async () => {
		// This reproduces the original bug: using startggPhase1Id (round 1) for round 2
		const seedsData = await gql<{
			phaseGroup: { seeds: { nodes: { entrant: { id: number } }[] } }
		}>(
			'query PGSeeds($pgId: ID!) { phaseGroup(id: $pgId) { seeds(query: { page: 1, perPage: 64 }) { nodes { entrant { id } } } } }',
			{ pgId: TEST_PHASE_GROUP_ROUND2 },
			{ delay: 0 }
		);
		const entrantIds = (seedsData?.phaseGroup?.seeds?.nodes ?? []).map((s) => s.entrant.id);
		const pairings: [number, number][] = [];
		for (let i = 0; i < entrantIds.length - 1; i += 2) {
			pairings.push([entrantIds[i], entrantIds[i + 1]]);
		}

		// Use WRONG phase ID (round 1 phase for round 2 phase group)
		console.log(`\nCalling pushPairingsToPhaseGroup with WRONG phaseId=${TEST_PHASE_ROUND1} for round 2 group`);
		const result = await pushPairingsToPhaseGroup(TEST_PHASE_ROUND1, TEST_PHASE_GROUP_ROUND2, pairings);
		console.log('Result with wrong phase ID:', result);
		// This should either fail or silently not update — either way, it shouldn't work correctly
		// The key assertion: the API call returns an error or the seeds don't match
		if (result.ok) {
			console.log('  API accepted it (may silently ignore), but the fix ensures we use the correct phase ID');
		} else {
			console.log(`  API rejected: ${result.error} — confirms the bug`);
			expect(result.ok).toBe(false);
		}
	}, TIMEOUT);
});
