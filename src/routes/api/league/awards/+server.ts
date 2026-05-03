import type { RequestHandler } from './$types';
import { getLeagueSeason, getLeagueConfig, computeSeasonAwards } from '$lib/server/league-store';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const seasonId = parseInt(url.searchParams.get('season') ?? '10', 10);
	const season = await getLeagueSeason(seasonId);
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });
	const config = await getLeagueConfig();
	const minEventsParam = url.searchParams.get('minEvents');
	const minEvents = minEventsParam ? parseInt(minEventsParam, 10) : undefined;
	return Response.json(computeSeasonAwards(season, minEvents, config));
};
