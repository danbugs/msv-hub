/**
 * Integration tests for StartGG reporting logic.
 * Hits the real StartGG API — requires STARTGG_TOKEN in .env.
 *
 * Uses the MSV Hub test event phase group (ID 3251998) which contains
 * test entrants 1Test–18Test created to validate reporting.
 *
 * Pairs in round 1 (seed 1 vs seed N+1 pairing):
 *   preview_3251998_1_0: 1Test  (23025375) vs 17Test (23025423)
 *   preview_3251998_1_1: 2Test  (23025378) vs 18Test (23025426)
 */

import { describe, it, expect } from 'vitest';
import {
	gql,
	findSetInPhaseGroup,
	reportSet,
	PHASE_GROUP_SETS_QUERY
} from '$lib/server/startgg';
import { reportSwissMatch } from '$lib/server/startgg-reporter';
import type { TournamentState, SwissMatch } from '$lib/types/tournament';

// Test phase group from MSV Hub dev event
const TEST_PHASE_GROUP_ID = 3251998;

// Pair A — used by reportSet test
const ENTRANT_2TEST  = 23025378;
const ENTRANT_18TEST = 23025426;

// Pair B — used by reportSwissMatch test (kept separate so reportSet doesn't affect it)
const ENTRANT_1TEST  = 23025375;
const ENTRANT_17TEST = 23025423;

// Bogus IDs — should never match a real set
const BOGUS_ID_A = 999_888_001;
const BOGUS_ID_B = 999_888_002;

// Real API calls can be slow — allow up to 30s per test
const TIMEOUT = 30_000;

// Helper to log current phase group state
async function logPhaseGroupState(label: string) {
	type Node = { id: unknown; winnerId: unknown; slots: { entrant: { id: unknown } | null }[] };
	type PGData = { phaseGroup: { sets: { nodes: Node[] } } };
	const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: TEST_PHASE_GROUP_ID }, { delay: 0 });
	console.log(`\n--- Phase group state: ${label} ---`);
	for (const node of data?.phaseGroup?.sets?.nodes ?? []) {
		const ids = node.slots.map((s) => `${JSON.stringify(s.entrant?.id)}(${typeof s.entrant?.id})`).join(', ');
		console.log(`  Set ${node.id}: winnerId=${JSON.stringify(node.winnerId)}, entrants=[${ids}]`);
	}
}

describe('StartGG API — phase group sets query', () => {
	it('returns sets with entrant IDs for phase group 3251998', async () => {
		await logPhaseGroupState('initial');
	}, TIMEOUT);
});

describe('StartGG API — findSetInPhaseGroup', () => {
	it('finds a set for 2Test (23025378) vs 18Test (23025426) — number IDs', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, ENTRANT_2TEST, ENTRANT_18TEST);
		console.log(`\nfindSetInPhaseGroup(number ids) result for 2Test vs 18Test: ${setId}`);
		expect(setId).not.toBeNull();
	}, TIMEOUT);

	it('finds a set with STRING entrant IDs — type coercion must work', async () => {
		// Verifies the Number() coercion fix: if startggEntrantId was stored as a string
		// (possible from PHASE_SEEDS_QUERY returning string IDs), the lookup must still work.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, '23025378' as any, '23025426' as any);
		console.log(`\nfindSetInPhaseGroup(STRING ids): ${setId}`);
		expect(setId).not.toBeNull();
	}, TIMEOUT);

	it('returns null for bogus entrant IDs', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, BOGUS_ID_A, BOGUS_ID_B);
		expect(setId).toBeNull();
	}, TIMEOUT);

	it('finds sets for all entrant pairs returned by the phase group query', async () => {
		type Node = { id: string | number; winnerId: number | null; slots: { entrant: { id: number } | null }[] };
		type PGData = { phaseGroup: { sets: { nodes: Node[] } } };

		const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: TEST_PHASE_GROUP_ID }, { delay: 0 });
		expect(data).not.toBeNull();

		const nodes = data!.phaseGroup.sets.nodes;
		console.log('\n--- findSetInPhaseGroup for each discovered pair ---');
		for (const node of nodes) {
			const ids = node.slots
				.map((s) => s.entrant?.id)
				.filter((id): id is number => id !== undefined);
			if (ids.length < 2) continue;

			const [id1, id2] = ids;
			const found = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, id1, id2);
			console.log(`  entrants [${id1}, ${id2}] => set ${found}`);
			expect(found).not.toBeNull();
		}
	}, TIMEOUT * 3);
});

describe('StartGG API — reportSet', () => {
	it('reports pair A (2Test vs 18Test) and returns the real set ID', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, ENTRANT_2TEST, ENTRANT_18TEST);
		console.log(`\nPair A set ID before report: ${setId}`);
		expect(setId).not.toBeNull();

		const result = await reportSet(setId!, ENTRANT_2TEST, {
			loserEntrantId: ENTRANT_18TEST,
			winnerScore: 2,
			loserScore: 0
		});

		console.log(`reportSet(${setId}) result:`, result);
		// Log what the mutation returned as the real set ID
		console.log(`reportedSetId from mutation: ${result.reportedSetId ?? '(null — preview sets return null)'}`);

		if (!result.ok) {
			expect(result.error).toMatch(/Cannot report|already|completed|locked/i);
		}
		expect(result.error ?? '').not.toMatch(/not found|unexpected response shape/i);
	}, TIMEOUT);

	it('diagnostic: phase group state after reporting pair A', async () => {
		// This runs right after reportSet — shows what StartGG did to the phase group
		await logPhaseGroupState('after reporting preview_3251998_1_1 (pair A)');
	}, TIMEOUT);
});

describe('StartGG API — reportSwissMatch (end-to-end)', () => {
	it('reports pair B (1Test vs 17Test) via full reportSwissMatch flow', async () => {
		// Use pair B (fresh, not touched by the reportSet test above)
		const tournament: TournamentState = {
			slug: 'test-event',
			name: 'MSV Hub Integration Test',
			phase: 'swiss',
			createdAt: 0,
			updatedAt: 0,
			currentRound: 1,
			entrants: [
				{ id: 'e-1',  gamerTag: '1Test',  initialSeed: 1,  startggEntrantId: ENTRANT_1TEST },
				{ id: 'e-17', gamerTag: '17Test', initialSeed: 17, startggEntrantId: ENTRANT_17TEST }
			],
			settings: { numRounds: 5, numStations: 16, streamStation: 16 },
			rounds: [],
			startggPhase1Groups: [{ id: TEST_PHASE_GROUP_ID, displayIdentifier: '1' }]
		};

		const match: SwissMatch = {
			id: 'test-match-1-17',
			topPlayerId: 'e-1',
			bottomPlayerId: 'e-17',
			winnerId: 'e-1',
			topScore: 2,
			bottomScore: 0
		};

		const result = await reportSwissMatch(tournament, 1, match);
		console.log('\nreportSwissMatch result:', result);
		console.log('match.startggSetId after report:', match.startggSetId);

		if (!result.ok) {
			expect(result.error).toMatch(/Cannot report|already|completed|locked/i);
		}
		expect(result.error ?? '').not.toMatch(/Set not found|unexpected response shape/i);
	}, TIMEOUT);
});
