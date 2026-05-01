/**
 * POST /api/tournament/startgg-initial-sync
 *
 * Validates and fixes player placement on StartGG after tournament creation.
 * Both modes follow the same 3-step pattern:
 *   1. Add players to target event (KEEP source for cross-event mapping)
 *   2. Push seeding + update stored entrant IDs to target event's IDs
 *   3. Remove players from source event
 *
 * - Default mode: target=Swiss, source=Main (if exists)
 * - Gauntlet mode: target=Main, source=Swiss
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import {
	gql, TOURNAMENT_QUERY, EVENT_BY_SLUG_QUERY, EVENT_PHASES_QUERY,
	pushBracketSeeding, pushFinalStandingsSeeding, fetchPhaseGroups,
	fetchPhaseSeeds, extractPlayerId, fetchAllEntrants
} from '$lib/server/startgg';
import { getTournamentParticipants, updateParticipantEvents } from '$lib/server/startgg-admin';

// Helper: refresh stored entrant IDs from a StartGG event by matching gamerTag.
// Stored IDs can be stale if from-event read seeds from a different event (fallback path)
// or if a reset re-added players with new IDs.
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

// Helper: build a player ID ↔ entrant ID map from phase seeds
async function buildPlayerEntrantMap(phaseId: number): Promise<Map<number, number>> {
	const seeds = await fetchPhaseSeeds(phaseId).catch(() => []);
	const map = new Map<number, number>();
	for (const seed of seeds) {
		const playerId = extractPlayerId(seed as Record<string, unknown>);
		const entrantId = (seed as { entrant?: { id?: number } }).entrant?.id;
		if (playerId && entrantId) map.set(playerId, Number(entrantId));
	}
	return map;
}

// Helper: update tournament entrant IDs from source event to target event via player ID matching
async function updateEntrantIds(
	tournament: { entrants: { startggEntrantId?: number }[] },
	sourcePhaseId: number,
	targetPhaseId: number,
	log: (msg: string) => void
): Promise<void> {
	const targetPlayerToEntrant = await buildPlayerEntrantMap(targetPhaseId);
	if (targetPlayerToEntrant.size === 0) { log('  No target seeds found for entrant ID update'); return; }

	// Build reverse map: source entrant ID → player ID
	const sourceSeeds = await fetchPhaseSeeds(sourcePhaseId).catch(() => []);
	const sourceEntrantToPlayer = new Map<number, number>();
	for (const seed of sourceSeeds) {
		const playerId = extractPlayerId(seed as Record<string, unknown>);
		const entrantId = (seed as { entrant?: { id?: number } }).entrant?.id;
		if (playerId && entrantId) sourceEntrantToPlayer.set(Number(entrantId), playerId);
	}

	let updated = 0;
	for (const entrant of tournament.entrants) {
		if (!entrant.startggEntrantId) continue;
		const playerId = sourceEntrantToPlayer.get(entrant.startggEntrantId);
		if (!playerId) continue;
		const targetEntrantId = targetPlayerToEntrant.get(playerId);
		if (targetEntrantId && targetEntrantId !== entrant.startggEntrantId) {
			entrant.startggEntrantId = targetEntrantId;
			updated++;
		}
	}
	if (updated) log(`  Updated ${updated} entrant IDs`);
}

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

	// Refresh stored entrant IDs to current Swiss event IDs.
	// from-event may have read seeds from a fallback event (Main), leaving
	// stale IDs that can't be mapped during cross-event seeding push.
	log('Refreshing entrant IDs from Swiss event...');
	await refreshEntrantIds(tournament, swissEventId, log);

	let moved = 0;
	let cleaned = 0;
	let failed = 0;
	let seedingResult = '';

	// Resolve Swiss phase info (needed for both modes)
	let swissPgId = tournament.startggPhase1Groups?.[0]?.id;
	let swissPhaseId = tournament.startggPhase1Groups?.[0]?.phaseId ?? tournament.startggPhase1Id;
	if (!swissPgId || !swissPhaseId) {
		const resolved = await resolveEventPhase(swissEventId);
		if (resolved) {
			swissPhaseId = resolved.phaseId;
			swissPgId = resolved.pgId;
			tournament.startggPhase1Groups = [{ id: resolved.pgId, displayIdentifier: '1', phaseId: resolved.phaseId, roundNumber: 1 }];
		}
	}

	if (isGauntlet) {
		if (!mainEventId) {
			await saveTournament(tournament);
			return Response.json({ error: 'Cannot find main bracket event on StartGG. Create an event with "Main" in the name.' }, { status: 400 });
		}

		const mainPhase = await resolveEventPhase(mainEventId);
		const mainPhaseId = mainPhase?.phaseId;
		const mainPgId = mainPhase?.pgId;

		// Step 1: Add players to Main bracket (KEEP Swiss for cross-event mapping)
		log(`Step 1: Adding all players to Main bracket...`);
		for (const p of participants) {
			if (p.currentEventIds.includes(mainEventId)) { moved++; continue; }
			const targetEvents = [...new Set([...p.currentEventIds, mainEventId])];
			const phaseDests = mainPhaseId ? [{ eventId: mainEventId, phaseId: mainPhaseId }] : [];
			const result = await updateParticipantEvents(p.participantId, targetEvents, phaseDests);
			if (result.ok) { moved++; log(`  ${p.gamerTag} → +Main`); }
			else { failed++; log(`  ✗ ${p.gamerTag}: ${result.error}`); }
		}
		log(`Added ${moved} to Main, ${failed} failed`);

		// Wait for StartGG to propagate entrants to the bracket phase seeds
		log('  Waiting for StartGG propagation...');
		await new Promise<void>((r) => setTimeout(r, 3000));

		// Step 2: Push seeding + update entrant IDs
		if (mainPhaseId && mainPgId && swissPgId && tournament.brackets?.main) {
			log(`Step 2: Pushing seeding to Main bracket...`);
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
				} else {
					seedingResult = `Seeding failed: ${result.error}`;
					log(`  ✗ ${seedingResult}`);
				}
			}

			// Update stored entrant IDs: Swiss IDs → Main bracket IDs
			if (swissPhaseId) {
				log('  Updating entrant IDs to Main bracket IDs...');
				await updateEntrantIds(tournament, swissPhaseId, mainPhaseId, log);
			}
		} else {
			if (!swissPgId) seedingResult = 'Could not resolve Swiss phase group';
			else if (!mainPgId) seedingResult = 'Could not resolve Main bracket phase group';
			if (seedingResult) log(`  ✗ ${seedingResult}`);
		}

		// Step 3: Remove players from Swiss
		log(`Step 3: Removing players from Swiss...`);
		const freshParticipants = await getTournamentParticipants(tournamentSlug);
		let removedFromSwiss = 0;
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
		// Default mode: target=Swiss, source=Main

		// Step 1: Add players to Swiss (KEEP Main for cross-event mapping)
		log(`Step 1: Adding all players to Swiss...`);
		for (const p of participants) {
			if (p.currentEventIds.includes(swissEventId)) { moved++; continue; }
			const targetEvents = [...new Set([...p.currentEventIds, swissEventId])];
			const result = await updateParticipantEvents(p.participantId, targetEvents);
			if (result.ok) { moved++; log(`  ${p.gamerTag} → +Swiss`); }
			else { failed++; log(`  ✗ ${p.gamerTag}: ${result.error}`); }
		}
		log(`Added ${moved} to Swiss, ${failed} failed`);

		// Wait for StartGG to propagate entrants to phase seeds
		if (moved > 0) {
			log('  Waiting for StartGG propagation...');
			await new Promise<void>((r) => setTimeout(r, 3000));
		}

		// Step 2: Push seeding + update entrant IDs
		if (swissPgId && swissPhaseId) {
			log('Step 2: Pushing seeding to Swiss...');
			const rankedEntrantIds = tournament.entrants
				.sort((a, b) => a.initialSeed - b.initialSeed)
				.map((e) => e.startggEntrantId)
				.filter((id): id is number => id !== undefined);

			if (rankedEntrantIds.length) {
				// Use cross-event mapping if Main exists (entrant IDs may be from Main)
				let mainPgId: number | undefined;
				let mainPhaseId: number | undefined;
				if (mainEventId) {
					const mainPhase = await resolveEventPhase(mainEventId);
					mainPgId = mainPhase?.pgId;
					mainPhaseId = mainPhase?.phaseId;
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

				// Update stored entrant IDs: Main IDs → Swiss IDs
				if (mainPhaseId) {
					log('  Updating entrant IDs to Swiss IDs...');
					await updateEntrantIds(tournament, mainPhaseId, swissPhaseId, log);
				}
			}
		} else {
			log('  Could not resolve Swiss phase group for seeding push');
		}

		// Step 3: Remove players from non-Swiss events
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
