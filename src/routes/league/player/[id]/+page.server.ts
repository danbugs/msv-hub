import type { PageServerLoad } from './$types';
import { getLeagueSeason, getLeagueConfig, getPlayerStats, getRankings } from '$lib/server/league-store';
import { getPlayerTier } from '$lib/types/league';

export const load: PageServerLoad = async ({ params, url }) => {
	const seasonId = parseInt(url.searchParams.get('season') ?? '10', 10);
	const season = await getLeagueSeason(seasonId);

	if (!season) return { stats: null, seasonId, seasonName: null };

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
		seasonName: season.name,
		seasonStart: season.startDate,
		seasonEnd: season.endDate,
		tier
	};
};
