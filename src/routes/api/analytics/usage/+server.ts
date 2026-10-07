import type { RequestHandler } from './$types';
import { getUsageSummary } from '$lib/server/analytics';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	return Response.json(await getUsageSummary(30));
};
