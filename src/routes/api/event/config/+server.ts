/**
 * GET/POST /api/event/config
 *
 * Manage the automated event creation configuration.
 * Session auth required.
 */

import type { RequestHandler } from './$types';
import { getEventConfig, saveEventConfig } from '$lib/server/store';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const config = await getEventConfig();
	return Response.json(config);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { nextEventNumber, srcTournamentId, shortSlug, discordLink, paused } = body as {
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

	const updated = await saveEventConfig(updates);
	return Response.json(updated);
};
