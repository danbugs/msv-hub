import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { gql, EVENT_BY_SLUG_QUERY, TOURNAMENT_QUERY, fetchPhaseSeeds, fetchPhaseGroups, pushFinalStandingsSeeding } from '$lib/server/startgg';

/** GET — auto-discover bracket events from the same StartGG tournament */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const eventSlug = tournament.startggEventSlug;
	if (!eventSlug) return Response.json({ error: 'No StartGG event slug' }, { status: 400 });

	// Extract tournament slug: "tournament/micro-132/event/ultimate-singles" -> "micro-132"
	const match = eventSlug.match(/tournament\/([^/]+)/);
	if (!match) return Response.json({ error: 'Cannot parse tournament slug' }, { status: 400 });
	const tournamentSlug = match[1];

	const data = await gql<{ tournament: { id: number; name: string; events: { id: number; name: string; numEntrants: number }[] } }>(
		TOURNAMENT_QUERY, { slug: tournamentSlug }
	);
	if (!data?.tournament) return Response.json({ error: 'Tournament not found' }, { status: 404 });

	// Find events that are NOT the Swiss event
	const swissEventId = tournament.startggEventId;
	const otherEvents = (data.tournament.events ?? []).filter((e) => e.id !== swissEventId);

	// Auto-detect main and redemption by name
	let mainCandidate = otherEvents.find((e) => /main/i.test(e.name));
	let redemptionCandidate = otherEvents.find((e) => /redemption/i.test(e.name));

	// Fallback: if exactly 2 non-Swiss events, larger = main
	if (!mainCandidate && !redemptionCandidate && otherEvents.length === 2) {
		const sorted = [...otherEvents].sort((a, b) => b.numEntrants - a.numEntrants);
		mainCandidate = sorted[0];
		redemptionCandidate = sorted[1];
	}

	return Response.json({
		tournamentName: data.tournament.name,
		events: otherEvents,
		suggested: {
			main: mainCandidate ?? null,
			redemption: redemptionCandidate ?? null
		},
		currentLinks: {
			main: tournament.startggMainBracketEventId,
			redemption: tournament.startggRedemptionBracketEventId
		}
	});
};

/** PUT — link StartGG bracket events (main/redemption) and push seeding */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const { mainEventSlug, redemptionEventSlug, mainEventId, redemptionEventId } = await request.json() as {
		mainEventSlug?: string;
		redemptionEventSlug?: string;
		mainEventId?: number;
		redemptionEventId?: number;
	};

	const normalize = (s: string) => s.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+|\/+$/g, '');

	// Accept either direct IDs (from auto-discovery) or slugs (from manual input)
	if (mainEventId) {
		tournament.startggMainBracketEventId = mainEventId;
	} else if (mainEventSlug) {
		const slug = normalize(mainEventSlug);
		const data = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug });
		if (!data?.event) return Response.json({ error: `Main event not found: ${slug}` }, { status: 404 });
		tournament.startggMainBracketEventId = data.event.id;
	}

	if (redemptionEventId) {
		tournament.startggRedemptionBracketEventId = redemptionEventId;
	} else if (redemptionEventSlug) {
		const slug = normalize(redemptionEventSlug);
		const data = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug });
		if (!data?.event) return Response.json({ error: `Redemption event not found: ${slug}` }, { status: 404 });
		tournament.startggRedemptionBracketEventId = data.event.id;
	}

	await saveTournament(tournament);
	return Response.json({
		ok: true,
		mainEventId: tournament.startggMainBracketEventId,
		redemptionEventId: tournament.startggRedemptionBracketEventId
	});
};
