import type { RequestHandler } from './$types';
import { getActiveTournament } from '$lib/server/store';
import { gql, EVENT_PHASES_QUERY } from '$lib/server/startgg';
import { restartPhase, addEntrantsToPhase, getTournamentParticipants, updateParticipantEvents } from '$lib/server/startgg-admin';

/**
 * POST — Full StartGG reset: restart all phases (Swiss + bracket),
 * remove entrants from later rounds and bracket events,
 * leaving everyone only in Swiss Round 1.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const logs: string[] = [];
	const log = (msg: string) => { logs.push(msg); console.log(`[reset-startgg] ${msg}`); };

	const swissEventId = tournament.startggEventId;
	const mainEventId = tournament.startggMainBracketEventId;
	const redEventId = tournament.startggRedemptionBracketEventId;
	const eventSlug = tournament.startggEventSlug;

	if (!swissEventId || !eventSlug) {
		return Response.json({ error: 'No StartGG event linked' }, { status: 400 });
	}

	// Step 1: Restart ALL phases across ALL events (Swiss + Main + Redemption)
	log('Step 1: Restarting all phases...');
	const allEventIds = [swissEventId, mainEventId, redEventId].filter((id): id is number => !!id);
	for (const eventId of allEventIds) {
		const phaseData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
			EVENT_PHASES_QUERY, { eventId }
		);
		const phases = phaseData?.event?.phases ?? [];
		for (const phase of phases) {
			log(`  Restarting ${phase.name} (${phase.id})...`);
			const result = await restartPhase(phase.id).catch((e) => ({ ok: false, error: String(e) }));
			log(`  ${result.ok ? '✓' : '✗ ' + result.error}`);
		}
	}

	// Step 2: Clear entrants from Swiss phases except Round 1
	log('Step 2: Clearing entrants from later Swiss phases...');
	const swissPhaseData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
		EVENT_PHASES_QUERY, { eventId: swissEventId }
	);
	const swissPhases = swissPhaseData?.event?.phases ?? [];
	const r1Phase = swissPhases.find((p) => p.name.includes('Round 1'));
	for (const phase of swissPhases) {
		if (phase.id === r1Phase?.id) continue;
		log(`  Clearing ${phase.name}...`);
		const result = await addEntrantsToPhase(swissEventId, phase.id, []).catch((e) => ({ ok: false, error: String(e) }));
		log(`  ${result.ok ? '✓' : '✗ ' + (result as { error?: string }).error}`);
	}

	// Step 3: Remove all participants from bracket events (keep only Swiss)
	const tournamentSlug = eventSlug.match(/tournament\/([^/]+)/)?.[1];
	if (tournamentSlug && (mainEventId || redEventId)) {
		log('Step 3: Removing participants from bracket events...');
		const participants = await getTournamentParticipants(tournamentSlug);
		let cleaned = 0;
		let failed = 0;
		for (const p of participants) {
			const inMain = mainEventId ? p.currentEventIds.includes(mainEventId) : false;
			const inRed = redEventId ? p.currentEventIds.includes(redEventId) : false;
			if (!inMain && !inRed) continue;
			const result = await updateParticipantEvents(p.participantId, [swissEventId], []);
			if (result.ok) {
				cleaned++;
			} else {
				failed++;
				log(`  ✗ ${p.gamerTag}: ${result.error}`);
			}
		}
		log(`  Removed ${cleaned} from brackets${failed > 0 ? `, ${failed} failed` : ''}`);
	}

	log('Done! StartGG is reset to Swiss Round 1.');
	return Response.json({ ok: true, logs });
};
