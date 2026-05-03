import type { RequestHandler } from './$types';
import { getLeagueSeason, saveLeagueSeason } from '$lib/server/league-store';
import { importSeason } from '$lib/server/league-import';

export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const { seasonId, eventSlug } = await request.json() as { seasonId: number; eventSlug: string };
	if (!seasonId || !eventSlug) return Response.json({ error: 'Missing fields' }, { status: 400 });

	const season = await getLeagueSeason(seasonId);
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });

	const remainingSlugs = season.events.filter((e) => e.slug !== eventSlug).map((e) => e.slug);
	if (remainingSlugs.length === season.events.length) {
		return Response.json({ error: 'Event not found' }, { status: 404 });
	}

	if (remainingSlugs.length === 0) {
		season.events = [];
		season.matches = [];
		season.players = {};
		await saveLeagueSeason(season);
		return Response.json({ ok: true, events: 0 });
	}

	const logs: string[] = [];
	const updated = await importSeason(
		season.id, season.name, season.startDate, season.endDate,
		remainingSlugs, (msg) => logs.push(msg)
	);

	return Response.json({
		ok: true,
		events: updated.events.length,
		players: Object.keys(updated.players).length,
		matches: updated.matches.length,
		logs
	});
};
