import type { PageServerLoad } from './$types';
import { getLeagueSeason, getPlayerStats } from '$lib/server/league-store';
import { getPlayerTier } from '$lib/types/league';

export const load: PageServerLoad = async ({ params, url }) => {
	const seasonId = parseInt(url.searchParams.get('season') ?? '10', 10);
	const season = await getLeagueSeason(seasonId);

	if (!season) return { stats: null, seasonId, seasonName: null };

	const stats = getPlayerStats(season, params.id);

	const tier = stats ? getPlayerTier(stats.player.points) : null;

	return {
		stats,
		seasonId,
		seasonName: season.name,
		seasonStart: season.startDate,
		seasonEnd: season.endDate,
		tier
	};
};
