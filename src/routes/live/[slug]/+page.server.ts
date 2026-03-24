import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	// Public page — no auth required
	return { slug: params.slug };
};
