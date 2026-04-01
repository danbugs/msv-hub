import type { Handle } from '@sveltejs/kit';
import { verifySessionToken } from '$lib/server/auth';
import { runAttendeeCheckIfDue } from '$lib/server/attendee-check-bg';

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get('session');
	if (token) {
		const session = await verifySessionToken(token);
		if (session) {
			event.locals.user = session;
		}
	}

	// Fire-and-forget: check attendee count every 5 min, piggyback on any request
	runAttendeeCheckIfDue().catch(() => {});

	return resolve(event);
};
