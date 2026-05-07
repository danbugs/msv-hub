import type { RequestHandler } from './$types';
import { getLeagueSeason, getLeagueConfig, computeSeasonAwards } from '$lib/server/league-store';
import { getEventConfig } from '$lib/server/store';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const seasonId = parseInt(url.searchParams.get('season') ?? '10', 10);
	const season = await getLeagueSeason(seasonId);
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });
	const config = await getLeagueConfig();
	const rankConfig = seasonId === 0 ? { ...config, attendanceBonus: 5 } : config;
	const minEventsParam = url.searchParams.get('minEvents');
	const minEvents = minEventsParam ? parseInt(minEventsParam, 10) : undefined;

	const eventConfig = await getEventConfig();
	const toNames = new Set(eventConfig.tos.map((t) => t.name.toLowerCase()));
	const toIds = new Set<string>();
	for (const p of Object.values(season.players)) {
		if (toNames.has(p.gamerTag.toLowerCase()) || p.aliases.some((a) => toNames.has(a.toLowerCase()))) {
			toIds.add(p.id);
		}
	}

	return Response.json(computeSeasonAwards(season, minEvents, rankConfig, toIds));
};
