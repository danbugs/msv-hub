import type { RequestHandler } from './$types';
import { getLeagueSeason, getPlayerStats, getLeagueConfig, getMinEventsForSeason, getRatingConfigForSeason } from '$lib/server/league-store';

export const GET: RequestHandler = async ({ params }) => {
	const id = parseInt(params.id, 10);
	if (isNaN(id)) return Response.json({ error: 'Invalid season ID' }, { status: 400 });

	const season = await getLeagueSeason(id);
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });

	const leagueConfig = await getLeagueConfig();
	const ratingConfig = getRatingConfigForSeason(leagueConfig, id);
	const rankConfig = {
		minEvents: getMinEventsForSeason(leagueConfig, id),
		attendanceBonus: ratingConfig.attendanceBonus ?? (id === 0 ? 5 : leagueConfig.attendanceBonus),
		conservativeFactor: ratingConfig.conservativeFactor ?? 0
	};

	const stats = getPlayerStats(season, params.playerId, rankConfig);
	if (!stats) return Response.json({ error: 'Player not found' }, { status: 404 });

	return Response.json(stats);
};
