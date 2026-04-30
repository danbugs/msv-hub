import type { RequestHandler } from './$types';
import { saveTournament } from '$lib/server/store';
import { calculateRecommendedRounds } from '$lib/server/swiss';
import {
	gql,
	EVENT_BY_SLUG_QUERY,
	EVENT_PHASES_QUERY,
	fetchPhaseSeedsWithTags,
	fetchPhaseSeeds,
	fetchPhaseGroups
} from '$lib/server/startgg';
import type { TournamentState, Entrant } from '$lib/types/tournament';

/** POST — create a tournament from an existing StartGG event's seedings */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { eventSlug, numStations, streamStation, numRounds: numRoundsOverride } = body as {
		eventSlug: string;
		numStations: number;
		streamStation?: number;
		numRounds?: number;
	};

	if (!eventSlug || !numStations) {
		return Response.json({ error: 'eventSlug and numStations are required' }, { status: 400 });
	}

	// Normalise: strip URL prefix, trim slashes
	const slug = eventSlug
		.replace(/^https?:\/\/[^/]+\//i, '')
		.replace(/^\/+|\/+$/g, '');

	// Resolve event ID
	const eventData = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug });
	if (!eventData?.event) {
		return Response.json({ error: `Event not found: ${slug}` }, { status: 404 });
	}
	const { id: eventId, name: eventName } = eventData.event;

	// Get first phase
	const phaseData = await gql<{ event: { phases: { id: number; name: string; numSeeds: number }[] } }>(
		EVENT_PHASES_QUERY, { eventId }
	);
	const phases = phaseData?.event?.phases ?? [];
	if (!phases.length) {
		return Response.json({ error: 'No phases found in this event' }, { status: 404 });
	}
	const phaseId = phases[0].id;

	// Fetch seeds (tags for display + raw for entrant IDs) in parallel.
	const [seeds, sgSeeds] = await Promise.all([
		fetchPhaseSeedsWithTags(phaseId),
		fetchPhaseSeeds(phaseId).catch(() => [])
	]);
	if (!seeds.length) {
		return Response.json({ error: 'No seeds found in first phase' }, { status: 404 });
	}

	const numRounds = numRoundsOverride ?? calculateRecommendedRounds(seeds.length, numStations);
	if (numRounds === null) {
		return Response.json({ error: 'Too few stations for this number of players' }, { status: 400 });
	}
	if (numRounds > 5) {
		return Response.json({ error: 'Max 5 Swiss rounds supported' }, { status: 400 });
	}
	if (numRounds < 1) {
		return Response.json({ error: 'At least 1 Swiss round required' }, { status: 400 });
	}

	// Build seedNum → startggEntrantId map (exact match by seed number, no fragile gamerTag comparison).
	// Use Number() to ensure the ID is stored as a number regardless of what the API returns —
	// the GraphQL ID scalar can be serialized as either a string or integer.
	const sgSeedToEntrantId = new Map<number, number>();
	for (const seed of sgSeeds) {
		const seedNum = Number((seed as { seedNum?: unknown }).seedNum);
		const entrantId = Number((seed as { entrant?: { id?: unknown } }).entrant?.id);
		if (seedNum && entrantId && !isNaN(seedNum) && !isNaN(entrantId)) {
			sgSeedToEntrantId.set(seedNum, entrantId);
		}
	}

	// Fetch phase groups for ALL Swiss rounds (each StartGG phase = one round).
	// Separate "Final Standings" phase from Swiss round phases.
	const swissPhases = phases.filter((p) => !p.name.toLowerCase().includes('final'))
		.sort((a, b) => {
			const numA = parseInt(a.name.match(/\d+/)?.[0] ?? '0');
			const numB = parseInt(b.name.match(/\d+/)?.[0] ?? '0');
			return numA - numB;
		});
	const finalStandingsPhase = phases.find((p) => p.name.toLowerCase().includes('final'));
	const allRoundGroups: { id: number; displayIdentifier: string; phaseId: number; roundNumber: number }[] = [];
	for (let i = 0; i < swissPhases.length; i++) {
		const phase = swissPhases[i];
		const roundNum = parseInt(phase.name.match(/\d+/)?.[0] ?? String(i + 1));
		const groups = await fetchPhaseGroups(phase.id).catch(() => []);
		if (groups.length > 0) {
			allRoundGroups.push({ ...groups[0], phaseId: phase.id, roundNumber: roundNum });
		}
	}
	// Fetch phase group for Final Standings phase (used to push Swiss standings after bracket split)
	let finalStandingsPhaseGroupId: number | undefined;
	if (finalStandingsPhase) {
		const groups = await fetchPhaseGroups(finalStandingsPhase.id).catch(() => []);
		if (groups.length > 0) finalStandingsPhaseGroupId = groups[0].id;
	}

	const tourneySlug = slug.replace(/\//g, '-');
	const entrants: Entrant[] = seeds.map((s, i) => ({
		id: `e-${i + 1}`,
		gamerTag: s.gamerTag,
		initialSeed: s.seedNum,
		startggEntrantId: sgSeedToEntrantId.get(s.seedNum)
	}));

	const state: TournamentState = {
		slug: tourneySlug,
		name: eventName,
		phase: 'swiss',
		entrants,
		settings: {
			numRounds,
			numStations,
			streamStation: streamStation ?? 16
		},
		rounds: [],
		currentRound: 0,
		startggEventId: eventId,
		startggEventSlug: slug,
		startggPhase1Id: phaseId,
		startggPhase1Groups: allRoundGroups.length ? allRoundGroups : undefined,
		startggFinalStandingsPhaseId: finalStandingsPhase?.id,
		startggFinalStandingsPhaseGroupId: finalStandingsPhaseGroupId,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};

	await saveTournament(state);
	return Response.json(state);
};
