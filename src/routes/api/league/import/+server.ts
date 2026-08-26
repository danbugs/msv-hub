import type { RequestHandler } from './$types';
import { importSeason, syncEventsToAllTime } from '$lib/server/league-import';
import { getLeagueConfig, getRatingConfigForSeason } from '$lib/server/league-store';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { seasonId, seasonName, startDate, endDate, tournamentSlugs, forceRefetch, weights } = body as {
		seasonId: number;
		seasonName: string;
		startDate: string;
		endDate: string;
		tournamentSlugs: string[];
		forceRefetch?: boolean;
		weights?: Record<string, number>;
	};

	if (!seasonId || !seasonName || !tournamentSlugs?.length) {
		return Response.json({ error: 'Missing required fields' }, { status: 400 });
	}

	const config = await getLeagueConfig();
	const ratingConfig = getRatingConfigForSeason(config, seasonId);

	const logs: string[] = [];
	const season = await importSeason(
		seasonId,
		seasonName,
		startDate,
		endDate,
		tournamentSlugs,
		(msg) => logs.push(msg),
		{ forceRefetch: forceRefetch ?? false, passes: ratingConfig.passes ?? 3, weights, sigmaBoostPerEvent: ratingConfig.sigmaBoostPerEvent, sigmaFloor: ratingConfig.sigmaFloor }
	);

	// Auto-sync imported events to the All-Time season
	if (seasonId !== 0) {
		try {
			await syncEventsToAllTime(tournamentSlugs, weights, (msg) => logs.push(msg));
		} catch (e) {
			logs.push(`All-Time sync warning: ${e instanceof Error ? e.message : 'unknown error'}`);
		}
	}

	return Response.json({
		ok: true,
		seasonId: season.id,
		events: season.events.length,
		players: Object.keys(season.players).length,
		matches: season.matches.length,
		logs
	});
};
