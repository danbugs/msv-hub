import type { PageServerLoad } from './$types';
import { getTournament } from '$lib/server/store';

export const load: PageServerLoad = async ({ params }) => {
	const tournament = await getTournament(params.slug);
	return { slug: params.slug, tournament };
};
