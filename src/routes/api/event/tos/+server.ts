/**
 * GET/POST/DELETE /api/event/tos
 *
 * Manage the tournament organizer pool for automated event creation.
 * Session auth required.
 *
 * GET    — returns the full TO list
 * POST   — add or update a TO (by discriminator)
 * DELETE — remove a TO (by discriminator)
 */

import type { RequestHandler } from './$types';
import { getEventConfig, saveEventConfig } from '$lib/server/store';
import type { TOConfig } from '$lib/server/store';
import { getUserByDiscriminator } from '$lib/server/startgg';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const config = await getEventConfig();
	return Response.json({ tos: config.tos });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { name, discriminator, prefix, autoRegister } = body as {
		name: string;
		discriminator: string;
		prefix?: string;
		autoRegister?: boolean;
	};

	if (!discriminator) {
		return Response.json({ error: 'discriminator is required' }, { status: 400 });
	}

	// Look up player ID from start.gg
	let playerId: number | undefined;
	let resolvedName = name;
	let resolvedPrefix = prefix ?? '';
	try {
		const user = await getUserByDiscriminator(discriminator);
		if (user) {
			playerId = user.playerId;
			if (!resolvedName) resolvedName = user.gamerTag;
			if (!resolvedPrefix) resolvedPrefix = user.prefix;
		}
	} catch {
		// Best effort — player ID can be resolved later
	}

	if (!resolvedName) {
		return Response.json({ error: 'name is required (could not resolve from discriminator)' }, { status: 400 });
	}

	const config = await getEventConfig();
	const existing = config.tos.findIndex((t) => t.discriminator === discriminator);

	const to: TOConfig = {
		name: resolvedName,
		discriminator,
		playerId,
		prefix: resolvedPrefix,
		autoRegister: autoRegister ?? false
	};

	const tos = [...config.tos];
	if (existing >= 0) {
		tos[existing] = to;
	} else {
		tos.push(to);
	}

	await saveEventConfig({ tos });
	return Response.json({ ok: true, to, tos });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { discriminator } = body as { discriminator: string };

	if (!discriminator) {
		return Response.json({ error: 'discriminator is required' }, { status: 400 });
	}

	const config = await getEventConfig();
	const tos = config.tos.filter((t) => t.discriminator !== discriminator);

	if (tos.length === config.tos.length) {
		return Response.json({ error: 'TO not found' }, { status: 404 });
	}

	await saveEventConfig({ tos });
	return Response.json({ ok: true, tos });
};
