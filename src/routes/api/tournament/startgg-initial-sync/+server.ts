/**
 * POST /api/tournament/startgg-initial-sync
 *
 * Validates and fixes player placement on StartGG after tournament creation.
 * - Default mode: ensure all players are in Swiss event only (remove from bracket events)
 * - Gauntlet mode: add players to main bracket, push seeding, then remove from Swiss
 *
 * Accepts optional { eventSlug } in body for tournaments created without StartGG links.
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import {
	gql, TOURNAMENT_QUERY, EVENT_BY_SLUG_QUERY, EVENT_PHASES_QUERY,
	pushBracketSeeding, pushFinalStandingsSeeding, fetchPhaseGroups,
	fetchPhaseSeeds, extractPlayerId
} from '$lib/server/startgg';
import { getTournamentParticipants, updateParticipantEvents, restartPhase } from '$lib/server/startgg-admin';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const bodySlug = ((body as { eventSlug?: string }).eventSlug ?? '').trim();

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	let eventSlug = tournament.startggEventSlug ?? bodySlug;
	let swissEventId = tournament.startggEventId;

	if (!eventSlug) {
		return Response.json({ error: 'No StartGG event linked' }, { status: 400 });
	}

	// Resolve Swiss event ID from slug if not stored
	if (!swissEventId) {
		const slug = eventSlug.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+|\/+$/g, '');
		const eventData = await gql<{ event: { id: number } }>(EVENT_BY_SLUG_QUERY, { slug });
		if (!eventData?.event) {
			return Response.json({ error: `Event not found: ${slug}` }, { status: 404 });
		}
		swissEventId = eventData.event.id;
		tournament.startggEventId = swissEventId;
		tournament.startggEventSlug = slug;
		eventSlug = slug;
	}

	const tournamentSlug = eventSlug.match(/tournament\/([^/]+)/)?.[1];
	if (!tournamentSlug) {
		return Response.json({ error: 'Cannot parse tournament slug from event URL' }, { status: 400 });
	}

	const logs: string[] = [];
	const log = (msg: string) => { logs.push(msg); console.log(`[initial-sync] ${msg}`); };

	const isGauntlet = tournament.mode === 'gauntlet';

	// Discover all events in the tournament
	const tData = await gql<{ tournament: { events: { id: number; name: string; numEntrants: number }[] } }>(
		TOURNAMENT_QUERY, { slug: tournamentSlug }
	);
	const allEvents = tData?.tournament?.events ?? [];
	const otherEvents = allEvents.filter((e) => e.id !== swissEventId);

	// Auto-link bracket events
	if (!tournament.startggMainBracketEventId) {
		const mainEvt = otherEvents.find((e) => /main/i.test(e.name));
		if (mainEvt) { tournament.startggMainBracketEventId = mainEvt.id; log(`Linked main: ${mainEvt.name} (${mainEvt.id})`); }
	}
	if (!tournament.startggRedemptionBracketEventId) {
		const redEvt = otherEvents.find((e) => /redemption/i.test(e.name));
		if (redEvt) { tournament.startggRedemptionBracketEventId = redEvt.id; log(`Linked redemption: ${redEvt.name} (${redEvt.id})`); }
	}
	if (!tournament.startggMainBracketEventId && !tournament.startggRedemptionBracketEventId && otherEvents.length === 2) {
		const sorted = [...otherEvents].sort((a, b) => b.numEntrants - a.numEntrants);
		tournament.startggMainBracketEventId = sorted[0].id;
		tournament.startggRedemptionBracketEventId = sorted[1].id;
		log(`Linked by size: main=${sorted[0].name}, redemption=${sorted[1].name}`);
	}

	const mainEventId = tournament.startggMainBracketEventId;

	const participants = await getTournamentParticipants(tournamentSlug);
	log(`Found ${participants.length} participants`);

	let moved = 0;
	let cleaned = 0;
	let failed = 0;
	let seedingResult = '';

	if (isGauntlet) {
		if (!mainEventId) {
			await saveTournament(tournament);
			return Response.json({ error: 'Cannot find main bracket event on StartGG. Create an event with "Main" in the name.' }, { status: 400 });
		}

		// Get the main bracket phase + phase group for seeding
		const mainPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
			EVENT_PHASES_QUERY, { eventId: mainEventId }
		);
		const mainPhaseId = mainPhaseData?.event?.phases?.[0]?.id;

		// Step 1: Add players to main bracket (KEEP Swiss for seeding lookup)
		log(`Step 1: Adding all players to Main bracket (keeping Swiss for seeding)...`);
		for (const p of participants) {
			const targetEvents = [...new Set([...p.currentEventIds, mainEventId])];
			if (p.currentEventIds.includes(mainEventId)) { moved++; continue; }
			const phaseDests = mainPhaseId ? [{ eventId: mainEventId, phaseId: mainPhaseId }] : [];
			const result = await updateParticipantEvents(p.participantId, targetEvents, phaseDests);
			if (result.ok) { moved++; log(`  ${p.gamerTag} → +Main`); }
			else { failed++; log(`  ✗ ${p.gamerTag}: ${result.error}`); }
		}
		log(`Added ${moved} to Main, ${failed} failed`);

		// Step 2: Push seeding to main bracket
		if (mainPhaseId && tournament.brackets?.main) {
			log(`Step 2: Pushing seeding to Main bracket...`);

			// Resolve Swiss phase group ID if not stored
			let swissPgId = tournament.startggPhase1Groups?.[0]?.id;
			if (!swissPgId) {
				const swissPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
					EVENT_PHASES_QUERY, { eventId: swissEventId }
				);
				const swissPhaseId = swissPhaseData?.event?.phases?.[0]?.id;
				if (swissPhaseId) {
					const groups = await fetchPhaseGroups(swissPhaseId).catch(() => []);
					if (groups.length) {
						swissPgId = groups[0].id;
						tournament.startggPhase1Groups = groups.map((g) => ({ ...g, phaseId: swissPhaseId, roundNumber: 1 }));
						log(`  Resolved Swiss phase group: ${swissPgId}`);
					}
				}
			}

			if (swissPgId) {
				const mainGroups = await fetchPhaseGroups(mainPhaseId).catch(() => []);
				const mainPgId = mainGroups[0]?.id;
				if (mainPgId) {
					const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
					const rankedEntrantIds = tournament.brackets.main.players
						.sort((a, b) => a.seed - b.seed)
						.map((p) => entrantMap.get(p.entrantId)?.startggEntrantId)
						.filter((id): id is number => id !== undefined);

					if (rankedEntrantIds.length) {
						const result = await pushBracketSeeding(mainPhaseId, mainPgId, rankedEntrantIds, swissPgId)
							.catch((e) => ({ ok: false as const, error: String(e) }));
						if (result.ok) {
							seedingResult = `Pushed seeding for ${rankedEntrantIds.length} players`;
							log(`  ✓ ${seedingResult}`);
							log('  Restarting Main bracket to regenerate sets...');
							await restartPhase(mainPhaseId).catch(() => {});
							await new Promise<void>((r) => setTimeout(r, 1500));
							const rePush = await pushBracketSeeding(mainPhaseId, mainPgId, rankedEntrantIds, swissPgId)
								.catch((e) => ({ ok: false as const, error: String(e) }));
							log(`  Re-push seeding: ${rePush.ok ? '✓' : '✗ ' + rePush.error}`);
						} else {
							seedingResult = `Seeding failed: ${result.error}`;
							log(`  ✗ ${seedingResult}`);
						}
					} else {
						seedingResult = 'No StartGG entrant IDs on tournament players';
						log(`  ✗ ${seedingResult}`);
					}
				} else {
					seedingResult = 'Could not find main bracket phase group';
					log(`  ✗ ${seedingResult}`);
				}
			} else {
				seedingResult = 'Could not resolve Swiss phase group for seeding lookup';
				log(`  ✗ ${seedingResult}`);
			}
		}

		// Update startggEntrantId to Main bracket IDs (before removing Swiss seeds)
		if (mainPhaseId) {
			const mainSeeds = await fetchPhaseSeeds(mainPhaseId).catch(() => []);
			const playerToMainEntrant = new Map<number, number>();
			for (const seed of mainSeeds) {
				const playerId = extractPlayerId(seed as Record<string, unknown>);
				const entrantId = (seed as { entrant?: { id?: number } }).entrant?.id;
				if (playerId && entrantId) playerToMainEntrant.set(playerId, Number(entrantId));
			}
			if (playerToMainEntrant.size > 0) {
				const swissPhaseId2 = tournament.startggPhase1Groups?.[0]?.phaseId ?? tournament.startggPhase1Id;
				if (swissPhaseId2) {
					const swissSeeds = await fetchPhaseSeeds(swissPhaseId2).catch(() => []);
					const swissEntrantToPlayer = new Map<number, number>();
					for (const seed of swissSeeds) {
						const playerId = extractPlayerId(seed as Record<string, unknown>);
						const entrantId = (seed as { entrant?: { id?: number } }).entrant?.id;
						if (playerId && entrantId) swissEntrantToPlayer.set(Number(entrantId), playerId);
					}
					let updated = 0;
					for (const entrant of tournament.entrants) {
						if (!entrant.startggEntrantId) continue;
						const playerId = swissEntrantToPlayer.get(entrant.startggEntrantId);
						if (playerId) {
							const mainEntrantId = playerToMainEntrant.get(playerId);
							if (mainEntrantId && mainEntrantId !== entrant.startggEntrantId) {
								entrant.startggEntrantId = mainEntrantId;
								updated++;
							}
						}
					}
					if (updated) log(`  Updated ${updated} entrant IDs to Main bracket IDs`);
				}
			}
		}

		// Step 3: Remove players from Swiss (now that seeding is pushed)
		log(`Step 3: Removing players from Swiss...`);
		let removedFromSwiss = 0;
		const freshParticipants = await getTournamentParticipants(tournamentSlug);
		for (const p of freshParticipants) {
			if (!p.currentEventIds.includes(swissEventId)) continue;
			const targetEvents = p.currentEventIds.filter((id) => id !== swissEventId);
			if (targetEvents.length === 0) targetEvents.push(mainEventId);
			const result = await updateParticipantEvents(p.participantId, targetEvents);
			if (result.ok) { removedFromSwiss++; }
			else { log(`  ✗ Remove Swiss ${p.gamerTag}: ${result.error}`); }
		}
		log(`Removed ${removedFromSwiss} from Swiss`);
	} else {
		// Mirror of gauntlet sync but in reverse: Swiss ← Main
		// Step 1: Add players to Swiss (KEEP Main for seeding lookup)
		log(`Step 1: Adding all players to Swiss (keeping other events for seeding lookup)...`);
		for (const p of participants) {
			if (p.currentEventIds.includes(swissEventId)) { moved++; continue; }
			const targetEvents = [...new Set([...p.currentEventIds, swissEventId])];
			const result = await updateParticipantEvents(p.participantId, targetEvents);
			if (result.ok) { moved++; log(`  ${p.gamerTag} → +Swiss`); }
			else { failed++; log(`  ✗ ${p.gamerTag}: ${result.error}`); }
		}
		log(`Added ${moved} to Swiss, ${failed} failed`);

		// Step 2: Push seeding to Swiss Round 1 phase group
		let swissPgId = tournament.startggPhase1Groups?.[0]?.id;
		let swissPhaseId = tournament.startggPhase1Groups?.[0]?.phaseId ?? tournament.startggPhase1Id;
		if (!swissPgId) {
			const swissPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
				EVENT_PHASES_QUERY, { eventId: swissEventId }
			);
			swissPhaseId = swissPhaseData?.event?.phases?.[0]?.id;
			if (swissPhaseId) {
				const groups = await fetchPhaseGroups(swissPhaseId).catch(() => []);
				if (groups.length) {
					swissPgId = groups[0].id;
					tournament.startggPhase1Groups = groups.map((g) => ({ ...g, phaseId: swissPhaseId!, roundNumber: 1 }));
				}
			}
		}
		if (swissPgId && swissPhaseId) {
			const rankedEntrantIds = tournament.entrants
				.sort((a, b) => a.initialSeed - b.initialSeed)
				.map((e) => e.startggEntrantId)
				.filter((id): id is number => id !== undefined);
			if (rankedEntrantIds.length) {
				let mainPgId: number | undefined;
				if (mainEventId) {
					const mainPhData = await gql<{ event: { phases: { id: number }[] } }>(
						EVENT_PHASES_QUERY, { eventId: mainEventId }
					);
					const mainPhId = mainPhData?.event?.phases?.[0]?.id;
					if (mainPhId) {
						const mainGroups = await fetchPhaseGroups(mainPhId).catch(() => []);
						mainPgId = mainGroups[0]?.id;
					}
				}
				const result = mainPgId
					? await pushBracketSeeding(swissPhaseId, swissPgId, rankedEntrantIds, mainPgId)
						.catch((e) => ({ ok: false as const, error: String(e) }))
					: await pushFinalStandingsSeeding(swissPhaseId, swissPgId, rankedEntrantIds)
						.catch((e) => ({ ok: false as const, error: String(e) }));
				if (result.ok) {
					seedingResult = `Pushed Swiss seeding for ${rankedEntrantIds.length} players`;
					log(`  ✓ ${seedingResult}`);
				} else {
					seedingResult = `Swiss seeding failed: ${result.error}`;
					log(`  ✗ ${seedingResult}`);
				}

				// Restart Swiss R1 phase so StartGG regenerates sets with new seeding,
				// then re-push seeding (restart may clear it).
				if (result.ok) {
					log('  Restarting Swiss R1 to regenerate sets...');
					await restartPhase(swissPhaseId).catch(() => {});
					await new Promise<void>((r) => setTimeout(r, 1500));
					const rePush = mainPgId
						? await pushBracketSeeding(swissPhaseId, swissPgId, rankedEntrantIds, mainPgId).catch((e) => ({ ok: false as const, error: String(e) }))
						: await pushFinalStandingsSeeding(swissPhaseId, swissPgId, rankedEntrantIds).catch((e) => ({ ok: false as const, error: String(e) }));
					log(`  Re-push seeding: ${rePush.ok ? '✓' : '✗ ' + rePush.error}`);
				}
			}

			// Update startggEntrantId to Swiss entrant IDs (differ from Main bracket IDs)
			if (swissPhaseId && mainEventId) {
				const swissSeeds = await fetchPhaseSeeds(swissPhaseId).catch(() => []);
				const playerToSwissEntrant = new Map<number, number>();
				for (const seed of swissSeeds) {
					const playerId = extractPlayerId(seed as Record<string, unknown>);
					const entrantId = (seed as { entrant?: { id?: number } }).entrant?.id;
					if (playerId && entrantId) playerToSwissEntrant.set(playerId, Number(entrantId));
				}
				if (playerToSwissEntrant.size > 0) {
					const oldEntrantToPlayer = new Map<number, number>();
					const mainPhData2 = await gql<{ event: { phases: { id: number }[] } }>(
						EVENT_PHASES_QUERY, { eventId: mainEventId }
					);
					const mainPhId2 = mainPhData2?.event?.phases?.[0]?.id;
					if (mainPhId2) {
						const mainSeeds = await fetchPhaseSeeds(mainPhId2).catch(() => []);
						for (const seed of mainSeeds) {
							const playerId = extractPlayerId(seed as Record<string, unknown>);
							const entrantId = (seed as { entrant?: { id?: number } }).entrant?.id;
							if (playerId && entrantId) oldEntrantToPlayer.set(Number(entrantId), playerId);
						}
					}
					let updated = 0;
					for (const entrant of tournament.entrants) {
						if (!entrant.startggEntrantId) continue;
						const playerId = oldEntrantToPlayer.get(entrant.startggEntrantId);
						if (playerId) {
							const swissEntrantId = playerToSwissEntrant.get(playerId);
							if (swissEntrantId && swissEntrantId !== entrant.startggEntrantId) {
								entrant.startggEntrantId = swissEntrantId;
								updated++;
							}
						}
					}
					if (updated) log(`  Updated ${updated} entrant IDs to Swiss IDs`);
				}
			}
		} else {
			log('  Could not resolve Swiss phase group for seeding push');
		}

		// Step 3: Remove players from other events (now that seeding is pushed)
		log(`Step 3: Removing players from non-Swiss events...`);
		const freshParticipants = await getTournamentParticipants(tournamentSlug);
		for (const p of freshParticipants) {
			const nonSwiss = p.currentEventIds.filter((id) => id !== swissEventId);
			if (nonSwiss.length === 0) continue;
			const result = await updateParticipantEvents(p.participantId, [swissEventId]);
			if (result.ok) { cleaned++; }
			else { log(`  ✗ ${p.gamerTag}: ${result.error}`); }
		}
		if (cleaned) log(`  Removed ${cleaned} from non-Swiss events`);
	}

	// Mark split as confirmed so match reports go through immediately (not queued)
	if (!tournament.startggSync) {
		tournament.startggSync = { splitConfirmed: true, pendingBracketMatchIds: [], errors: [] };
	} else {
		tournament.startggSync.splitConfirmed = true;
	}

	await saveTournament(tournament);

	return Response.json({ ok: true, moved, cleaned, failed, seedingResult, logs });
};
