import type { RequestHandler } from './$types';
import { getSeasonIndex, getLeagueSeason, saveLeagueSeason } from '$lib/server/league-store';

export const GET: RequestHandler = async () => {
	const seasons = await getSeasonIndex();
	return Response.json(seasons);
};

export const POST: RequestHandler = async ({ request }) => {
	const { seasonId, seasonName, startDate, endDate, plannedSlugs } = await request.json();
	if (!seasonId || !seasonName) {
		return Response.json({ error: 'Missing seasonId or seasonName' }, { status: 400 });
	}
	const existing = await getLeagueSeason(seasonId);
	if (existing) {
		return Response.json({ error: `Season ${seasonId} already exists` }, { status: 409 });
	}
	await saveLeagueSeason({
		id: seasonId,
		name: seasonName,
		startDate: startDate ?? '',
		endDate: endDate ?? '',
		events: [],
		players: {},
		matches: [],
		plannedSlugs: plannedSlugs ?? undefined
	});
	return Response.json({ ok: true, seasonId });
};
