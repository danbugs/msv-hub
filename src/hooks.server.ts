import type { Handle } from '@sveltejs/kit';
import { verifySessionToken } from '$lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get('session');
	if (token) {
		const session = await verifySessionToken(token);
		if (session) {
			event.locals.user = session;
		}
	}
	return resolve(event);
};
