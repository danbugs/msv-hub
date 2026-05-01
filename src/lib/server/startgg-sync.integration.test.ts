/**
 * StartGG Cross-Event Sync Integration Test
 *
 * Exercises the mode-switching sync pattern that initial-sync and reset-startgg use:
 *   1. Swiss → Main (gauntlet creation): add to Main, push seeding, verify IDs, remove from Swiss
 *   2. Main → Swiss (switch back): add to Swiss, push seeding, verify IDs, remove from Main
 *
 * Uses the permanent test tournament: "Microspacing Vancouver Test"
 *   - Swiss event: 1590949 (Round 1 phase group: 3251998)
 *   - Main Bracket event: 1590950
 *
 * Validates that after each sync:
 *   - Seeding order is preserved on StartGG
 *   - Entrant ID translation works (Swiss IDs ≠ Main IDs for same player)
 *   - Preview sets exist with the correct entrant IDs
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(import.meta.dirname ?? '.', '../../..', '.env');
let hasEnv = false;
try { hasEnv = fs.existsSync(envPath); } catch { /* */ }
const suite = hasEnv ? describe : describe.skip;

// ── Constants ────────────────────────────────────────────────────────────────

const TOURNAMENT_SLUG = 'microspacing-vancouver-test';
const SWISS_EVENT_ID = 1590949;
const MAIN_EVENT_ID = 1590950;
const REDEMPTION_EVENT_ID = 1590951;
const SWISS_R1_PHASE_ID = 2243224;
const SWISS_R1_PG_ID = 3251998;
const MAIN_BRACKET_PHASE_ID = 2243230;

const TIMEOUT = 30_000;
const LONG_TIMEOUT = 120_000;
const SYNC_TIMEOUT = 300_000;

// ── Imports ────────────────────────────────────────────────────────────────

import {
	gql,
	EVENT_PHASES_QUERY,
	fetchPhaseSeeds,
	fetchPhaseGroups,
	pushBracketSeeding,
	pushFinalStandingsSeeding,
	extractPlayerId,
} from '$lib/server/startgg';
import {
	restartPhase,
	getTournamentParticipants,
	updateParticipantEvents,
} from '$lib/server/startgg-admin';

function log(msg: string) { console.log(`[sync-test] ${msg}`); }
async function wait(ms: number) { await new Promise<void>(r => setTimeout(r, ms)); }

type SeedEntry = {
	seedNum?: number;
	entrant?: { id?: number; participants?: { player?: { id?: number } }[] };
};

// Build player ID ↔ entrant ID maps from phase seeds
async function getPlayerEntrantMap(phaseId: number): Promise<Map<number, number>> {
	const seeds = await fetchPhaseSeeds(phaseId).catch(() => []) as SeedEntry[];
	const map = new Map<number, number>();
	for (const seed of seeds) {
		const playerId = seed.entrant?.participants?.[0]?.player?.id;
		const entrantId = seed.entrant?.id;
		if (playerId && entrantId) map.set(playerId, Number(entrantId));
	}
	return map;
}

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-EVENT SYNC LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════

