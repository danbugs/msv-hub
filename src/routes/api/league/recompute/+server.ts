import type { RequestHandler } from './$types';
import { recomputeSeasonFromStored } from '$lib/server/league-store';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => ({})) as Record<string, unknown>;
	const seasonId = body.seasonId as number ?? 0;

	const logs: string[] = [];
	const season = await recomputeSeasonFromStored(seasonId, (msg) => logs.push(msg));
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });

	return Response.json({
		ok: true,
		events: season.events.length,
		players: Object.keys(season.players).length,
		matches: season.matches.length,
		logs
	});
};
