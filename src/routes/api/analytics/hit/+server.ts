import type { RequestHandler } from './$types';
import { isTrackedEvent, isTrackedPage, recordHit } from '$lib/server/analytics';

const VISITOR_ID = /^[A-Za-z0-9-]{8,64}$/;

// Public beacon from the league pages and ranker. Always answers 204 so a bad or failed hit never
// surfaces to visitors; logged-in TOs aren't counted so our own checking doesn't inflate the numbers.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (locals.user) return new Response(null, { status: 204 });
	try {
		const body = (await request.json()) as { page?: unknown; event?: unknown; vid?: unknown };
		const vid = typeof body.vid === 'string' && VISITOR_ID.test(body.vid) ? body.vid : null;
		if (isTrackedPage(body.page) && isTrackedEvent(body.event) && vid) {
			await recordHit(body.page, body.event, vid);
		}
	} catch (err) {
		console.error('analytics hit failed', err);
	}
	return new Response(null, { status: 204 });
};
