import type { RequestHandler } from './$types';
import { importSeason } from '$lib/server/league-import';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { seasonId, seasonName, startDate, endDate, tournamentSlugs, forceRefetch } = body as {
		seasonId: number;
		seasonName: string;
		startDate: string;
		endDate: string;
		tournamentSlugs: string[];
		forceRefetch?: boolean;
	};

	if (!seasonId || !seasonName || !tournamentSlugs?.length) {
		return Response.json({ error: 'Missing required fields' }, { status: 400 });
	}

	const logs: string[] = [];
	const season = await importSeason(
		seasonId,
		seasonName,
		startDate,
		endDate,
		tournamentSlugs,
		(msg) => logs.push(msg),
		{ forceRefetch: forceRefetch ?? false, twoPass: true }
	);

	return Response.json({
		ok: true,
		seasonId: season.id,
		events: season.events.length,
		players: Object.keys(season.players).length,
		matches: season.matches.length,
		logs
	});
};
