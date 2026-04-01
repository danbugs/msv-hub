import type { Handle } from '@sveltejs/kit';
import { verifySessionToken } from '$lib/server/auth';
import { runAttendeeCheckIfDue } from '$lib/server/attendee-check-bg';
import { runMotivationalIfDue } from '$lib/server/motivational-bg';

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get('session');
	if (token) {
		const session = await verifySessionToken(token);
		if (session) {
			event.locals.user = session;
		}
	}

	// Fire-and-forget: piggyback background tasks on any request
	runAttendeeCheckIfDue().catch(() => {});
	runMotivationalIfDue().catch(() => {});

	return resolve(event);
};
