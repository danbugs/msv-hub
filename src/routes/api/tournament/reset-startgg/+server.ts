import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { gql, EVENT_PHASES_QUERY, TOURNAMENT_QUERY } from '$lib/server/startgg';
import { restartPhase, addEntrantsToPhase, getTournamentParticipants, updateParticipantEvents } from '$lib/server/startgg-admin';
import { generateBracket, assignBracketStations } from '$lib/server/swiss';
import type { FinalStanding } from '$lib/types/tournament';

/**
 * POST — Full StartGG reset: restart all phases (Swiss + bracket),
 * remove entrants from later rounds and bracket events,
 * leaving everyone only in Swiss Round 1.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const logs: string[] = [];
	const log = (msg: string) => { logs.push(msg); console.log(`[reset-startgg] ${msg}`); };

	const swissEventId = tournament.startggEventId;
	const eventSlug = tournament.startggEventSlug;

	if (!swissEventId || !eventSlug) {
		return Response.json({ error: 'No StartGG event linked' }, { status: 400 });
	}

	// Discover all events from StartGG (don't rely solely on stored IDs)
	const tournamentSlug = eventSlug.match(/tournament\/([^/]+)/)?.[1];
	let mainEventId = tournament.startggMainBracketEventId;
	let redEventId = tournament.startggRedemptionBracketEventId;

	if (tournamentSlug && (!mainEventId || !redEventId)) {
		log('Discovering bracket events from StartGG...');
		const tData = await gql<{ tournament: { events: { id: number; name: string; numEntrants: number }[] } }>(
			TOURNAMENT_QUERY, { slug: tournamentSlug }
		);
		const allEvents = tData?.tournament?.events ?? [];
		const otherEvents = allEvents.filter((e) => e.id !== swissEventId);
		if (!mainEventId) {
			const mainEvt = otherEvents.find((e) => /main/i.test(e.name));
			if (mainEvt) { mainEventId = mainEvt.id; log(`  Found main: ${mainEvt.name} (${mainEvt.id})`); }
		}
		if (!redEventId) {
			const redEvt = otherEvents.find((e) => /redemption/i.test(e.name));
			if (redEvt) { redEventId = redEvt.id; log(`  Found redemption: ${redEvt.name} (${redEvt.id})`); }
		}
		if (!mainEventId && !redEventId && otherEvents.length === 2) {
			const sorted = [...otherEvents].sort((a, b) => b.numEntrants - a.numEntrants);
			mainEventId = sorted[0].id;
			redEventId = sorted[1].id;
			log(`  Fallback by size: main=${sorted[0].name}, redemption=${sorted[1].name}`);
		}
	}

	// Step 1: Restart ALL phases across ALL events (Swiss + Main + Redemption)
	log('Step 1: Restarting all phases...');
	const allEventIds = [swissEventId, mainEventId, redEventId].filter((id): id is number => !!id);
	for (const eventId of allEventIds) {
		const phaseData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
			EVENT_PHASES_QUERY, { eventId }
		);
		const phases = phaseData?.event?.phases ?? [];
		for (const phase of phases) {
			log(`  Restarting ${phase.name} (${phase.id})...`);
			const result = await restartPhase(phase.id).catch((e) => ({ ok: false, error: String(e) }));
			log(`  ${result.ok ? '✓' : '✗ ' + result.error}`);
		}
	}

	// Brief pause to let restarts fully propagate
	await new Promise<void>((r) => setTimeout(r, 2000));

	// Step 2: Clear entrants from Swiss phases except Round 1
	log('Step 2: Clearing entrants from later Swiss phases...');
	const swissPhaseData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
		EVENT_PHASES_QUERY, { eventId: swissEventId }
	);
	const swissPhases = swissPhaseData?.event?.phases ?? [];
	// Helper: clear a phase with retry (restart may not have propagated yet)
	async function clearPhaseEntrants(eventId: number, phaseId: number, phaseName: string, groupType: number = 4) {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				log(`  Retry ${attempt} for ${phaseName}...`);
				await new Promise<void>((r) => setTimeout(r, 2000));
			}
			const result = await addEntrantsToPhase(eventId, phaseId, [], undefined, groupType).catch((e) => ({ ok: false, error: String(e) }));
			if (result.ok) { log(`  ✓ ${phaseName} cleared`); return; }
			log(`  ✗ ${phaseName}: ${(result as { error?: string }).error}`);
			// If it failed due to existing sets, restart again
			await restartPhase(phaseId).catch(() => {});
			await new Promise<void>((r) => setTimeout(r, 2000));
		}
	}

	const r1Phase = swissPhases.find((p) => p.name.includes('Round 1'));
	for (const phase of swissPhases) {
		if (phase.id === r1Phase?.id) continue;
		const isFinalStandings = phase.name.toLowerCase().includes('final');
		await clearPhaseEntrants(swissEventId, phase.id, phase.name, isFinalStandings ? 6 : 4);
		// clearPhaseEntrants (PUT to /phase/{id}) re-marks the phase as "In progress".
		// Restart once more so the phase shows as unstarted on StartGG.
		const restartResult = await restartPhase(phase.id).catch((e) => ({ ok: false, error: String(e) }));
		log(`  ${restartResult.ok ? '✓' : '✗'} ${phase.name}: final restart`);
	}

	// Step 2b: Do NOT call addEntrantsToPhase for bracket events —
	// it would convert DE bracket phases into Swiss (groupTypeId: 4).
	// Instead, rely on restartPhase (already done) + updateParticipantEvents
	// (below) to remove players from bracket events entirely.

	// Step 3: Remove all participants from bracket events (keep only Swiss)
	if (tournamentSlug && (mainEventId || redEventId)) {
		log('Step 3: Removing participants from bracket events...');
		const participants = await getTournamentParticipants(tournamentSlug);
		let cleaned = 0;
		let failed = 0;
		for (const p of participants) {
			const inMain = mainEventId ? p.currentEventIds.includes(mainEventId) : false;
			const inRed = redEventId ? p.currentEventIds.includes(redEventId) : false;
			if (!inMain && !inRed) continue;
			const result = await updateParticipantEvents(p.participantId, [swissEventId], []);
			if (result.ok) {
				cleaned++;
			} else {
				failed++;
				log(`  ✗ ${p.gamerTag}: ${result.error}`);
			}
		}
		log(`  Removed ${cleaned} from brackets${failed > 0 ? `, ${failed} failed` : ''}`);
	}

	// Step 4: Reset MSV Hub tournament state
	log('Step 4: Resetting MSV Hub state...');
	tournament.currentRound = 0;
	tournament.rounds = [];
	tournament.finalStandings = undefined;
	tournament.startggSync = undefined;

	if (tournament.mode === 'gauntlet') {
		// Regenerate fresh gauntlet main bracket
		const players = tournament.entrants.map((e) => ({ entrantId: e.id, seed: e.initialSeed }));
		const fakeStandings: FinalStanding[] = tournament.entrants.map((e) => ({
			rank: e.initialSeed, entrantId: e.id, gamerTag: e.gamerTag,
			wins: 0, losses: 0, initialSeed: e.initialSeed, totalScore: 0,
			basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
			expectedWins: 0, winsAboveExpected: 0, bracket: 'main' as const
		}));
		let mainBracket = generateBracket('main', players, fakeStandings);
		mainBracket = assignBracketStations(mainBracket, tournament.settings);
		tournament.phase = 'brackets';
		tournament.brackets = { main: mainBracket };
		log('MSV Hub reset to fresh Gauntlet bracket');
	} else {
		tournament.phase = 'swiss';
		tournament.brackets = undefined;
		log('MSV Hub reset to Swiss Round 1');
	}

	await saveTournament(tournament);

	log('Done!');
	return Response.json({ ok: true, logs });
};
