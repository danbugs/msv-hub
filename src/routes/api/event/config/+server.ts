/**
 * GET/POST /api/event/config
 *
 * Manage the automated event creation configuration.
 * Session auth required.
 */

import type { RequestHandler } from './$types';
import { getEventConfig, saveEventConfig, type EventVenue } from '$lib/server/store';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const config = await getEventConfig();
	return Response.json(config);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { nextEventNumber, srcTournamentId, shortSlug, discordLink, paused, venue, details, gettingThere } = body as {
		venue?: EventVenue;
		details?: string;
		gettingThere?: string;
		nextEventNumber?: number;
		srcTournamentId?: number;
		shortSlug?: string;
		discordLink?: string;
		paused?: boolean;
	};

	const updates: Record<string, unknown> = {};
	if (nextEventNumber !== undefined) updates.nextEventNumber = nextEventNumber;
	if (srcTournamentId !== undefined) updates.srcTournamentId = srcTournamentId;
	if (shortSlug !== undefined) updates.shortSlug = shortSlug;
	if (discordLink !== undefined) updates.discordLink = discordLink;
	if (paused !== undefined) updates.paused = paused;
	if (details !== undefined) updates.details = details;
	if (gettingThere !== undefined) updates.gettingThere = gettingThere;
	if (venue !== undefined) {
		const lat = Number(venue.lat), lng = Number(venue.lng);
		if (!venue.name?.trim() || !venue.fullAddress?.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
			return Response.json({ error: 'Venue needs a name, an address, and numeric latitude and longitude' }, { status: 400 });
		}
		// A place ID belongs to one address; drop it rather than keep a stale one.
		const { placeId: _stale, ...rest } = venue;
		updates.venue = { ...rest, lat, lng };
	}

	const updated = await saveEventConfig(updates);
	return Response.json(updated);
};
