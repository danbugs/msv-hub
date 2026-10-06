import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getActiveTournament } from '$lib/server/store';

// One bookmarkable URL that always points at this week's bracket.
export const load: PageServerLoad = async ({ url }) => {
	const t = await getActiveTournament();
	if (t) redirect(307, `/live/${t.slug}${url.search}`);
	return {};
};
