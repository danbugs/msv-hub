/**
 * POST /api/event/swap-to
 *
 * Swap a registered TO on the current event. Unregisters one TO and
 * registers another. Requires an active tournament with a known tournament ID.
 * Session auth required.
 *
 * Body: { removeDiscriminator: string, addDiscriminator: string }
 */

import type { RequestHandler } from './$types';
import { getEventConfig } from '$lib/server/store';
import {
	getTournamentParticipants,
	unregisterParticipant,
	registerTOForTournament,
	getTournamentRegistrationInfo
} from '$lib/server/startgg-admin';
import { getUserByDiscriminator } from '$lib/server/startgg';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { removeDiscriminator, addDiscriminator } = body as {
		removeDiscriminator: string;
		addDiscriminator: string;
	};

	if (!removeDiscriminator || !addDiscriminator) {
		return Response.json({ error: 'removeDiscriminator and addDiscriminator are required' }, { status: 400 });
	}

	const config = await getEventConfig();
	if (!config.lastCreatedTournamentId || !config.lastCreatedTournamentSlug) {
		return Response.json({ error: 'No active tournament — create an event first' }, { status: 400 });
	}

	const tournamentId = config.lastCreatedTournamentId;
	const tournamentSlug = config.lastCreatedTournamentSlug;
	const results: string[] = [];

	// Find the TO to remove
	const removeTO = config.tos.find((t) => t.discriminator === removeDiscriminator);
	if (!removeTO) {
		return Response.json({ error: `TO with discriminator ${removeDiscriminator} not found in pool` }, { status: 404 });
	}

	// Find the TO to add
	const addTO = config.tos.find((t) => t.discriminator === addDiscriminator);
	if (!addTO) {
		return Response.json({ error: `TO with discriminator ${addDiscriminator} not found in pool — add them first` }, { status: 404 });
	}

	// Look up the player to remove in the tournament participants
	let removePlayerId = removeTO.playerId;
	if (!removePlayerId) {
		const user = await getUserByDiscriminator(removeDiscriminator);
		if (user) removePlayerId = user.playerId;
	}

	if (removePlayerId) {
		// Find their participant ID in the tournament
		const participants = await getTournamentParticipants(tournamentSlug);
		const participant = participants.find(
			(p) => p.gamerTag.toLowerCase() === removeTO.name.toLowerCase()
		);

		if (participant) {
			const result = await unregisterParticipant(tournamentId, participant.participantId);
			results.push(result.ok
				? `Removed ${removeTO.name}`
				: `Failed to remove ${removeTO.name}: ${result.error}`);
		} else {
			results.push(`${removeTO.name} not found in tournament participants`);
		}
	} else {
		results.push(`Could not resolve player ID for ${removeTO.name}`);
	}

	// Register the new TO
	const regInfo = await getTournamentRegistrationInfo(tournamentSlug);
	if (regInfo) {
		const result = await registerTOForTournament(tournamentId, addTO, regInfo);
		results.push(result.ok
			? `Added ${addTO.name}`
			: `Failed to add ${addTO.name}: ${result.error}`);
	} else {
		results.push('Could not discover registration info — manual registration needed');
	}

	return Response.json({ ok: true, results });
};
