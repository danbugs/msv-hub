import type { RequestHandler } from './$types';
import { getSeasonIndex } from '$lib/server/league-store';

export const GET: RequestHandler = async () => {
	const seasons = await getSeasonIndex();
	return Response.json(seasons);
};
