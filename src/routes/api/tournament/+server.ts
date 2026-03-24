import type { RequestHandler } from './$types';
import { saveTournament, getActiveTournament, deleteTournament } from '$lib/server/store';
import { calculateRecommendedRounds } from '$lib/server/swiss';
import type { TournamentState, Entrant } from '$lib/types/tournament';

/** GET — fetch the active tournament */
export const GET: RequestHandler = async ({ locals }) => {
	const tournament = await getActiveTournament();
	return Response.json(tournament);
};

/** POST — create a new tournament from seeder results or manual entry */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { name, slug, entrants, numStations, streamStation } = body as {
		name: string;
		slug: string;
		entrants: { gamerTag: string; initialSeed: number }[];
		numStations: number;
		streamStation?: number;
	};

	if (!name || !slug || !entrants?.length || !numStations) {
		return Response.json({ error: 'name, slug, entrants, and numStations are required' }, { status: 400 });
	}

	const numRounds = calculateRecommendedRounds(entrants.length, numStations);
	if (numRounds === null) {
		return Response.json({ error: 'Too few stations for this number of players' }, { status: 400 });
	}

	const tournamentEntrants: Entrant[] = entrants.map((e, i) => ({
		id: `e-${i + 1}`,
		gamerTag: e.gamerTag,
		initialSeed: e.initialSeed
	}));

	const state: TournamentState = {
		slug,
		name,
		phase: 'swiss',
		entrants: tournamentEntrants,
		settings: {
			numRounds,
			numStations,
			streamStation: streamStation ?? 1
		},
		rounds: [],
		currentRound: 0,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};

	await saveTournament(state);
	return Response.json(state);
};

/** DELETE — delete the active tournament */
export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	await deleteTournament(tournament.slug);
	return Response.json({ ok: true });
};
