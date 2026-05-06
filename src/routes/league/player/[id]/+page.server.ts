import type { PageServerLoad } from './$types';
import { getLeagueSeason, getLeagueConfig, getPlayerStats, getRankings } from '$lib/server/league-store';
import { getPlayerTier } from '$lib/types/league';

export const load: PageServerLoad = async ({ params, url }) => {
	const seasonParam = url.searchParams.get('season') ?? '10';
	const seasonId = seasonParam === 'all-time' ? 0 : parseInt(seasonParam, 10);
	const season = await getLeagueSeason(seasonId);

	if (!season) return { stats: null, seasonId, seasonParam, seasonName: null };

	const config = await getLeagueConfig();
	const stats = getPlayerStats(season, params.id, config);

	const rankings = getRankings(season, config);
	const rankEntry = rankings.find((r) => r.playerId === params.id);
	const adjustedPoints = rankEntry?.points ?? stats?.player.points ?? 0;
	const tier = stats ? getPlayerTier(adjustedPoints) : null;

	return {
		stats,
		adjustedPoints,
		attendanceBonus: config.attendanceBonus,
		seasonId,
		seasonParam,
		seasonName: season.name,
		seasonStart: season.startDate,
		seasonEnd: season.endDate,
		tier
	};
};
