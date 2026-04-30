import type { RequestHandler } from './$types';
import { saveTournament, getActiveTournament, deleteTournament } from '$lib/server/store';
import { calculateRecommendedRounds, generateBracket, assignBracketStations } from '$lib/server/swiss';
import type { TournamentState, Entrant, FinalStanding } from '$lib/types/tournament';

/** GET — fetch the active tournament */
export const GET: RequestHandler = async ({ locals }) => {
	const tournament = await getActiveTournament();
	return Response.json(tournament);
};

/** POST — create a new tournament from seeder results or manual entry */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { name, slug, entrants, numStations, streamStation, numRounds: numRoundsOverride, mode: modeParam } = body as {
		name: string;
		slug: string;
		entrants: { gamerTag: string; initialSeed: number }[];
		numStations: number;
		streamStation?: number;
		numRounds?: number;
		mode?: 'default' | 'gauntlet';
	};

	if (!name || !slug || !entrants?.length || !numStations) {
		return Response.json({ error: 'name, slug, entrants, and numStations are required' }, { status: 400 });
	}

	const mode = modeParam ?? 'default';

	const tournamentEntrants: Entrant[] = entrants.map((e, i) => ({
		id: `e-${i + 1}`,
		gamerTag: e.gamerTag,
		initialSeed: e.initialSeed
	}));

	if (mode === 'gauntlet') {
		const players = tournamentEntrants.map((e) => ({ entrantId: e.id, seed: e.initialSeed }));
		const fakeStandings: FinalStanding[] = tournamentEntrants.map((e) => ({
			rank: e.initialSeed, entrantId: e.id, gamerTag: e.gamerTag,
			wins: 0, losses: 0, initialSeed: e.initialSeed, totalScore: 0,
			basePoints: 0, winPoints: 0, lossPoints: 0, cinderellaBonus: 0,
			expectedWins: 0, winsAboveExpected: 0, bracket: 'main' as const
		}));
		const settings = { numRounds: 0, numStations, streamStation: streamStation ?? 16 };
		const mainBracket = generateBracket('main', players, fakeStandings, settings);

		const state: TournamentState = {
			slug, name, mode: 'gauntlet',
			phase: 'brackets',
			entrants: tournamentEntrants,
			settings,
			rounds: [],
			currentRound: 0,
			brackets: { main: mainBracket },
			createdAt: Date.now(),
			updatedAt: Date.now()
		};

		await saveTournament(state);
		return Response.json(state);
	}

	const numRounds = numRoundsOverride ?? calculateRecommendedRounds(entrants.length, numStations);
	if (numRounds === null) {
		return Response.json({ error: 'Too few stations for this number of players' }, { status: 400 });
	}
	if (numRounds > 5) {
		return Response.json({ error: 'Max 5 Swiss rounds supported' }, { status: 400 });
	}
	if (numRounds < 1) {
		return Response.json({ error: 'At least 1 Swiss round required' }, { status: 400 });
	}

	const state: TournamentState = {
		slug,
		name,
		phase: 'swiss',
		entrants: tournamentEntrants,
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

/** DELETE — delete the active tournament */
export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	await deleteTournament(tournament.slug);
	return Response.json({ ok: true });
};
