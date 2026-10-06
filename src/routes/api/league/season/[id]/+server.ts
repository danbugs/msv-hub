import type { RequestHandler } from './$types';
import { getLeagueSeason, getRankings, getLeagueConfig, getMinEventsForSeason, getRatingConfigForSeason } from '$lib/server/league-store';

export const GET: RequestHandler = async ({ params, url }) => {
	const id = parseInt(params.id, 10);
	if (isNaN(id)) return Response.json({ error: 'Invalid season ID' }, { status: 400 });

	const season = await getLeagueSeason(id);
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });

	const minEventsParam = url.searchParams.get('minEvents');
	const leagueConfig = await getLeagueConfig();
	const ratingConfig = getRatingConfigForSeason(leagueConfig, id);
	const config = {
		minEvents: minEventsParam ? parseInt(minEventsParam, 10) : getMinEventsForSeason(leagueConfig, id),
		attendanceBonus: ratingConfig.attendanceBonus ?? (id === 0 ? 5 : leagueConfig.attendanceBonus),
		conservativeFactor: ratingConfig.conservativeFactor ?? 0
	};
	const rankings = getRankings(season, config);

	// Rankings drop players under the attendance minimum; admin tools (merge) need everyone
	const eventCounts = new Map<string, number>();
	for (const e of season.events) {
		for (const p of e.placements) eventCounts.set(p.playerId, (eventCounts.get(p.playerId) ?? 0) + 1);
	}
	const players = Object.values(season.players)
		.map((p) => ({ id: p.id, gamerTag: p.gamerTag, aliases: p.aliases ?? [], events: eventCounts.get(p.id) ?? 0 }))
		.sort((a, b) => b.events - a.events);

	return Response.json({
		id: season.id,
		name: season.name,
		startDate: season.startDate,
		endDate: season.endDate,
		events: season.events.map((e) => ({
			slug: e.slug,
			name: e.name,
			date: e.date,
			eventNumber: e.eventNumber,
			entrantCount: e.entrantCount,
			weight: e.weight
		})),
		rankings,
		players,
		totalMatches: season.matches.length,
		plannedSlugs: season.plannedSlugs ?? []
	});
};
