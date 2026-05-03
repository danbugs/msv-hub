import type { PageServerLoad } from './$types';
import { getLeagueSeason, getPlayerStats } from '$lib/server/league-store';

export const load: PageServerLoad = async ({ params, url }) => {
	const seasonId = parseInt(url.searchParams.get('season') ?? '10', 10);
	const season = await getLeagueSeason(seasonId);

	if (!season) return { stats: null, seasonId, seasonName: null };

	const stats = getPlayerStats(season, params.id);

	return {
		stats,
		seasonId,
		seasonName: season.name,
		seasonStart: season.startDate,
		seasonEnd: season.endDate
	};
};
