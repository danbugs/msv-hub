/**
 * POST /api/tournament/startgg-initial-sync
 *
 * Validates and fixes player placement on StartGG after tournament creation.
 * - Default mode: ensure all players are in Swiss event only (remove from bracket events)
 * - Gauntlet mode: discover main bracket event, move all players there (remove from Swiss)
 *
 * Accepts optional { eventSlug } in body for tournaments created without StartGG links.
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { gql, TOURNAMENT_QUERY, EVENT_BY_SLUG_QUERY, EVENT_PHASES_QUERY } from '$lib/server/startgg';
import { getTournamentParticipants, updateParticipantEvents } from '$lib/server/startgg-admin';

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
	const redEventId = tournament.startggRedemptionBracketEventId;

	const participants = await getTournamentParticipants(tournamentSlug);
	log(`Found ${participants.length} participants`);

	let moved = 0;
	let cleaned = 0;
	let failed = 0;

	if (isGauntlet) {
		if (!mainEventId) {
			await saveTournament(tournament);
			return Response.json({ error: 'Cannot find main bracket event on StartGG. Create an event with "Main" in the name.' }, { status: 400 });
		}

		// Get the main bracket phase for destination routing
		const mainPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
			EVENT_PHASES_QUERY, { eventId: mainEventId }
		);
		const mainPhaseId = mainPhaseData?.event?.phases?.[0]?.id;

		log(`Moving all players to Main bracket (${mainEventId})...`);
		for (const p of participants) {
			const targetEvents = [mainEventId];
			const currentSet = new Set(p.currentEventIds);
			if (currentSet.size === 1 && currentSet.has(mainEventId)) { moved++; continue; }
			const phaseDests = mainPhaseId ? [{ eventId: mainEventId, phaseId: mainPhaseId }] : [];
			const result = await updateParticipantEvents(p.participantId, targetEvents, phaseDests);
			if (result.ok) {
				moved++;
				const wasElsewhere = p.currentEventIds.some((id) => id !== mainEventId);
				if (wasElsewhere) { cleaned++; log(`  ${p.gamerTag} → Main only`); }
			} else {
				failed++;
				log(`  ✗ ${p.gamerTag}: ${result.error}`);
			}
		}
		log(`Done: ${moved} in Main, ${cleaned} moved, ${failed} failed`);
	} else {
		log(`Ensuring all players are in Swiss only (${swissEventId})...`);
		for (const p of participants) {
			const targetEvents = [swissEventId];
			const currentSet = new Set(p.currentEventIds);
			if (currentSet.size === 1 && currentSet.has(swissEventId)) { moved++; continue; }
			const wasElsewhere = p.currentEventIds.some((id) => id !== swissEventId);
			const result = await updateParticipantEvents(p.participantId, targetEvents);
			if (result.ok) {
				moved++;
				if (wasElsewhere) { cleaned++; log(`  ${p.gamerTag} → Swiss only`); }
			} else {
				failed++;
				log(`  ✗ ${p.gamerTag}: ${result.error}`);
			}
		}
		log(`Done: ${moved} in Swiss, ${cleaned} cleaned, ${failed} failed`);
	}

	await saveTournament(tournament);

	return Response.json({ ok: true, moved, cleaned, failed, logs });
};
