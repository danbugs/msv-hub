import type { RequestHandler } from './$types';
import { saveTournament } from '$lib/server/store';
import { calculateRecommendedRounds, generateBracket, assignBracketStations } from '$lib/server/swiss';
import {
	gql,
	EVENT_BY_SLUG_QUERY,
	EVENT_PHASES_QUERY,
	TOURNAMENT_QUERY,
	fetchPhaseSeedsWithTags,
	fetchPhaseSeeds,
	fetchPhaseGroups
} from '$lib/server/startgg';
import type { TournamentState, Entrant, FinalStanding } from '$lib/types/tournament';

/** POST — create a tournament from an existing StartGG event's seedings */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { eventSlug, numStations, streamStation, numRounds: numRoundsOverride, mode: modeParam } = body as {
		eventSlug: string;
		numStations: number;
		streamStation?: number;
		numRounds?: number;
		mode?: 'default' | 'gauntlet';
	};

	if (!eventSlug || !numStations) {
		return Response.json({ error: 'eventSlug and numStations are required' }, { status: 400 });
	}

	// Normalise: strip URL prefix, trim slashes
	const slug = eventSlug
		.replace(/^https?:\/\/[^/]+\//i, '')
		.replace(/^\/+|\/+$/g, '');

	const mode = modeParam ?? 'default';

	let resolvedSlug = slug;
	let eventId: number;
	let eventName: string;

	if (slug.includes('/event/')) {
		// Direct event slug provided
		const eventData = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug });
		if (!eventData?.event) {
			return Response.json({ error: `Event not found: ${slug}` }, { status: 404 });
		}
		eventId = eventData.event.id;
		eventName = eventData.event.name;
	} else {
		// Tournament-only slug — discover events automatically
		const tournSlug = slug.match(/tournament\/([^/]+)/)?.[1] ?? slug.replace(/^tournament\//, '');
		const tData = await gql<{ tournament: { events: { id: number; name: string; slug: string; numEntrants: number }[] } }>(
			TOURNAMENT_QUERY, { slug: tournSlug }
		);
		const events = tData?.tournament?.events ?? [];
		if (!events.length) {
			return Response.json({ error: `No events found for tournament: ${tournSlug}` }, { status: 404 });
		}

		let target: { id: number; name: string; slug: string } | undefined;
		if (mode === 'gauntlet') {
			target = events.find((e) => /main/i.test(e.name));
		} else {
			target = events.find((e) => /swiss/i.test(e.name));
		}
		if (!target) {
			target = events.find((e) => (e.numEntrants ?? 0) > 0) ?? events[0];
		}

		eventId = target.id;
		eventName = target.name;
		resolvedSlug = target.slug;
	}

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
	let [seeds, sgSeeds] = await Promise.all([
		fetchPhaseSeedsWithTags(phaseId),
		fetchPhaseSeeds(phaseId).catch(() => [])
	]);

	// If Swiss phase is empty (e.g. after a gauntlet reset moved everyone to Main),
	// try reading seeds from other events in the same tournament.
	if (!seeds.length) {
		const tournSlug = resolvedSlug.match(/tournament\/([^/]+)/)?.[1];
		if (tournSlug) {
			const tData = await gql<{ tournament: { events: { id: number; name: string }[] } }>(
				TOURNAMENT_QUERY, { slug: tournSlug }
			);
			const otherEvents = (tData?.tournament?.events ?? []).filter((e) => e.id !== eventId);
			for (const evt of otherEvents) {
				const evtPhases = await gql<{ event: { phases: { id: number }[] } }>(
					EVENT_PHASES_QUERY, { eventId: evt.id }
				);
				const fallbackPhaseId = evtPhases?.event?.phases?.[0]?.id;
				if (!fallbackPhaseId) continue;
				const [fallbackSeeds, fallbackSgSeeds] = await Promise.all([
					fetchPhaseSeedsWithTags(fallbackPhaseId),
					fetchPhaseSeeds(fallbackPhaseId).catch(() => [])
				]);
				if (fallbackSeeds.length) {
					seeds = fallbackSeeds;
					sgSeeds = fallbackSgSeeds;
					break;
				}
			}
		}
	}

	if (!seeds.length) {
		return Response.json({ error: 'No seeds found in first phase' }, { status: 404 });
	}

	// Build seedNum → startggEntrantId map
	const sgSeedToEntrantId = new Map<number, number>();
	for (const seed of sgSeeds) {
		const seedNum = Number((seed as { seedNum?: unknown }).seedNum);
		const entrantId = Number((seed as { entrant?: { id?: unknown } }).entrant?.id);
		if (seedNum && entrantId && !isNaN(seedNum) && !isNaN(entrantId)) {
			sgSeedToEntrantId.set(seedNum, entrantId);
		}
	}

	const tourneySlug = resolvedSlug.replace(/\//g, '-');
	const entrants: Entrant[] = seeds.map((s, i) => ({
		id: `e-${i + 1}`,
		gamerTag: s.gamerTag,
		initialSeed: s.seedNum,
		startggEntrantId: sgSeedToEntrantId.get(s.seedNum)
	}));

	if (mode === 'gauntlet') {
		const settings = { numRounds: 0, numStations, streamStation: streamStation ?? 16 };
		const players = entrants.map((e) => ({ entrantId: e.id, seed: e.initialSeed }));
		const fakeStandings: FinalStanding[] = entrants.map((e) => ({
			rank: e.initialSeed, entrantId: e.id, gamerTag: e.gamerTag,
			wins: 0, losses: 0, initialSeed: e.initialSeed, totalScore: 0,
			basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
			expectedWins: 0, winsAboveExpected: 0, bracket: 'main' as const
		}));
		let mainBracket = generateBracket('main', players, fakeStandings);
		mainBracket = assignBracketStations(mainBracket, settings);

		const state: TournamentState = {
			slug: tourneySlug, name: eventName, mode: 'gauntlet',
			phase: 'brackets', entrants, settings,
			rounds: [], currentRound: 0,
			brackets: { main: mainBracket },
			startggEventId: eventId, startggEventSlug: resolvedSlug,
			createdAt: Date.now(), updatedAt: Date.now()
		};

		await saveTournament(state);
		return Response.json(state);
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

	// Fetch phase groups for ALL Swiss rounds (each StartGG phase = one round).
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
	let finalStandingsPhaseGroupId: number | undefined;
	if (finalStandingsPhase) {
		const groups = await fetchPhaseGroups(finalStandingsPhase.id).catch(() => []);
		if (groups.length > 0) finalStandingsPhaseGroupId = groups[0].id;
	}

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
		startggEventSlug: resolvedSlug,
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
