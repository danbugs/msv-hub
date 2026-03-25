import type { RequestHandler } from './$types';
import { getCommunityConfig } from '$lib/server/store';

/** GET — return saved community config (motivational messages list etc.) */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const config = await getCommunityConfig();
	return Response.json(config);
};
