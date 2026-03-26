/**
 * Integration tests for StartGG reporting logic.
 * Hits the real StartGG API — requires STARTGG_TOKEN in .env.
 *
 * Uses the MSV Hub test event phase group (ID 3251998) which contains
 * test entrants 1Test–18Test created to validate reporting.
 */

import { describe, it, expect } from 'vitest';
import {
	gql,
	findSetInPhaseGroup,
	reportSet,
	PHASE_GROUP_SETS_QUERY
} from '$lib/server/startgg';

// Test phase group from MSV Hub dev event
const TEST_PHASE_GROUP_ID = 3251998;

// Known entrant IDs discovered during prior debugging
const ENTRANT_2TEST  = 23025378;
const ENTRANT_18TEST = 23025426;

// Bogus IDs — should never match a real set
const BOGUS_ID_A = 999_888_001;
const BOGUS_ID_B = 999_888_002;

// Real API calls can be slow — allow up to 30s per test
const TIMEOUT = 30_000;

describe('StartGG API — phase group sets query', () => {
	it('returns sets with entrant IDs for phase group 3251998', async () => {
		type Node = { id: string | number; winnerId: number | null; slots: { entrant: { id: number } | null }[] };
		type PGData = { phaseGroup: { sets: { nodes: Node[] } } };

		const data = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: TEST_PHASE_GROUP_ID }, { delay: 0 });

		expect(data).not.toBeNull();
		const nodes = data!.phaseGroup.sets.nodes;
		expect(nodes.length).toBeGreaterThan(0);

		console.log('\n--- Phase group sets ---');
		for (const node of nodes) {
			const entrantIds = node.slots.map((s) => s.entrant?.id ?? null);
			console.log(`  Set ${node.id}: winnerId=${node.winnerId ?? 'none'}, entrants=${JSON.stringify(entrantIds)}`);
		}
	}, TIMEOUT);
});

describe('StartGG API — findSetInPhaseGroup', () => {
	it('finds a set for 2Test (23025378) vs 18Test (23025426)', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, ENTRANT_2TEST, ENTRANT_18TEST);
		console.log(`\nfindSetInPhaseGroup result for 2Test vs 18Test: ${setId}`);
		expect(setId).not.toBeNull();
	}, TIMEOUT);

	it('returns null for bogus entrant IDs that have no set', async () => {
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
			// Every pair that exists in the phase group must be findable
			// (either unreported or via completed fallback)
			expect(found).not.toBeNull();
		}
	}, TIMEOUT * 3); // allow extra time for multiple API calls
});

describe('StartGG API — reportSet', () => {
	it('returns a meaningful result for 2Test vs 18Test (not silent failure or "not found")', async () => {
		const setId = await findSetInPhaseGroup(TEST_PHASE_GROUP_ID, ENTRANT_2TEST, ENTRANT_18TEST);
		expect(setId).not.toBeNull();

		const result = await reportSet(setId!, ENTRANT_2TEST, {
			loserEntrantId: ENTRANT_18TEST,
			winnerScore: 2,
			loserScore: 0
		});

		console.log(`\nreportSet(${setId}) result:`, result);

		// Acceptable outcomes:
		//   ok: true  → set was unreported, we just reported it successfully
		//   ok: false, error contains "Cannot report" / "completed" / "already"
		//             → set was already reported — StartGG's own clear error
		//
		// NOT acceptable:
		//   "Set not found" or "unexpected response shape" → broken lookup or parsing bug

		if (!result.ok) {
			expect(result.error).toMatch(/Cannot report|already|completed|locked/i);
		}
		expect(result.error ?? '').not.toMatch(/not found|unexpected response shape/i);
	}, TIMEOUT);
});
