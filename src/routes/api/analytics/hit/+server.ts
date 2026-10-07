import type { RequestHandler } from './$types';
import { isTrackedEvent, isTrackedPage, recordHit } from '$lib/server/analytics';

const VISITOR_ID = /^[A-Za-z0-9-]{8,64}$/;
// StartGG player ids are numeric; anything else can't be a real player page
const PLAYER_ID = /^\d{1,12}$/;

// Public beacon from the league pages and ranker. Always answers 204 so a bad or failed hit never
// surfaces to visitors; logged-in TOs aren't counted so our own checking doesn't inflate the numbers.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (locals.user) return new Response(null, { status: 204 });
	try {
		const body = (await request.json()) as { page?: unknown; event?: unknown; vid?: unknown; playerId?: unknown };
		const vid = typeof body.vid === 'string' && VISITOR_ID.test(body.vid) ? body.vid : null;
		const playerId = typeof body.playerId === 'string' && PLAYER_ID.test(body.playerId) ? body.playerId : undefined;
		if (isTrackedPage(body.page) && isTrackedEvent(body.event) && vid) {
			await recordHit(body.page, body.event, vid, body.page === 'league-player' ? playerId : undefined);
		}
	} catch (err) {
		console.error('analytics hit failed', err);
	}
	return new Response(null, { status: 204 });
};
