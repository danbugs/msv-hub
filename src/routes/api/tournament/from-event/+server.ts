import type { RequestHandler } from './$types';
import { saveTournament } from '$lib/server/store';
import { calculateRecommendedRounds } from '$lib/server/swiss';
import { gql, EVENT_BY_SLUG_QUERY, EVENT_PHASES_QUERY, fetchPhaseSeedsWithTags } from '$lib/server/startgg';
import type { TournamentState, Entrant } from '$lib/types/tournament';

/** POST — create a tournament from an existing StartGG event's seedings */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { eventSlug, numStations, streamStation } = body as {
		eventSlug: string;
		numStations: number;
		streamStation?: number;
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

	// Fetch seeds with gamer tags
	const seeds = await fetchPhaseSeedsWithTags(phaseId);
	if (!seeds.length) {
		return Response.json({ error: 'No seeds found in first phase' }, { status: 404 });
	}

	const numRounds = calculateRecommendedRounds(seeds.length, numStations);
	if (numRounds === null) {
		return Response.json({ error: 'Too few stations for this number of players' }, { status: 400 });
	}

	const tourneySlug = slug.replace(/\//g, '-');
	const entrants: Entrant[] = seeds.map((s, i) => ({
		id: `e-${i + 1}`,
		gamerTag: s.gamerTag,
		initialSeed: s.seedNum
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
		createdAt: Date.now(),
		updatedAt: Date.now()
	};

	await saveTournament(state);
	return Response.json(state);
};
