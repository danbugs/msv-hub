import type { RequestHandler } from './$types';
import {
	gql,
	EVENT_BY_SLUG_QUERY,
	EVENT_PHASES_QUERY,
	TOURNAMENT_QUERY,
	fetchPhaseSeedsWithTags
} from '$lib/server/startgg';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { eventSlug, mode } = body as { eventSlug: string; mode?: string };

	if (!eventSlug) {
		return Response.json({ error: 'eventSlug is required' }, { status: 400 });
	}

	const slug = eventSlug
		.replace(/^https?:\/\/[^/]+\//i, '')
		.replace(/\/(details|brackets|standings|sets|attendees)\b.*$/i, '')
		.replace(/^\/+|\/+$/g, '');

	let eventId: number;

	if (slug.includes('/event/')) {
		const eventData = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug });
		if (!eventData?.event) {
			return Response.json({ error: `Event not found: ${slug}` }, { status: 404 });
		}
		eventId = eventData.event.id;
	} else {
		const tournSlug = slug.match(/tournament\/([^/]+)/)?.[1] ?? slug.replace(/^tournament\//, '');
		const tData = await gql<{ tournament: { events: { id: number; name: string; slug: string; numEntrants: number }[] } }>(
			TOURNAMENT_QUERY, { slug: tournSlug }
		);
		const events = tData?.tournament?.events ?? [];
		if (!events.length) {
			return Response.json({ error: `No events found for tournament: ${tournSlug}` }, { status: 404 });
		}

		let target: { id: number; name: string; slug: string } | undefined;
		if (mode === 'gauntlet') {
			target = events.find((e) => /main/i.test(e.name));
		} else {
			target = events.find((e) => /swiss/i.test(e.name));
		}
		if (!target) {
			target = events.find((e) => (e.numEntrants ?? 0) > 0) ?? events[0];
		}
		eventId = target.id;
	}

	const phaseData = await gql<{ event: { phases: { id: number }[] } }>(
		EVENT_PHASES_QUERY, { eventId }
	);
	const phaseId = phaseData?.event?.phases?.[0]?.id;
	if (!phaseId) {
		return Response.json({ error: 'No phases found' }, { status: 404 });
	}

	let seeds = await fetchPhaseSeedsWithTags(phaseId);

	if (!seeds.length) {
		const tournSlug = slug.match(/tournament\/([^/]+)/)?.[1];
		if (tournSlug) {
			const tData = await gql<{ tournament: { events: { id: number }[] } }>(
				TOURNAMENT_QUERY, { slug: tournSlug }
			);
			const otherEvents = (tData?.tournament?.events ?? []).filter((e) => e.id !== eventId);
			for (const evt of otherEvents) {
				const evtPhases = await gql<{ event: { phases: { id: number }[] } }>(
					EVENT_PHASES_QUERY, { eventId: evt.id }
				);
				const fallbackPhaseId = evtPhases?.event?.phases?.[0]?.id;
				if (!fallbackPhaseId) continue;
				const fallbackSeeds = await fetchPhaseSeedsWithTags(fallbackPhaseId);
				if (fallbackSeeds.length) {
					seeds = fallbackSeeds;
					break;
				}
			}
		}
	}

	if (!seeds.length) {
		return Response.json({ error: 'No seeds found' }, { status: 404 });
	}

	const entrants = seeds.map((s) => ({
		seedNum: s.seedNum,
		gamerTag: s.gamerTag,
		elo: 0,
		jitteredElo: 0,
		isNewcomer: false
	}));

	return Response.json({ entrants });
};
