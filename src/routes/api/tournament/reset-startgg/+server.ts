import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { gql, EVENT_PHASES_QUERY, TOURNAMENT_QUERY, pushBracketSeeding, pushFinalStandingsSeeding, fetchPhaseGroups, fetchAllEntrants } from '$lib/server/startgg';
import { restartPhase, addEntrantsToPhase, getTournamentParticipants, updateParticipantEvents } from '$lib/server/startgg-admin';
import { generateBracket, assignBracketStations } from '$lib/server/swiss';
import type { FinalStanding } from '$lib/types/tournament';

// Helper: resolve a phase group ID and phaseId for an event
async function resolveEventPhase(eventId: number): Promise<{ phaseId: number; pgId: number } | null> {
	const phaseData = await gql<{ event: { phases: { id: number }[] } }>(
		EVENT_PHASES_QUERY, { eventId }
	);
	const phaseId = phaseData?.event?.phases?.[0]?.id;
	if (!phaseId) return null;
	const groups = await fetchPhaseGroups(phaseId).catch(() => []);
	if (!groups.length) return null;
	return { phaseId, pgId: groups[0].id };
}

// Helper: refresh stored entrant IDs from a StartGG event by matching gamerTag.
// After restart+re-add, players get NEW entrant IDs. This syncs them.
async function refreshEntrantIds(
	tournament: { entrants: { gamerTag: string; startggEntrantId?: number }[] },
	eventId: number,
	log: (msg: string) => void
): Promise<void> {
	const entrants = await fetchAllEntrants(eventId).catch(() => []);
	type EntrantNode = { id?: number; participants?: { player?: { gamerTag?: string } }[] };
	const tagToId = new Map<string, number>();
	for (const e of entrants as EntrantNode[]) {
		const tag = e.participants?.[0]?.player?.gamerTag;
		if (tag && e.id) tagToId.set(tag.toLowerCase(), Number(e.id));
	}
	let refreshed = 0;
	for (const entrant of tournament.entrants) {
		const newId = tagToId.get(entrant.gamerTag.toLowerCase());
		if (newId && newId !== entrant.startggEntrantId) {
			entrant.startggEntrantId = newId;
			refreshed++;
		}
	}
	if (refreshed) log(`  Refreshed ${refreshed} stale entrant IDs`);
}

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
	async function clearPhaseEntrants(eventId: number, phaseId: number, phaseName: string, groupType: number = 4) {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				log(`  Retry ${attempt} for ${phaseName}...`);
				await new Promise<void>((r) => setTimeout(r, 2000));
			}
			const result = await addEntrantsToPhase(eventId, phaseId, [], undefined, groupType).catch((e) => ({ ok: false, error: String(e) }));
			if (result.ok) { log(`  ✓ ${phaseName} cleared`); return; }
			log(`  ✗ ${phaseName}: ${(result as { error?: string }).error}`);
			await restartPhase(phaseId).catch(() => {});
			await new Promise<void>((r) => setTimeout(r, 2000));
		}
	}

	const r1Phase = swissPhases.find((p) => p.name.includes('Round 1'));
	for (const phase of swissPhases) {
		if (phase.id === r1Phase?.id) continue;
		const isFinalStandings = phase.name.toLowerCase().includes('final');
		await clearPhaseEntrants(swissEventId, phase.id, phase.name, isFinalStandings ? 6 : 4);
		const restartResult = await restartPhase(phase.id).catch((e) => ({ ok: false, error: String(e) }));
		log(`  ${restartResult.ok ? '✓' : '✗'} ${phase.name}: final restart`);
	}

	// Step 3: Ensure all participants are in Swiss.
	// For gauntlet: move to Swiss only (step 5 re-adds to Main).
	// For default: ADD to Swiss but keep Main (step 5 needs Main seeds for cross-event mapping).
	if (tournamentSlug && (mainEventId || redEventId)) {
		const isGauntlet = tournament.mode === 'gauntlet';
		log(`Step 3: ${isGauntlet ? 'Moving' : 'Adding'} participants to Swiss...`);
		const participants = await getTournamentParticipants(tournamentSlug);
		let cleaned = 0;
		let failed = 0;
		for (const p of participants) {
			if (isGauntlet) {
				const inMain = mainEventId ? p.currentEventIds.includes(mainEventId) : false;
				const inRed = redEventId ? p.currentEventIds.includes(redEventId) : false;
				if (!inMain && !inRed) continue;
				const result = await updateParticipantEvents(p.participantId, [swissEventId], []);
				if (result.ok) { cleaned++; } else { failed++; log(`  ✗ ${p.gamerTag}: ${result.error}`); }
			} else {
				if (p.currentEventIds.includes(swissEventId)) continue;
				const targetEvents = [...new Set([...p.currentEventIds, swissEventId])];
				const result = await updateParticipantEvents(p.participantId, targetEvents);
				if (result.ok) { cleaned++; } else { failed++; log(`  ✗ ${p.gamerTag}: ${result.error}`); }
			}
		}
		log(`  ${isGauntlet ? 'Moved' : 'Added'} ${cleaned} to Swiss${failed > 0 ? `, ${failed} failed` : ''}`);

		// Refresh stored entrant IDs — after restart+re-add, players have NEW IDs
		await new Promise<void>((r) => setTimeout(r, 2000));
		log('  Refreshing entrant IDs from Swiss event...');
		await refreshEntrantIds(tournament, swissEventId, log);
	}

	// Step 4: Reset MSV Hub tournament state
	log('Step 4: Resetting MSV Hub state...');
	tournament.currentRound = 0;
	tournament.rounds = [];
	tournament.finalStandings = undefined;
	tournament.startggSync = undefined;

	if (tournament.mode === 'gauntlet') {
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

	// Step 5: Re-sync players and seeding on StartGG
	// Uses the 3-step pattern: add to target (keep source) → push seeding + update IDs → remove from source
	if (tournament.mode === 'gauntlet' && mainEventId && tournamentSlug) {
		log('Step 5: Re-syncing gauntlet players + seeding to StartGG...');

		const mainPhase = await resolveEventPhase(mainEventId);
		const mainPhaseId = mainPhase?.phaseId;
		const mainPgId = mainPhase?.pgId;

		// 5a: Add all players to Main bracket (KEEP Swiss for cross-event mapping)
		const participants = await getTournamentParticipants(tournamentSlug);
		let synced = 0;
		for (const p of participants) {
			if (p.currentEventIds.includes(mainEventId)) { synced++; continue; }
			const targetEvents = [...new Set([...p.currentEventIds, mainEventId])];
			const phaseDests = mainPhaseId ? [{ eventId: mainEventId, phaseId: mainPhaseId }] : [];
			const result = await updateParticipantEvents(p.participantId, targetEvents, phaseDests);
			if (result.ok) { synced++; } else { log(`  ✗ Add ${p.gamerTag}: ${result.error}`); }
		}
		log(`  Added ${synced} to Main`);

		// 5b: Push seeding (no restart — updatePhaseSeeding regenerates preview sets)
		let swissPgId = tournament.startggPhase1Groups?.[0]?.id;
		if (!swissPgId) {
			const swissResolved = await resolveEventPhase(swissEventId);
			if (swissResolved) {
				swissPgId = swissResolved.pgId;
				tournament.startggPhase1Groups = [{ id: swissResolved.pgId, displayIdentifier: '1', phaseId: swissResolved.phaseId, roundNumber: 1 }];
			}
		}

		if (mainPhaseId && mainPgId && swissPgId && tournament.brackets?.main) {
			const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
			const rankedEntrantIds = tournament.brackets.main.players
				.sort((a, b) => a.seed - b.seed)
				.map((p) => entrantMap.get(p.entrantId)?.startggEntrantId)
				.filter((id): id is number => id !== undefined);

			if (rankedEntrantIds.length) {
				const result = await pushBracketSeeding(mainPhaseId, mainPgId, rankedEntrantIds, swissPgId)
					.catch((e) => ({ ok: false as const, error: String(e) }));
				log(`  Seeding: ${result.ok ? '✓' : '✗ ' + result.error}`);
			}
		} else {
			if (!swissPgId) log('  ✗ Could not resolve Swiss phase group for seeding');
			else if (!mainPgId) log('  ✗ Could not resolve Main bracket phase group for seeding');
		}

		// 5c: Update stored entrant IDs: Swiss IDs → Main bracket IDs
		log('  Updating entrant IDs to Main bracket IDs...');
		await refreshEntrantIds(tournament, mainEventId, log);

		// 5d: Remove players from Swiss
		const freshParticipants = await getTournamentParticipants(tournamentSlug);
		let removedFromSwiss = 0;
		for (const p of freshParticipants) {
			if (!p.currentEventIds.includes(swissEventId)) continue;
			const targetEvents = p.currentEventIds.filter((id) => id !== swissEventId);
			if (targetEvents.length === 0) targetEvents.push(mainEventId);
			const result = await updateParticipantEvents(p.participantId, targetEvents);
			if (result.ok) { removedFromSwiss++; } else { log(`  ✗ Remove Swiss ${p.gamerTag}: ${result.error}`); }
		}
		log(`  Removed ${removedFromSwiss} from Swiss`);
	} else {
		log('Step 5: Default mode — re-pushing Swiss seeding...');

		let swissPgId = tournament.startggPhase1Groups?.[0]?.id;
		let swissPhaseId2 = tournament.startggPhase1Groups?.[0]?.phaseId ?? tournament.startggPhase1Id;
		if (!swissPgId) {
			const swissResolved = await resolveEventPhase(swissEventId);
			if (swissResolved) {
				swissPhaseId2 = swissResolved.phaseId;
				swissPgId = swissResolved.pgId;
				tournament.startggPhase1Groups = [{ id: swissResolved.pgId, displayIdentifier: '1', phaseId: swissResolved.phaseId, roundNumber: 1 }];
			}
		}

		if (swissPgId && swissPhaseId2) {
			const rankedEntrantIds = tournament.entrants
				.sort((a, b) => a.initialSeed - b.initialSeed)
				.map((e) => e.startggEntrantId)
				.filter((id): id is number => id !== undefined);

			if (rankedEntrantIds.length) {
				let mainPgId: number | undefined;
				let mainPhaseId: number | undefined;
				if (mainEventId) {
					const mainPhase = await resolveEventPhase(mainEventId);
					mainPgId = mainPhase?.pgId;
					mainPhaseId = mainPhase?.phaseId;
				}

				const result = mainPgId
					? await pushBracketSeeding(swissPhaseId2, swissPgId, rankedEntrantIds, mainPgId)
						.catch((e) => ({ ok: false as const, error: String(e) }))
					: await pushFinalStandingsSeeding(swissPhaseId2, swissPgId, rankedEntrantIds)
						.catch((e) => ({ ok: false as const, error: String(e) }));
				log(`  Seeding: ${result.ok ? '✓' : '✗ ' + result.error}`);

				// Update stored entrant IDs: Main IDs → Swiss IDs
				log('  Updating entrant IDs to Swiss IDs...');
				await refreshEntrantIds(tournament, swissEventId, log);
			}
		} else {
			log('  ✗ Could not resolve Swiss phase group for seeding');
		}

		// Remove from non-Swiss events (seeding + ID update done)
		if (tournamentSlug) {
			log('  Removing players from non-Swiss events...');
			const finalParticipants = await getTournamentParticipants(tournamentSlug);
			let removedCount = 0;
			for (const p of finalParticipants) {
				const nonSwiss = p.currentEventIds.filter((id) => id !== swissEventId);
				if (nonSwiss.length === 0) continue;
				const result = await updateParticipantEvents(p.participantId, [swissEventId]);
				if (result.ok) { removedCount++; } else { log(`  ✗ ${p.gamerTag}: ${result.error}`); }
			}
			if (removedCount) log(`  Removed ${removedCount} from non-Swiss events`);
		}
	}

	tournament.startggSync = { splitConfirmed: true, pendingBracketMatchIds: [], errors: [] };
	await saveTournament(tournament);

	log('Done!');
	return Response.json({ ok: true, logs });
};
