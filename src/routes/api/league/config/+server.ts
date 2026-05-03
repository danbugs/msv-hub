import type { RequestHandler } from './$types';
import { getLeagueConfig, saveLeagueConfig } from '$lib/server/league-store';
import type { LeagueConfig } from '$lib/server/league-store';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const config = await getLeagueConfig();
	return Response.json(config);
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const body = await request.json() as Partial<LeagueConfig>;
	const current = await getLeagueConfig();
	const updated = { ...current, ...body };
	await saveLeagueConfig(updated);
	return Response.json(updated);
};
