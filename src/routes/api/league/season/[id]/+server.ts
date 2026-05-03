import type { RequestHandler } from './$types';
import { getLeagueSeason, getRankings } from '$lib/server/league-store';

export const GET: RequestHandler = async ({ params }) => {
	const id = parseInt(params.id, 10);
	if (isNaN(id)) return Response.json({ error: 'Invalid season ID' }, { status: 400 });

	const season = await getLeagueSeason(id);
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });

	const rankings = getRankings(season);

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
			entrantCount: e.entrantCount
		})),
		rankings,
		totalMatches: season.matches.length
	});
};
