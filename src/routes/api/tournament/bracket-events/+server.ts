import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { gql, EVENT_BY_SLUG_QUERY } from '$lib/server/startgg';

/** PUT — link StartGG bracket events (main/redemption) */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const { mainEventSlug, redemptionEventSlug } = await request.json() as {
		mainEventSlug?: string;
		redemptionEventSlug?: string;
	};

	const normalize = (s: string) => s.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+|\/+$/g, '');

	if (mainEventSlug) {
		const slug = normalize(mainEventSlug);
		const data = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug });
		if (!data?.event) return Response.json({ error: `Main event not found: ${slug}` }, { status: 404 });
		tournament.startggMainBracketEventId = data.event.id;
	}

	if (redemptionEventSlug) {
		const slug = normalize(redemptionEventSlug);
		const data = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug });
		if (!data?.event) return Response.json({ error: `Redemption event not found: ${slug}` }, { status: 404 });
		tournament.startggRedemptionBracketEventId = data.event.id;
	}

	await saveTournament(tournament);
	return Response.json({ ok: true, mainEventId: tournament.startggMainBracketEventId, redemptionEventId: tournament.startggRedemptionBracketEventId });
};
