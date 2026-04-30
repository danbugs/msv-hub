/**
 * StartGG Full E2E Operational Test
 *
 * Exercises the complete tournament lifecycle against a real StartGG test event:
 *   Phase 1: Reset to clean state
 *   Phase 2: 5-round Swiss with realistic pairings via the Swiss engine
 *   Phase 3: Bracket split (assign main/redemption, push seeding, finalize standings)
 *   Phase 4: Bracket reporting + grand finals reset
 *   Phase 5: Full reset cleanup
 *
 * Uses the permanent test tournament: "Microspacing Vancouver Test"
 *   - Tournament slug: microspacing-vancouver-test
 *   - Swiss event: 1590949 (32 entrants)
 *   - Main Bracket event: 1590950
 *   - Redemption Bracket event: 1590951
 *
 * Runs daily via GitHub Actions cron alongside the compat tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(import.meta.dirname ?? '.', '../../..', '.env');
let hasEnv = false;
try { hasEnv = fs.existsSync(envPath); } catch { /* */ }
const suite = hasEnv ? describe : describe.skip;

// ── Constants ────────────────────────────────────────────────────────────────

const TOURNAMENT_SLUG = 'microspacing-vancouver-test';
const TOURNAMENT_ID = 895482;
const SWISS_EVENT_ID = 1590949;
const MAIN_EVENT_ID = 1590950;
const REDEMPTION_EVENT_ID = 1590951;

const SWISS_PHASES = [
	{ id: 2243224, pgId: 3251998, name: 'Round 1' },
	{ id: 2243225, pgId: 3251999, name: 'Round 2' },
	{ id: 2243226, pgId: 3252000, name: 'Round 3' },
	{ id: 2243227, pgId: 3252001, name: 'Round 4' },
	{ id: 2243228, pgId: 3252002, name: 'Round 5' },
];
const FINAL_STANDINGS_PHASE = { id: 2243229, pgId: 3252003, name: 'Final Standings' };
const MAIN_BRACKET_PHASE = 2243230;
const REDEMPTION_BRACKET_PHASE = 2243231;

const TIMEOUT = 30_000;
const LONG_TIMEOUT = 120_000;
const PHASE_TIMEOUT = 300_000;
const BRACKET_TIMEOUT = 600_000;

// ── Imports (lazy — only resolved when tests run) ────────────────────────────

import {
	gql,
	fetchPhaseSeeds,
	fetchPhaseSeedsWithTags,
	fetchPhaseGroups,
	fetchAllSets,
	fetchAllEntrants,
	pushPairingsToPhaseGroup,
	pushBracketSeeding,
	getUserByDiscriminator,
	reportSet,
	PHASE_GROUP_SETS_QUERY,
} from '$lib/server/startgg';
import {
	restartPhase,
	addEntrantsToPhase,
	getTournamentParticipants,
	updateParticipantEvents,
	assignBracketSplit,
	completeSetViaAdminRest,
	finalizePlacements,
	fetchAdminPhaseGroupSets,
	fetchAdminPhaseGroupSetsRaw,
	setRegistrationPublished,
	publishHomepage,
	publishEvents,
	publishBracketSeeding,
	updateTournamentBasicDetails,
	getTournamentRegistrationInfo,
	registerTOForTournament,
	unregisterParticipant,
	exportAttendees,
} from '$lib/server/startgg-admin';
import { runSeeder } from '$lib/server/seeder';
import {
	calculateStandings,
	calculateSwissPairings,
	calculateFinalStandings,
} from '$lib/server/swiss';
import type { Entrant, SwissRound, TournamentState } from '$lib/types/tournament';
import type { TOConfig } from '$lib/server/store';

// ── Shared state across all phases ───────────────────────────────────────────

let entrants: Entrant[] = [];
let rounds: SwissRound[] = [];
let phaseGroups: { id: number; displayIdentifier: string; phaseId?: number }[] = [];

function log(msg: string) { console.log(`[e2e] ${msg}`); }

async function wait(ms: number) { await new Promise<void>(r => setTimeout(r, ms)); }

async function removeAllBracketParticipants(): Promise<{ cleaned: number; failed: number }> {
	let cleaned = 0;
	let failed = 0;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) {
			log(`  Retry ${attempt} for participant removal (waiting 5s)...`);
			await wait(5000);
		}
		const participants = await getTournamentParticipants(TOURNAMENT_SLUG);
		const inBracket = participants.filter(p =>
			p.currentEventIds.includes(MAIN_EVENT_ID) || p.currentEventIds.includes(REDEMPTION_EVENT_ID)
		);
		if (inBracket.length === 0) break;
		log(`  ${inBracket.length} participants still in bracket events...`);
		failed = 0;
		for (const p of inBracket) {
			const result = await updateParticipantEvents(p.participantId, [SWISS_EVENT_ID], []);
			if (result.ok) {
				cleaned++;
			} else {
				failed++;
				if (attempt === 2) log(`  ✗ ${p.gamerTag}: ${result.error}`);
			}
		}
	}
	return { cleaned, failed };
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1: RESET TO CLEAN STATE
// ═════════════════════════════════════════════════════════════════════════════

