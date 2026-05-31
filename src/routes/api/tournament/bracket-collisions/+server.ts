import type { RequestHandler } from './$types';
import { predictBracketMatchups, fetchRecentMatchups } from '$lib/server/bracket-predict';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { entrants, targetNumber } = body as {
		entrants: { seedNum: number; gamerTag: string; playerId?: number }[];
		targetNumber: number;
	};

	if (!entrants?.length || !targetNumber) {
		return Response.json({ error: 'entrants and targetNumber required' }, { status: 400 });
	}

	const matchups = predictBracketMatchups(entrants);

	const playerIds = new Set<number>();
	for (const e of entrants) {
		if (e.playerId) playerIds.add(e.playerId);
	}

	const recentMatches = await fetchRecentMatchups(targetNumber, playerIds);

	function pairKey(a: number, b: number): string {
		return a < b ? `${a}:${b}` : `${b}:${a}`;
	}

	const collisions = matchups
		.filter((m) => {
			if (!m.playerId1 || !m.playerId2) return false;
			return recentMatches.has(pairKey(m.playerId1, m.playerId2));
		})
		.map((m) => {
			const key = pairKey(m.playerId1!, m.playerId2!);
			const history = recentMatches.get(key)!;
			return {
				seed1: m.seed1, seed2: m.seed2,
				tag1: m.tag1, tag2: m.tag2,
				round: m.round, bracket: m.bracket,
				event: history.event
			};
		});

	return Response.json({ collisions });
};
