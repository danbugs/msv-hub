import type { RequestHandler } from './$types';
import { predictBracketMatchups, fetchRecentMatchups, resolveCollisions } from '$lib/server/bracket-predict';

export const config = { maxDuration: 300 };

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { entrants, fix } = body as {
		entrants: { seedNum: number; gamerTag: string; playerId?: number }[];
		fix?: boolean;
	};

	if (!entrants?.length) {
		return Response.json({ error: 'entrants required' }, { status: 400 });
	}

	const recentMatches = await fetchRecentMatchups(entrants);

	function pairKey(a: number, b: number): string {
		return a < b ? `${a}:${b}` : `${b}:${a}`;
	}

	function findCollisions(ents: { seedNum: number; gamerTag: string; playerId?: number }[]) {
		return predictBracketMatchups(ents)
			.filter((m) => m.playerId1 && m.playerId2 && recentMatches.has(pairKey(m.playerId1, m.playerId2)))
			.map((m) => {
				const history = recentMatches.get(pairKey(m.playerId1!, m.playerId2!))!;
				return {
					seed1: m.seed1, seed2: m.seed2,
					tag1: m.tag1, tag2: m.tag2,
					round: m.round, bracket: m.bracket,
					event: history.event,
					count: history.count,
					isRegional: history.isRegional
				};
			});
	}

	if (fix) {
		const { fixed, swaps } = resolveCollisions(entrants, recentMatches);
		const collisions = findCollisions(fixed);
		return Response.json({ collisions, fixedEntrants: fixed, swaps });
	}

	return Response.json({ collisions: findCollisions(entrants) });
};