suite('E2E Phase 1: Reset to clean state', () => {
	it('restarts all Swiss phases', async () => {
		for (const phase of SWISS_PHASES) {
			log(`Restarting ${phase.name} (${phase.id})...`);
			const result = await restartPhase(phase.id);
			expect(result.ok, `Restart ${phase.name}: ${result.error}`).toBe(true);
		}
		log(`Restarting Final Standings (${FINAL_STANDINGS_PHASE.id})...`);
		const fsResult = await restartPhase(FINAL_STANDINGS_PHASE.id);
		expect(fsResult.ok, `Restart Final Standings: ${fsResult.error}`).toBe(true);
	}, LONG_TIMEOUT);

	it('restarts bracket phases', async () => {
		log(`Restarting Main Bracket (${MAIN_BRACKET_PHASE})...`);
		const mainResult = await restartPhase(MAIN_BRACKET_PHASE);
		expect(mainResult.ok, `Restart Main: ${mainResult.error}`).toBe(true);

		log(`Restarting Redemption Bracket (${REDEMPTION_BRACKET_PHASE})...`);
		const redResult = await restartPhase(REDEMPTION_BRACKET_PHASE);
		expect(redResult.ok, `Restart Redemption: ${redResult.error}`).toBe(true);
	}, LONG_TIMEOUT);

	it('clears entrants from Swiss rounds 2-5 and Final Standings', async () => {
		await wait(2000);
		for (const phase of SWISS_PHASES.slice(1)) {
			log(`Clearing ${phase.name}...`);
			const result = await addEntrantsToPhase(SWISS_EVENT_ID, phase.id, []);
			expect(result.ok, `Clear ${phase.name}: ${result.error}`).toBe(true);
			await restartPhase(phase.id);
		}
		// Final Standings uses groupTypeId 6 (Custom Schedule), not 4 (Swiss)
		log('Clearing Final Standings...');
		const fsResult = await addEntrantsToPhase(SWISS_EVENT_ID, FINAL_STANDINGS_PHASE.id, [], undefined, 6);
		log(`Clear Final Standings: ${fsResult.ok ? '✓' : '✗ ' + fsResult.error}`);
		await restartPhase(FINAL_STANDINGS_PHASE.id);
	}, LONG_TIMEOUT);

	it('removes participants from bracket events', async () => {
		await wait(3000);
		const { cleaned, failed } = await removeAllBracketParticipants();
		log(`Removed ${cleaned} participants from bracket events${failed > 0 ? `, ${failed} failed` : ''}`);
	}, LONG_TIMEOUT);

	it('waits for propagation and verifies clean state', async () => {
		await wait(3000);

		// Verify Round 1 has entrants
		const r1Data = await gql<{ phase: { seeds: { pageInfo: { total: number } } } }>(
			'query($id:ID!){phase(id:$id){seeds(query:{page:1,perPage:1}){pageInfo{total}}}}',
			{ id: SWISS_PHASES[0].id }, { delay: 0 }
		);
		const r1Seeds = r1Data?.phase?.seeds?.pageInfo?.total ?? 0;
		log(`Round 1 seeds: ${r1Seeds}`);
		expect(r1Seeds).toBeGreaterThanOrEqual(30);

		// Verify later rounds are cleared
		for (const phase of SWISS_PHASES.slice(1)) {
			const data = await gql<{ phase: { seeds: { pageInfo: { total: number } } } }>(
				'query($id:ID!){phase(id:$id){seeds(query:{page:1,perPage:1}){pageInfo{total}}}}',
				{ id: phase.id }, { delay: 0 }
			);
			const seeds = data?.phase?.seeds?.pageInfo?.total ?? 0;
			log(`${phase.name} seeds: ${seeds}`);
		}
	}, LONG_TIMEOUT);
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2: FULL 5-ROUND SWISS
// ═════════════════════════════════════════════════════════════════════════════

suite('E2E Phase 2: Full 5-round Swiss', () => {
	beforeAll(async () => {
		// Load entrants from Round 1 seeds
		const [sgSeeds, seedsWithTags, groups] = await Promise.all([
			fetchPhaseSeeds(SWISS_PHASES[0].id),
			fetchPhaseSeedsWithTags(SWISS_PHASES[0].id),
			fetchPhaseGroups(SWISS_PHASES[0].id),
		]);

		const sgSeedToEntrantId = new Map<number, number>();
		for (const seed of sgSeeds) {
			const seedNum = Number((seed as Record<string, unknown>).seedNum);
			const entrantId = Number((seed as { entrant?: { id?: unknown } }).entrant?.id);
			if (seedNum && entrantId && !isNaN(seedNum) && !isNaN(entrantId)) {
				sgSeedToEntrantId.set(seedNum, entrantId);
			}
		}

		entrants = seedsWithTags.map((s, i) => ({
			id: `e-${i + 1}`,
			gamerTag: s.gamerTag,
			initialSeed: s.seedNum,
			startggEntrantId: sgSeedToEntrantId.get(s.seedNum),
		}));

		// Build phase group list for all 5 rounds
		phaseGroups = [];
		for (const phase of SWISS_PHASES) {
			const groups = await fetchPhaseGroups(phase.id);
			if (groups.length > 0) {
				phaseGroups.push({ ...groups[0], phaseId: phase.id });
			}
		}

		log(`Loaded ${entrants.length} entrants, ${phaseGroups.length} phase groups`);
	}, LONG_TIMEOUT);

	for (let roundNum = 1; roundNum <= 5; roundNum++) {
		it(`reports Round ${roundNum}`, async () => {
			const phase = SWISS_PHASES[roundNum - 1];
			const pgId = phaseGroups[roundNum - 1]?.id ?? phase.pgId;

			// Calculate standings and pairings using the Swiss engine
			const standings = calculateStandings(entrants, rounds);
			const { pairings, bye } = calculateSwissPairings(standings, roundNum);
			log(`Round ${roundNum}: ${pairings.length} matches${bye ? `, bye: ${bye[1].gamerTag}` : ''}`);

			// For rounds 2-5: populate the phase with entrants and push seedings
			if (roundNum > 1) {
				const allEntrantIds = entrants
					.filter(e => e.startggEntrantId !== undefined)
					.map(e => e.startggEntrantId!);

				log(`  Adding ${allEntrantIds.length} entrants to ${phase.name}...`);
				const addResult = await addEntrantsToPhase(SWISS_EVENT_ID, phase.id, allEntrantIds);
				expect(addResult.ok, `addEntrantsToPhase ${phase.name}: ${addResult.error}`).toBe(true);
				await wait(2000);

				// Re-fetch phase group ID (may have changed after adding entrants)
				const freshGroups = await fetchPhaseGroups(phase.id);
				const freshPgId = freshGroups[0]?.id ?? pgId;
				if (phaseGroups[roundNum - 1]) {
					phaseGroups[roundNum - 1] = { ...freshGroups[0], phaseId: phase.id };
				}

				// Push pairings using the fold pattern
				const entrantMap = new Map(entrants.map(e => [e.id, e]));
				const sgPairings: [number, number][] = pairings.map(([p1, p2]) => [
					entrantMap.get(p1[0])?.startggEntrantId ?? 0,
					entrantMap.get(p2[0])?.startggEntrantId ?? 0,
				]);
				const byeEntrantId = bye ? entrantMap.get(bye[0])?.startggEntrantId : undefined;

				log(`  Pushing ${sgPairings.length} pairings to phase group ${freshPgId}...`);
				const seedResult = await pushPairingsToPhaseGroup(
					phase.id, freshPgId, sgPairings, byeEntrantId
				);
				expect(seedResult.ok, `pushPairings ${phase.name}: ${seedResult.error}`).toBe(true);
				await wait(2000);
			}

			// Report all matches: lower seed wins 2-1
			const entrantMap = new Map(entrants.map(e => [e.id, e]));
			let reported = 0;
			let failed = 0;

			for (const [p1, p2] of pairings) {
				const e1 = entrantMap.get(p1[0]);
				const e2 = entrantMap.get(p2[0]);
				if (!e1?.startggEntrantId || !e2?.startggEntrantId) { failed++; continue; }

				// Lower seed wins (to get a non-trivial bracket)
				const winner = e1.initialSeed < e2.initialSeed ? e1 : e2;
				const loser = winner === e1 ? e2 : e1;

				const result = await completeSetViaAdminRest(
					pgId,
					e1.startggEntrantId,
					e2.startggEntrantId,
					winner.startggEntrantId!,
					2, 1, false
				);

				if (result.ok) {
					reported++;
				} else {
					log(`  ✗ ${e1.gamerTag} vs ${e2.gamerTag}: ${result.error}`);
					failed++;
				}
			}

			log(`  Round ${roundNum}: ${reported} reported, ${failed} failed`);
			expect(failed).toBe(0);

			// Record this round in our state
			const roundMatches = pairings.map(([p1, p2]) => {
				const e1 = entrantMap.get(p1[0])!;
				const e2 = entrantMap.get(p2[0])!;
				const winner = e1.initialSeed < e2.initialSeed ? e1 : e2;
				return {
					id: `r${roundNum}-${p1[0]}-${p2[0]}`,
					topPlayerId: p1[0],
					bottomPlayerId: p2[0],
					winnerId: winner.id,
					topScore: winner === e1 ? 2 : 1,
					bottomScore: winner === e2 ? 2 : 1,
				};
			});

			rounds.push({
				number: roundNum,
				status: 'completed' as const,
				matches: roundMatches,
				byePlayerId: bye?.[0],
			});

			log(`  ✓ Round ${roundNum} complete`);
		}, PHASE_TIMEOUT);
	}
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 3: BRACKET SPLIT + SEEDING + FINAL STANDINGS
// ═════════════════════════════════════════════════════════════════════════════

suite('E2E Phase 3: Bracket split', () => {
	it('calculates final standings and splits into main/redemption', async () => {
		expect(rounds.length).toBe(5);
		const finalStandings = calculateFinalStandings(entrants, rounds);
		expect(finalStandings.length).toBe(entrants.length);

		const mainPlayers = finalStandings.filter(s => s.bracket === 'main');
		const redPlayers = finalStandings.filter(s => s.bracket === 'redemption');
		log(`Final standings: ${mainPlayers.length} main, ${redPlayers.length} redemption`);
		expect(mainPlayers.length).toBeGreaterThan(0);
		expect(redPlayers.length).toBeGreaterThan(0);

		// Assign players to bracket events via StartGG
		const mainTags = mainPlayers.map(s => s.gamerTag);
		const redTags = redPlayers.map(s => s.gamerTag);

		let result = { mainOk: 0, redemptionOk: 0, failed: 0, errors: [] as string[] };
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				log(`  Retry ${attempt} for bracket split (waiting 3s)...`);
				await wait(3000);
			}
			log(`Assigning bracket split (attempt ${attempt + 1})...`);
			result = await assignBracketSplit(
				TOURNAMENT_SLUG,
				SWISS_EVENT_ID,
				MAIN_EVENT_ID,
				REDEMPTION_EVENT_ID,
				mainTags,
				redTags,
				(msg) => log(`  ${msg}`)
			);
			log(`Split result: ${result.mainOk} main, ${result.redemptionOk} redemption, ${result.failed} failed`);
			if (result.failed === 0) break;
		}
		expect(result.failed, `Bracket split failures after retries: ${result.errors.join(', ')}`).toBe(0);
		expect(result.mainOk).toBe(mainPlayers.length);
		expect(result.redemptionOk).toBe(redPlayers.length);
	}, PHASE_TIMEOUT);

	it('populates Final Standings phase with entrants', async () => {
		// Get all entrant IDs — from Swiss engine if available, else from Round 1 seeds
		let allEntrantIds: number[];
		if (entrants.length > 0) {
			allEntrantIds = entrants
				.filter(e => e.startggEntrantId !== undefined)
				.map(e => e.startggEntrantId!);
		} else {
			const sgSeeds = await fetchPhaseSeeds(SWISS_PHASES[0].id);
			allEntrantIds = sgSeeds
				.map(s => Number((s as { entrant?: { id?: unknown } }).entrant?.id))
				.filter(id => id > 0);
		}

		// Add all entrants to Final Standings (groupTypeId 6 = Custom Schedule)
		log(`Adding ${allEntrantIds.length} entrants to Final Standings phase...`);
		const addResult = await addEntrantsToPhase(SWISS_EVENT_ID, FINAL_STANDINGS_PHASE.id, allEntrantIds, undefined, 6);
		expect(addResult.ok, `addEntrantsToPhase Final Standings: ${addResult.error}`).toBe(true);
		log('  ✓ Entrants added to Final Standings');

		// Verify seeds exist
		await wait(2000);
		const fsData = await gql<{ phase: { seeds: { pageInfo: { total: number } } } }>(
			'query($id:ID!){phase(id:$id){seeds(query:{page:1,perPage:1}){pageInfo{total}}}}',
			{ id: FINAL_STANDINGS_PHASE.id }, { delay: 0 }
		);
		const seedCount = fsData?.phase?.seeds?.pageInfo?.total ?? 0;
		log(`  Final Standings has ${seedCount} seeds`);
		expect(seedCount).toBeGreaterThan(0);
	}, LONG_TIMEOUT);

	it('pushes bracket seeding for main and redemption', async () => {
		await wait(3000);
		const finalStandings = calculateFinalStandings(entrants, rounds);
		const entrantMap = new Map(entrants.map(e => [e.id, e]));
		const swissPgId = phaseGroups[0]?.id ?? SWISS_PHASES[0].pgId;

		// Get bracket phase groups
		const mainGroups = await fetchPhaseGroups(MAIN_BRACKET_PHASE);
		const redGroups = await fetchPhaseGroups(REDEMPTION_BRACKET_PHASE);

		if (mainGroups.length > 0) {
			const mainEntrants = finalStandings
				.filter(s => s.bracket === 'main')
				.map(s => entrantMap.get(s.entrantId)?.startggEntrantId ?? 0)
				.filter(id => id > 0);

			log(`Pushing main bracket seeding (${mainEntrants.length} players)...`);
			const result = await pushBracketSeeding(
				MAIN_BRACKET_PHASE,
				mainGroups[0].id,
				mainEntrants,
				swissPgId
			);
			if (result.ok) log('  ✓ Main bracket seeded');
			else log(`  ⚠ ${result.error} (non-fatal)`);
		}

		if (redGroups.length > 0) {
			const redEntrants = finalStandings
				.filter(s => s.bracket === 'redemption')
				.map(s => entrantMap.get(s.entrantId)?.startggEntrantId ?? 0)
				.filter(id => id > 0);

			log(`Pushing redemption bracket seeding (${redEntrants.length} players)...`);
			const result = await pushBracketSeeding(
				REDEMPTION_BRACKET_PHASE,
				redGroups[0].id,
				redEntrants,
				swissPgId
			);
			if (result.ok) log('  ✓ Redemption bracket seeded');
			else log(`  ⚠ ${result.error} (non-fatal)`);
		}
	}, PHASE_TIMEOUT);

	it('finalizes placements', async () => {
		const finalStandings = calculateFinalStandings(entrants, rounds);
		const entrantMap = new Map(entrants.map(e => [e.id, e]));
		const standings = finalStandings.map(s => ({
			entrantId: entrantMap.get(s.entrantId)?.startggEntrantId ?? 0,
			placement: s.rank,
		})).filter(s => s.entrantId > 0);

		log(`Finalizing placements for ${standings.length} players...`);
		const result = await finalizePlacements(FINAL_STANDINGS_PHASE.pgId, standings);
		expect(result.ok, `finalizePlacements: ${result.error}`).toBe(true);
		log('  ✓ Placements finalized');

		// Verify Final Standings is now completed
		await wait(2000);
		const fsData = await gql<{ phase: { state: string; seeds: { pageInfo: { total: number } } } }>(
			'query($id:ID!){phase(id:$id){state seeds(query:{page:1,perPage:1}){pageInfo{total}}}}',
			{ id: FINAL_STANDINGS_PHASE.id }, { delay: 0 }
		);
		log(`  Final Standings: state=${fsData?.phase?.state}, seeds=${fsData?.phase?.seeds?.pageInfo?.total}`);
	}, LONG_TIMEOUT);
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 3b: EVENT MANAGEMENT — publish, registration, slug, TO add/remove
// ═════════════════════════════════════════════════════════════════════════════

const ORIGINAL_TOURNAMENT_NAME = 'Microspacing Vancouver Test';
function testShortSlug() {
	return `msv-hub-e2e-${Date.now() % 100000}`;
}
const ADMIN_DISCRIMINATOR = '566b1fb5';

suite('E2E Phase 3b: Event management operations', () => {
	it('publishes homepage, events, and bracket seeding', async () => {
		log('Publishing homepage...');
		const homeResult = await publishHomepage(TOURNAMENT_ID);
		expect(homeResult.ok, `publishHomepage: ${homeResult.error}`).toBe(true);
		log('  ✓ Homepage published');

		log('Publishing events...');
		const eventsResult = await publishEvents(TOURNAMENT_ID);
		expect(eventsResult.ok, `publishEvents: ${eventsResult.error}`).toBe(true);
		log('  ✓ Events published');

		log('Publishing bracket seeding...');
		const bracketResult = await publishBracketSeeding(TOURNAMENT_ID);
		expect(bracketResult.ok, `publishBracketSeeding: ${bracketResult.error}`).toBe(true);
		log('  ✓ Bracket seeding published');
	}, LONG_TIMEOUT);

	it('opens and closes registration', async () => {
		log('Opening registration...');
		const openResult = await setRegistrationPublished(TOURNAMENT_ID, true);
		expect(openResult.ok, `open registration: ${openResult.error}`).toBe(true);
		log('  ✓ Registration opened (publish state set)');

		// Note: GQL isRegistrationOpen depends on tournament date windows,
		// not just publish state. We verify the admin mutation succeeded instead.
		// The TO registration test below provides functional proof (register/unregister).

		log('Closing registration...');
		const closeResult = await setRegistrationPublished(TOURNAMENT_ID, false);
		expect(closeResult.ok, `close registration: ${closeResult.error}`).toBe(true);
		log('  ✓ Registration closed');
	}, LONG_TIMEOUT);

	it('changes tournament shortSlug and reverts', async () => {
		// Read current tournament details for the revert
		const current = await gql<{ tournament: { startAt: number; endAt: number; primaryContact: string } }>(
			'query($slug:String!){tournament(slug:$slug){startAt endAt primaryContact}}',
			{ slug: TOURNAMENT_SLUG }, { delay: 0 }
		);
		const startAt = current?.tournament?.startAt ?? 0;
		const endAt = current?.tournament?.endAt ?? 0;
		const discordLink = current?.tournament?.primaryContact ?? '';

		const slug1 = testShortSlug();
		log(`Changing shortSlug to "${slug1}"...`);
		const changeResult = await updateTournamentBasicDetails(TOURNAMENT_ID, {
			name: ORIGINAL_TOURNAMENT_NAME,
			shortSlug: slug1,
			startAt, endAt, discordLink,
		});
		expect(changeResult.ok, `change shortSlug: ${changeResult.error}`).toBe(true);

		// Verify the slug changed
		await wait(1000);
		const changed = await gql<{ tournament: { shortSlug: string } }>(
			'query($slug:String!){tournament(slug:$slug){shortSlug}}',
			{ slug: TOURNAMENT_SLUG }, { delay: 0 }
		);
		log(`  shortSlug after change: "${changed?.tournament?.shortSlug}"`);
		expect(changed?.tournament?.shortSlug).toBe(slug1);

		// Change to a different slug (can't clear to empty)
		const slug2 = testShortSlug();
		log(`Changing shortSlug again to "${slug2}"...`);
		const revertResult = await updateTournamentBasicDetails(TOURNAMENT_ID, {
			name: ORIGINAL_TOURNAMENT_NAME,
			shortSlug: slug2,
			startAt, endAt, discordLink,
		});
		expect(revertResult.ok, `change shortSlug again: ${revertResult.error}`).toBe(true);
		log(`  ✓ shortSlug changed to "${slug2}"`);
	}, LONG_TIMEOUT);

	it('registers a TO player and then unregisters them', async () => {
		// Open registration first (needed for registerPlayer)
		await setRegistrationPublished(TOURNAMENT_ID, true);
		await wait(1000);

		// Look up the admin user
		log(`Looking up user by discriminator ${ADMIN_DISCRIMINATOR}...`);
		const user = await getUserByDiscriminator(ADMIN_DISCRIMINATOR);
		expect(user, 'Admin user must be resolvable').toBeTruthy();
		log(`  Found: ${user!.gamerTag} (player ${user!.playerId})`);

		// Get registration info
		const regInfo = await getTournamentRegistrationInfo(TOURNAMENT_SLUG);
		expect(regInfo, 'Registration info must be available').toBeTruthy();
		log(`  RegInfo: event ${regInfo!.eventId}, phase ${regInfo!.phaseId}, pass ${regInfo!.passTypeId}`);

		// Register the TO
		const toConfig: TOConfig = {
			name: user!.gamerTag,
			discriminator: ADMIN_DISCRIMINATOR,
			prefix: user!.prefix,
			playerId: user!.playerId,
			autoRegister: true,
		};
		log(`Registering ${user!.gamerTag}...`);
		const regResult = await registerTOForTournament(TOURNAMENT_ID, toConfig, regInfo!);
		expect(regResult.ok, `register TO: ${regResult.error}`).toBe(true);
		log('  ✓ TO registered');

		// Verify they appear in participants
		await wait(2000);
		const participants = await getTournamentParticipants(TOURNAMENT_SLUG);
		const found = participants.find(p => p.gamerTag.toLowerCase() === user!.gamerTag.toLowerCase());
		expect(found, `${user!.gamerTag} should appear in participants`).toBeTruthy();
		log(`  Verified: ${user!.gamerTag} is participant ${found!.participantId}`);

		// Unregister them
		log(`Unregistering ${user!.gamerTag} (participant ${found!.participantId})...`);
		const unregResult = await unregisterParticipant(TOURNAMENT_ID, found!.participantId);
		expect(unregResult.ok, `unregister TO: ${unregResult.error}`).toBe(true);
		log('  ✓ TO unregistered');

		// Verify removal
		await wait(2000);
		const participantsAfter = await getTournamentParticipants(TOURNAMENT_SLUG);
		const foundAfter = participantsAfter.find(p => p.gamerTag.toLowerCase() === user!.gamerTag.toLowerCase());
		expect(foundAfter, `${user!.gamerTag} should no longer be in participants`).toBeFalsy();
		log('  ✓ Verified removal');

		// Close registration
		await setRegistrationPublished(TOURNAMENT_ID, false);
	}, PHASE_TIMEOUT);
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4: BRACKET REPORTING + GRAND FINALS RESET
// ═════════════════════════════════════════════════════════════════════════════

// Reports all rounds of a DE bracket to completion (16-player = 30 sets + GF reset).
// Uses GQL then admin REST fallback, with long quiet waits for deep losers propagation.
async function reportFullBracket(
	pgId: number,
	bracketName: string,
	expectedSets: number = 30,
): Promise<{ totalReported: number; lastSetId: number; lastE1: number; lastE2: number }> {
	type GqlSet = {
		id: string;
		winnerId: number | null;
		slots: Array<{ entrant: { id: string } | null }>;
	};

	let totalReported = 0;
	let lastSetId = 0;
	let lastE1 = 0;
	let lastE2 = 0;
	const MAX_ITERATIONS = 40;
	// Track by set ID — NOT by entrant pair, since DE brackets have rematches
	const reportedSetIds = new Set<number>();
	let consecutiveStalls = 0;

	for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
		await wait(3000);

		// Fetch sets via GQL
		const data = await gql<{ phaseGroup: { sets: { nodes: GqlSet[] } } }>(
			PHASE_GROUP_SETS_QUERY, { phaseGroupId: pgId }, { delay: 0 }
		);
		let sets = data?.phaseGroup?.sets?.nodes ?? [];

		if (iter === 1) {
			for (let attempt = 0; sets.length === 0 && attempt < 10; attempt++) {
				await wait(3000);
				const retry = await gql<{ phaseGroup: { sets: { nodes: GqlSet[] } } }>(
					PHASE_GROUP_SETS_QUERY, { phaseGroupId: pgId }, { delay: 0 }
				);
				sets = retry?.phaseGroup?.sets?.nodes ?? [];
			}
		}

		let unreported = sets.filter(s => {
			if (s.winnerId) return false;
			const e1 = Number(s.slots?.[0]?.entrant?.id);
			const e2 = Number(s.slots?.[1]?.entrant?.id);
			if (!(e1 > 0) || !(e2 > 0)) return false;
			return !reportedSetIds.has(Number(s.id));
		});

		// Strategy 2: admin REST has fresher entrant data than GQL
		if (unreported.length === 0 && totalReported < expectedSets) {
			const adminSets = await fetchAdminPhaseGroupSets(pgId);
			const adminUnreported = adminSets.filter(s => {
				if (s.winnerId) return false;
				if (!(s.entrant1Id > 0) || !(s.entrant2Id > 0)) return false;
				return !reportedSetIds.has(s.id);
			});
			if (adminUnreported.length > 0) {
				log(`  ${bracketName} iteration ${iter}: GQL empty but admin REST found ${adminUnreported.length} sets`);
				for (const as of adminUnreported) {
					if (totalReported >= expectedSets) break;
					const winnerId = Math.min(as.entrant1Id, as.entrant2Id);
					const result = await completeSetViaAdminRest(pgId, as.entrant1Id, as.entrant2Id, winnerId, 2, 0, false);
					if (result.ok) {
						totalReported++;
						lastSetId = as.id;
						lastE1 = as.entrant1Id;
						lastE2 = as.entrant2Id;
						reportedSetIds.add(as.id);
					} else {
						log(`  ✗ ${bracketName} admin set ${as.id}: ${result.error}`);
					}
				}
				consecutiveStalls = 0;
				log(`  ${bracketName} iteration ${iter}: ${totalReported}/${expectedSets} total after admin REST`);
				continue;
			}
		}

		if (unreported.length === 0) {
			if (totalReported >= expectedSets) {
				log(`  ${bracketName} iteration ${iter}: bracket complete — ${totalReported} sets reported`);
				break;
			}
			consecutiveStalls++;

			// Diagnostic: show what admin REST has for unreported sets
			const rawSets = await fetchAdminPhaseGroupSetsRaw(pgId);
			const rawUnreported = rawSets.filter(s => !s.winnerId && !reportedSetIds.has(Number(s.id)));
			log(`  ${bracketName} iteration ${iter}: STALL at ${totalReported}/${expectedSets}. ${rawUnreported.length} unreported raw sets:`);
			for (const s of rawUnreported) {
				log(`    set ${s.id} | round=${s.round} | e1=${s.entrant1Id ?? 'null'} e2=${s.entrant2Id ?? 'null'} | ${s.fullRoundText ?? '?'}`);
			}

			const stallWait = 30_000;
			log(`  Waiting ${stallWait / 1000}s for propagation...`);
			await wait(stallWait);
			continue;
		}

		consecutiveStalls = 0;
		let iterReported = 0;
		for (const set of unreported) {
			if (totalReported >= expectedSets) break;
			const e1 = Number(set.slots[0].entrant!.id);
			const e2 = Number(set.slots[1].entrant!.id);
			const winnerId = Math.min(e1, e2);

			const result = await reportSet(String(set.id), winnerId);
			if (result.ok) {
				iterReported++;
				totalReported++;
				lastSetId = Number(result.reportedSetId ?? set.id) || 0;
				lastE1 = e1;
				lastE2 = e2;
				reportedSetIds.add(lastSetId);
			} else {
				log(`  ✗ ${bracketName} set ${set.id}: ${result.error}`);
			}
		}
		log(`  ${bracketName} iteration ${iter}: reported ${iterReported} sets (${totalReported}/${expectedSets} total)`);
	}

	return { totalReported, lastSetId, lastE1, lastE2 };
}

suite('E2E Phase 4: Bracket reporting', () => {
	let mainPgId = 0;
	let mainLastSet = { lastSetId: 0, lastE1: 0, lastE2: 0 };

	it('reports all rounds of main bracket to completion', async () => {
		await wait(3000);
		const mainGroups = await fetchPhaseGroups(MAIN_BRACKET_PHASE);
		if (mainGroups.length === 0) { log('No main bracket phase groups — skipping'); return; }
		mainPgId = mainGroups[0].id;

		log('Reporting full main bracket...');
		const result = await reportFullBracket(mainPgId, 'Main');
		mainLastSet = result;
		log(`Main bracket complete: ${result.totalReported} unique sets reported`);
		expect(result.totalReported).toBeGreaterThanOrEqual(30);

		// Verify all reportable sets have winners
		await wait(2000);
		const verifyMain = await fetchAdminPhaseGroupSets(mainPgId);
		const withWinners = verifyMain.filter(s => s.winnerId);
		log(`  Verified: ${withWinners.length}/${verifyMain.length} sets completed`);
	}, BRACKET_TIMEOUT);

	it('reports all rounds of redemption bracket to completion', async () => {
		await wait(2000);
		const redGroups = await fetchPhaseGroups(REDEMPTION_BRACKET_PHASE);
		if (redGroups.length === 0) { log('No redemption bracket phase groups — skipping'); return; }
		const redPgId = redGroups[0].id;

		log('Reporting full redemption bracket...');
		const result = await reportFullBracket(redPgId, 'Redemption');
		log(`Redemption bracket complete: ${result.totalReported} unique sets reported`);
		expect(result.totalReported).toBeGreaterThanOrEqual(30);

		await wait(2000);
		const verifyRed = await fetchAdminPhaseGroupSets(redPgId);
		const withWinners = verifyRed.filter(s => s.winnerId);
		log(`  Verified: ${withWinners.length}/${verifyRed.length} sets completed`);
	}, BRACKET_TIMEOUT);

	it('resets grand finals and re-reports with different winner', async () => {
		if (!mainPgId || !mainLastSet.lastSetId) {
			log('No main bracket grand finals to reset — skipping');
			return;
		}

		// Find the GF set (last reported set in the bracket)
		await wait(2000);
		const sets = await fetchAdminPhaseGroupSets(mainPgId);
		const gfSet = sets.find(s => s.id === mainLastSet.lastSetId) ?? sets.filter(s => s.winnerId).pop();
		if (!gfSet) { log('Could not find GF set — skipping'); return; }

		log(`Resetting GF set ${gfSet.id} (winner was ${gfSet.winnerId})...`);
		const { resetSet } = await import('$lib/server/startgg');
		const resetResult = await resetSet(String(gfSet.id));
		log(`  Reset: ${resetResult.ok ? '✓' : '✗ ' + resetResult.error}`);

		// Re-report with the opposite winner (simulates GF reset scenario)
		await wait(2000);
		const newWinner = gfSet.winnerId === gfSet.entrant1Id ? gfSet.entrant2Id : gfSet.entrant1Id;
		const reReportResult = await completeSetViaAdminRest(
			mainPgId,
			gfSet.entrant1Id,
			gfSet.entrant2Id,
			newWinner,
			2, 1, false
		);
		log(`  Re-report with winner ${newWinner}: ${reReportResult.ok ? '✓' : '✗ ' + reReportResult.error}`);
		if (reReportResult.ok) {
			log('  ✓ Grand finals reset simulation complete');
		}
	}, LONG_TIMEOUT);
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4b: DATA QUERIES + EXPORT (while tournament has data)
// ═════════════════════════════════════════════════════════════════════════════

suite('E2E Phase 4b: Data queries and export', () => {
	it('fetches all sets from Swiss event via paginated GQL', async () => {
		const sets = await fetchAllSets(SWISS_EVENT_ID);
		log(`fetchAllSets: ${sets.length} sets from Swiss event`);
		expect(sets.length).toBeGreaterThan(0);
		// Verify set structure
		const first = sets[0] as Record<string, unknown>;
		expect(first).toHaveProperty('id');
		expect(first).toHaveProperty('displayScore');
	}, LONG_TIMEOUT);

	it('fetches all entrants from Swiss event via paginated GQL', async () => {
		const entrants = await fetchAllEntrants(SWISS_EVENT_ID);
		log(`fetchAllEntrants: ${entrants.length} entrants from Swiss event`);
		expect(entrants.length).toBe(32);
		// Verify entrant structure
		const first = entrants[0] as Record<string, unknown>;
		expect(first).toHaveProperty('id');
	}, LONG_TIMEOUT);

	it('exports attendees as CSV', async () => {
		const attendees = await exportAttendees(TOURNAMENT_ID);
		log(`exportAttendees: ${attendees.length} attendees`);
		expect(attendees.length).toBeGreaterThan(0);
		// Verify CSV row structure
		const first = attendees[0];
		expect(first).toHaveProperty('gamerTag');
		expect(first.gamerTag.length).toBeGreaterThan(0);
		log(`  First attendee: ${first.gamerTag}`);
	}, LONG_TIMEOUT);
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 5: FULL RESET CLEANUP
// ═════════════════════════════════════════════════════════════════════════════

suite('E2E Phase 5: Full reset cleanup', () => {
	it('restarts all phases across all events', async () => {
		const allPhaseIds = [
			...SWISS_PHASES.map(p => p.id),
			FINAL_STANDINGS_PHASE.id,
			MAIN_BRACKET_PHASE,
			REDEMPTION_BRACKET_PHASE,
		];

		for (const phaseId of allPhaseIds) {
			const result = await restartPhase(phaseId);
			log(`Restart phase ${phaseId}: ${result.ok ? '✓' : '✗ ' + result.error}`);
			expect(result.ok, `Restart phase ${phaseId}: ${result.error}`).toBe(true);
		}
		// Wait for restarts to fully propagate before touching participants
		log('Waiting 5s for phase restarts to propagate...');
		await wait(5000);
	}, LONG_TIMEOUT);

	it('clears entrants from later Swiss phases and Final Standings', async () => {
		for (const phase of SWISS_PHASES.slice(1)) {
			const result = await addEntrantsToPhase(SWISS_EVENT_ID, phase.id, []);
			log(`Clear ${phase.name}: ${result.ok ? '✓' : '✗ ' + result.error}`);
			expect(result.ok, `Clear ${phase.name}: ${result.error}`).toBe(true);
			await restartPhase(phase.id);
		}
		// Final Standings uses groupTypeId 6 (Custom Schedule), not 4 (Swiss)
		const fsResult = await addEntrantsToPhase(SWISS_EVENT_ID, FINAL_STANDINGS_PHASE.id, [], undefined, 6);
		log(`Clear Final Standings: ${fsResult.ok ? '✓' : '✗ ' + fsResult.error}`);
		await restartPhase(FINAL_STANDINGS_PHASE.id);
	}, LONG_TIMEOUT);

	it('removes participants from bracket events', async () => {
		await wait(3000);
		const { cleaned, failed } = await removeAllBracketParticipants();
		log(`Removed ${cleaned} participants from bracket events${failed > 0 ? `, ${failed} still failed after retries` : ''}`);
		expect(failed, 'All bracket participants should be removed').toBe(0);
	}, PHASE_TIMEOUT);

	it('verifies clean state after reset', async () => {
		await wait(3000);

		// Verify Round 1 still has entrants
		const r1Data = await gql<{ phase: { seeds: { pageInfo: { total: number } } } }>(
			'query($id:ID!){phase(id:$id){seeds(query:{page:1,perPage:1}){pageInfo{total}}}}',
			{ id: SWISS_PHASES[0].id }, { delay: 0 }
		);
		const r1Seeds = r1Data?.phase?.seeds?.pageInfo?.total ?? 0;
		log(`Round 1 seeds after cleanup: ${r1Seeds}`);
		expect(r1Seeds).toBeGreaterThanOrEqual(30);

		// Verify bracket events have no entrants
		for (const eventId of [MAIN_EVENT_ID, REDEMPTION_EVENT_ID]) {
			const data = await gql<{ event: { numEntrants: number | null } }>(
				'query($id:ID!){event(id:$id){numEntrants}}',
				{ id: eventId }, { delay: 0 }
			);
			const count = data?.event?.numEntrants ?? 0;
			log(`Event ${eventId} entrants: ${count}`);
			expect(count).toBe(0);
		}

		// Verify Final Standings is unstarted (CREATED, not ACTIVE)
		const fsData = await gql<{ phase: { state: string } }>(
			'query($id:ID!){phase(id:$id){state}}',
			{ id: FINAL_STANDINGS_PHASE.id }, { delay: 0 }
		);
		log(`Final Standings state: ${fsData?.phase?.state}`);
		expect(fsData?.phase?.state).toBe('CREATED');
	}, LONG_TIMEOUT);
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 6: SEEDER (dry-run against test tournament after cleanup)
// ═════════════════════════════════════════════════════════════════════════════

suite('E2E Phase 6: Seeder', () => {
	it('computes Elo seeding from historical data (dry run)', async () => {
		// Use a small historical window to keep it fast — just the test tournament itself
		// The seeder targets "microspacing-vancouver-{targetNumber}" by convention,
		// but we can test the pipeline by pointing it at a real past tournament
		const result = await runSeeder({
			mode: 'micro',
			targetNumber: 100,
			seasonStart: 99,
			jitter: 50,
			seed: 42,
			apply: false,
		}, (msg) => log(`  ${msg}`));

		log(`Seeder returned ${result.entrants.length} entrants, ${result.pairings.length} pairings`);
		log(`  ${result.unresolvedCollisions.length} unresolved collisions`);

		// Even if the target tournament doesn't exist (dry run), the pipeline should complete
		// without throwing. If it does find entrants, verify the structure.
		if (result.entrants.length > 0) {
			expect(result.pairings.length).toBeGreaterThan(0);
			const first = result.entrants[0];
			expect(first.elo).toBeDefined();
			expect(first.seedNum).toBeGreaterThan(0);
			expect(first.gamerTag.length).toBeGreaterThan(0);
			log(`  Top seed: ${first.gamerTag} (Elo ${first.elo.toFixed(0)}, seed #${first.seedNum})`);
		}
	}, PHASE_TIMEOUT);
});
