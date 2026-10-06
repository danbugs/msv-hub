import type { PageServerLoad } from './$types';
import { getTournament, toPublicTournament } from '$lib/server/store';

export const load: PageServerLoad = async ({ params }) => {
	const tournament = toPublicTournament(await getTournament(params.slug));
	return { slug: params.slug, tournament };
};
