import { redirect } from '@sveltejs/kit';
import { getAllTOEmails } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/');
	return { toEmails: getAllTOEmails() };
};
