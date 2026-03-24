import type { RequestHandler } from './$types';
import { getActiveTournament, getTournament } from '$lib/server/store';

/** GET — public results export (no auth required, for cowork to report to StartGG) */
export const GET: RequestHandler = async ({ url }) => {
	const slug = url.searchParams.get('slug');
	const tournament = slug ? await getTournament(slug) : await getActiveTournament();

	if (!tournament) {
		return Response.json({ error: 'No tournament found' }, { status: 404 });
	}

	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));

	// Build match report
	const swissMatches = tournament.rounds.flatMap((round) => [
		...round.matches
			.filter((m) => m.winnerId)
			.map((m) => ({
				phase: `Swiss Round ${round.number}`,
				roundNumber: round.number,
				topPlayer: entrantMap.get(m.topPlayerId)?.gamerTag ?? m.topPlayerId,
				bottomPlayer: entrantMap.get(m.bottomPlayerId)?.gamerTag ?? m.bottomPlayerId,
				winner: entrantMap.get(m.winnerId!)?.gamerTag ?? m.winnerId,
				topPlayerId: m.topPlayerId,
				bottomPlayerId: m.bottomPlayerId,
				winnerId: m.winnerId
			})),
		...(round.byePlayerId
			? [{
				phase: `Swiss Round ${round.number}`,
				roundNumber: round.number,
				topPlayer: entrantMap.get(round.byePlayerId)?.gamerTag ?? round.byePlayerId,
				bottomPlayer: 'BYE',
				winner: entrantMap.get(round.byePlayerId)?.gamerTag ?? round.byePlayerId,
				topPlayerId: round.byePlayerId,
				bottomPlayerId: 'BYE',
				winnerId: round.byePlayerId
			}]
			: [])
	]);

	const bracketMatches = tournament.brackets
		? Object.entries(tournament.brackets).flatMap(([bracketName, bracket]) =>
			bracket.matches
				.filter((m) => m.winnerId && m.topPlayerId && m.bottomPlayerId)
				.map((m) => ({
					phase: `${bracketName === 'main' ? 'Main' : 'Redemption'} Bracket`,
					round: m.round,
					matchIndex: m.matchIndex,
					topPlayer: entrantMap.get(m.topPlayerId!)?.gamerTag ?? m.topPlayerId,
					bottomPlayer: entrantMap.get(m.bottomPlayerId!)?.gamerTag ?? m.bottomPlayerId,
					winner: entrantMap.get(m.winnerId!)?.gamerTag ?? m.winnerId,
					topCharacter: m.topCharacter,
					bottomCharacter: m.bottomCharacter,
					topPlayerId: m.topPlayerId,
					bottomPlayerId: m.bottomPlayerId,
					winnerId: m.winnerId
				}))
		)
		: [];

	const result = {
		tournament: {
			name: tournament.name,
			slug: tournament.slug,
			phase: tournament.phase,
			numEntrants: tournament.entrants.length,
			numSwissRounds: tournament.rounds.length,
			createdAt: tournament.createdAt,
			updatedAt: tournament.updatedAt
		},
		entrants: tournament.entrants.map((e) => ({
			gamerTag: e.gamerTag,
			initialSeed: e.initialSeed
		})),
		finalStandings: tournament.finalStandings?.map((s) => ({
			rank: s.rank,
			gamerTag: s.gamerTag,
			wins: s.wins,
			losses: s.losses,
			initialSeed: s.initialSeed,
			bracket: s.bracket,
			totalScore: s.totalScore
		})),
		swissMatches,
		bracketMatches
	};

	return Response.json(result, {
		headers: { 'Access-Control-Allow-Origin': '*' }
	});
};