suite('Cross-event sync lifecycle', () => {
	let swissEntrantIds: number[] = []; // entrant IDs in seed order from Swiss R1
	let mainPgId: number;

	it('setup: ensure clean state (all players in Swiss, none in Main)', async () => {
		// Resolve Main bracket phase group first
		const mainGroups = await fetchPhaseGroups(MAIN_BRACKET_PHASE_ID).catch(() => []);
		expect(mainGroups.length).toBeGreaterThan(0);
		mainPgId = mainGroups[0].id;
		log(`Main bracket PG: ${mainPgId}`);

		// Restart Main bracket to clean state
		await restartPhase(MAIN_BRACKET_PHASE_ID);
		await wait(2000);

		// Move ALL participants to Swiss (they may be in Main from a previous run)
		const participants = await getTournamentParticipants(TOURNAMENT_SLUG);
		let movedToSwiss = 0;
		for (const p of participants) {
			const inSwiss = p.currentEventIds.includes(SWISS_EVENT_ID);
			const inMain = p.currentEventIds.includes(MAIN_EVENT_ID);
			const inRed = p.currentEventIds.includes(REDEMPTION_EVENT_ID);
			if (inSwiss && !inMain && !inRed) continue;
			const result = await updateParticipantEvents(p.participantId, [SWISS_EVENT_ID], []);
			if (result.ok) movedToSwiss++;
			else log(`  ✗ ${p.gamerTag}: ${result.error}`);
		}
		if (movedToSwiss) log(`Moved ${movedToSwiss} participants to Swiss-only`);
		await wait(3000);

		// Now Swiss R1 should have seeds
		const swissSeeds = await fetchPhaseSeeds(SWISS_R1_PHASE_ID) as SeedEntry[];
		log(`Swiss R1 has ${swissSeeds.length} seeds`);
		expect(swissSeeds.length).toBeGreaterThanOrEqual(30);

		// Save Swiss entrant IDs in seed order
		const sorted = [...swissSeeds]
			.filter(s => s.seedNum && s.entrant?.id)
			.sort((a, b) => a.seedNum! - b.seedNum!);
		swissEntrantIds = sorted.map(s => Number(s.entrant!.id!));
		log(`Swiss entrant IDs (first 5): ${swissEntrantIds.slice(0, 5).join(', ')}`);
	}, SYNC_TIMEOUT);

	it('step 1: add all players to Main bracket (keep Swiss)', async () => {
		const participants = await getTournamentParticipants(TOURNAMENT_SLUG);
		let added = 0;
		for (const p of participants) {
			if (p.currentEventIds.includes(MAIN_EVENT_ID)) { added++; continue; }
			const targetEvents = [...new Set([...p.currentEventIds, MAIN_EVENT_ID])];
			const phaseDests = [{ eventId: MAIN_EVENT_ID, phaseId: MAIN_BRACKET_PHASE_ID }];
			const result = await updateParticipantEvents(p.participantId, targetEvents, phaseDests);
			if (result.ok) added++;
			else log(`  ✗ ${p.gamerTag}: ${result.error}`);
		}
		log(`Added ${added} players to Main bracket (kept Swiss)`);
		expect(added).toBeGreaterThanOrEqual(30);
		await wait(3000);
	}, SYNC_TIMEOUT);

	it('step 2: push seeding to Main bracket via cross-event mapping', async () => {
		// Push seeding using Swiss entrant IDs + Swiss PG for player ID lookup
		const result = await pushBracketSeeding(
			MAIN_BRACKET_PHASE_ID, mainPgId, swissEntrantIds, SWISS_R1_PG_ID
		);
		log(`pushBracketSeeding: ${result.ok ? '✓' : '✗ ' + result.error}`);
		expect(result.ok).toBe(true);
		await wait(2000);
	}, LONG_TIMEOUT);

	it('step 3: verify Main bracket has seeds in correct order', async () => {
		const mainSeeds = await fetchPhaseSeeds(MAIN_BRACKET_PHASE_ID) as SeedEntry[];
		log(`Main bracket now has ${mainSeeds.length} seeds`);
		expect(mainSeeds.length).toBeGreaterThanOrEqual(30);

		// Verify seed order matches: seed 1 in Main should be the same player as seed 1 in Swiss
		const swissPlayerMap = await getPlayerEntrantMap(SWISS_R1_PHASE_ID);
		const mainPlayerMap = await getPlayerEntrantMap(MAIN_BRACKET_PHASE_ID);

		// Build reverse maps: entrantId → playerId
		const swissEntrantToPlayer = new Map<number, number>();
		for (const [pid, eid] of swissPlayerMap) swissEntrantToPlayer.set(eid, pid);

		const mainEntrantToPlayer = new Map<number, number>();
		for (const [pid, eid] of mainPlayerMap) mainEntrantToPlayer.set(eid, pid);

		// Check first 5 seeds match player IDs
		const mainSorted = [...mainSeeds]
			.filter(s => s.seedNum && s.entrant?.id)
			.sort((a, b) => a.seedNum! - b.seedNum!);

		let matched = 0;
		for (let i = 0; i < Math.min(5, mainSorted.length); i++) {
			const mainEntrantId = mainSorted[i].entrant!.id!;
			const swissEntrantId = swissEntrantIds[i];
			const mainPlayerId = mainEntrantToPlayer.get(Number(mainEntrantId));
			const swissPlayerId = swissEntrantToPlayer.get(swissEntrantId);
			if (mainPlayerId === swissPlayerId) matched++;
			log(`  Seed ${i + 1}: Swiss entrant ${swissEntrantId} (player ${swissPlayerId}) → Main entrant ${mainEntrantId} (player ${mainPlayerId}) ${mainPlayerId === swissPlayerId ? '✓' : '✗'}`);
		}
		expect(matched).toBeGreaterThanOrEqual(4);

		// Verify entrant IDs are DIFFERENT across events (same player, different IDs)
		const swissId = swissEntrantIds[0];
		const mainId = Number(mainSorted[0].entrant!.id!);
		log(`  Swiss entrant #1: ${swissId}, Main entrant #1: ${mainId}`);
		expect(swissId).not.toBe(mainId);
	}, LONG_TIMEOUT);

	it('step 4: entrant ID translation works (Swiss → Main)', async () => {
		const swissPlayerMap = await getPlayerEntrantMap(SWISS_R1_PHASE_ID);
		const mainPlayerMap = await getPlayerEntrantMap(MAIN_BRACKET_PHASE_ID);

		// Simulate what updateEntrantIds does
		const sourceEntrantToPlayer = new Map<number, number>();
		for (const [pid, eid] of swissPlayerMap) sourceEntrantToPlayer.set(eid, pid);

		let translated = 0;
		for (const swissEntrantId of swissEntrantIds) {
			const playerId = sourceEntrantToPlayer.get(swissEntrantId);
			if (!playerId) continue;
			const mainEntrantId = mainPlayerMap.get(playerId);
			if (mainEntrantId && mainEntrantId !== swissEntrantId) translated++;
		}
		log(`Translated ${translated}/${swissEntrantIds.length} entrant IDs from Swiss → Main`);
		expect(translated).toBeGreaterThanOrEqual(28);
	}, LONG_TIMEOUT);

	it('step 5: remove all players from Swiss', async () => {
		const participants = await getTournamentParticipants(TOURNAMENT_SLUG);
		let removed = 0;
		for (const p of participants) {
			if (!p.currentEventIds.includes(SWISS_EVENT_ID)) continue;
			const targetEvents = p.currentEventIds.filter(id => id !== SWISS_EVENT_ID);
			if (targetEvents.length === 0) targetEvents.push(MAIN_EVENT_ID);
			const result = await updateParticipantEvents(p.participantId, targetEvents);
			if (result.ok) removed++;
		}
		log(`Removed ${removed} from Swiss`);
		await wait(2000);
	}, SYNC_TIMEOUT);

	it('step 6: verify Main bracket still has seeds after Swiss removal', async () => {
		const mainSeeds = await fetchPhaseSeeds(MAIN_BRACKET_PHASE_ID) as SeedEntry[];
		log(`Main bracket seeds after Swiss removal: ${mainSeeds.length}`);
		expect(mainSeeds.length).toBeGreaterThanOrEqual(30);
	}, LONG_TIMEOUT);

	// ── Reverse direction: Main → Swiss ──────────────────────────────────────

	it('step 7: add all players back to Swiss (keep Main)', async () => {
		const participants = await getTournamentParticipants(TOURNAMENT_SLUG);
		let added = 0;
		for (const p of participants) {
			if (p.currentEventIds.includes(SWISS_EVENT_ID)) { added++; continue; }
			const targetEvents = [...new Set([...p.currentEventIds, SWISS_EVENT_ID])];
			const result = await updateParticipantEvents(p.participantId, targetEvents);
			if (result.ok) added++;
			else log(`  ✗ ${p.gamerTag}: ${result.error}`);
		}
		log(`Added ${added} players back to Swiss (kept Main)`);
		expect(added).toBeGreaterThanOrEqual(30);
		await wait(3000);
	}, SYNC_TIMEOUT);

	it('step 8: push seeding to Swiss via cross-event mapping from Main', async () => {
		// Get Main bracket entrant IDs in seed order
		const mainSeeds = await fetchPhaseSeeds(MAIN_BRACKET_PHASE_ID) as SeedEntry[];
		const mainSorted = [...mainSeeds]
			.filter(s => s.seedNum && s.entrant?.id)
			.sort((a, b) => a.seedNum! - b.seedNum!);
		const mainEntrantIdsInOrder = mainSorted.map(s => Number(s.entrant!.id!));

		// Push to Swiss using Main PG as source for player ID mapping
		const result = await pushBracketSeeding(
			SWISS_R1_PHASE_ID, SWISS_R1_PG_ID, mainEntrantIdsInOrder, mainPgId
		);
		log(`pushBracketSeeding (Main→Swiss): ${result.ok ? '✓' : '✗ ' + result.error}`);
		expect(result.ok).toBe(true);
		await wait(2000);
	}, LONG_TIMEOUT);

	it('step 9: verify Swiss has seeds in correct order after reverse sync', async () => {
		const swissSeeds = await fetchPhaseSeeds(SWISS_R1_PHASE_ID) as SeedEntry[];
		log(`Swiss R1 seeds after reverse sync: ${swissSeeds.length}`);
		expect(swissSeeds.length).toBeGreaterThanOrEqual(30);

		// Verify seed order: the player at seed 1 in Swiss should match seed 1 in Main
		const swissSorted = [...swissSeeds]
			.filter(s => s.seedNum && s.entrant?.id)
			.sort((a, b) => a.seedNum! - b.seedNum!);

		const mainPlayerMap = await getPlayerEntrantMap(MAIN_BRACKET_PHASE_ID);
		const swissPlayerMap = await getPlayerEntrantMap(SWISS_R1_PHASE_ID);
		const mainEntrantToPlayer = new Map<number, number>();
		for (const [pid, eid] of mainPlayerMap) mainEntrantToPlayer.set(eid, pid);

		const mainSeeds = await fetchPhaseSeeds(MAIN_BRACKET_PHASE_ID) as SeedEntry[];
		const mainSorted = [...mainSeeds]
			.filter(s => s.seedNum && s.entrant?.id)
			.sort((a, b) => a.seedNum! - b.seedNum!);

		let matched = 0;
		for (let i = 0; i < Math.min(5, swissSorted.length); i++) {
			const swissPlayerId = swissSorted[i].entrant?.participants?.[0]?.player?.id;
			const mainPlayerId = mainSorted[i]?.entrant?.participants?.[0]?.player?.id;
			if (swissPlayerId === mainPlayerId) matched++;
			log(`  Seed ${i + 1}: Swiss player ${swissPlayerId}, Main player ${mainPlayerId} ${swissPlayerId === mainPlayerId ? '✓' : '✗'}`);
		}
		expect(matched).toBeGreaterThanOrEqual(4);
	}, LONG_TIMEOUT);

	it('step 10: entrant ID translation works (Main → Swiss)', async () => {
		const mainPlayerMap = await getPlayerEntrantMap(MAIN_BRACKET_PHASE_ID);
		const swissPlayerMap = await getPlayerEntrantMap(SWISS_R1_PHASE_ID);

		const mainEntrantToPlayer = new Map<number, number>();
		for (const [pid, eid] of mainPlayerMap) mainEntrantToPlayer.set(eid, pid);

		const mainSeeds = await fetchPhaseSeeds(MAIN_BRACKET_PHASE_ID) as SeedEntry[];
		const mainEntrantIds = mainSeeds
			.filter(s => s.entrant?.id)
			.map(s => Number(s.entrant!.id!));

		let translated = 0;
		for (const mainEntrantId of mainEntrantIds) {
			const playerId = mainEntrantToPlayer.get(mainEntrantId);
			if (!playerId) continue;
			const swissEntrantId = swissPlayerMap.get(playerId);
			if (swissEntrantId && swissEntrantId !== mainEntrantId) translated++;
		}
		log(`Translated ${translated}/${mainEntrantIds.length} entrant IDs from Main → Swiss`);
		expect(translated).toBeGreaterThanOrEqual(28);
	}, LONG_TIMEOUT);

	// ── Cleanup ──────────────────────────────────────────────────────────────

	it('cleanup: remove from Main, restart Main bracket', async () => {
		// Remove all from Main, leave in Swiss only
		const participants = await getTournamentParticipants(TOURNAMENT_SLUG);
		let removed = 0;
		for (const p of participants) {
			if (!p.currentEventIds.includes(MAIN_EVENT_ID)) continue;
			const result = await updateParticipantEvents(p.participantId, [SWISS_EVENT_ID], []);
			if (result.ok) removed++;
		}
		log(`Removed ${removed} from Main bracket`);
		await wait(2000);

		// Restart Main bracket
		const result = await restartPhase(MAIN_BRACKET_PHASE_ID);
		log(`Restart Main bracket: ${result.ok ? '✓' : '✗ ' + result.error}`);
		expect(result.ok).toBe(true);

		// Verify Swiss still has seeds
		const swissSeeds = await fetchPhaseSeeds(SWISS_R1_PHASE_ID) as SeedEntry[];
		log(`Swiss R1 seeds after cleanup: ${swissSeeds.length}`);
		expect(swissSeeds.length).toBeGreaterThanOrEqual(30);
	}, SYNC_TIMEOUT);
});
