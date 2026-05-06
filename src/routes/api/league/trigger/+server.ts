import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { importSeason } from '$lib/server/league-import';

export const POST: RequestHandler = async ({ request }) => {
	const auth = request.headers.get('authorization');
	const expected = `Bearer ${env.STARTGG_TOKEN}`;
	if (!auth || auth !== expected) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json().catch(() => ({})) as Record<string, unknown>;
	const seasonId = body.seasonId as number ?? 10;
	const forceRefetch = body.forceRefetch as boolean ?? false;

	let slugs: string[];
	if (Array.isArray(body.slugs)) {
		slugs = body.slugs as string[];
	} else {
		const slugStart = body.slugStart as number ?? 125;
		const slugEnd = body.slugEnd as number ?? 137;
		slugs = [];
		for (let i = slugStart; i <= slugEnd; i++) {
			slugs.push(`microspacing-vancouver-${i}`);
		}
	}

	const logs: string[] = [];
	const season = await importSeason(
		seasonId,
		`Season ${seasonId}`,
		'2026-02-01',
		'2026-05-12',
		slugs,
		(msg) => logs.push(msg),
		{ forceRefetch, twoPass: true }
	);

	return Response.json({
		ok: true,
		events: season.events.length,
		players: Object.keys(season.players).length,
		matches: season.matches.length,
		logs
	});
};
