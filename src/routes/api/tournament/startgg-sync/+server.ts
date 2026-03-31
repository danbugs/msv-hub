/**
 * POST /api/tournament/startgg-sync
 *
 * Confirms that the main/redemption bracket split has been corrected in StartGG,
 * then flushes all queued bracket match reports.
 *
 * DELETE /api/tournament/startgg-sync
 *
 * Clears stored StartGG errors from the tournament state.
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { flushPendingBracketMatches } from '$lib/server/startgg-reporter';
import { pushBracketSeeding, reportSet, resetSet, gql, EVENT_PHASES_QUERY, PHASE_GROUP_SETS_QUERY, fetchPhaseGroups } from '$lib/server/startgg';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (tournament.phase !== 'brackets' && tournament.phase !== 'completed') {
		return Response.json({ error: 'Tournament is not in brackets phase' }, { status: 400 });
	}

	// Push bracket seeding + trigger conversion now that TO has assigned players on StartGG
	const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
	const bracketEntrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
	for (const [bName, bEventId] of [
		['main', tournament.startggMainBracketEventId] as const,
		['redemption', tournament.startggRedemptionBracketEventId] as const
	]) {
		if (!bEventId || !tournament.brackets || !swissPgId) continue;
		const bracket = tournament.brackets[bName];
		if (!bracket) continue;
		try {
			const epData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
				EVENT_PHASES_QUERY, { eventId: bEventId }
			);
			const bracketPhase = epData?.event?.phases?.[0];
			if (!bracketPhase) continue;
			const bGroups = await fetchPhaseGroups(bracketPhase.id).catch(() => []);
			if (!bGroups.length) continue;
			const bPgId = bGroups[0].id;

			const rankedSwissEntrantIds = bracket.players
				.sort((a, b) => a.seed - b.seed)
				.map((p) => bracketEntrantMap.get(p.entrantId)?.startggEntrantId)
				.filter((id): id is number => id !== undefined);
			if (rankedSwissEntrantIds.length) {
				const result = await pushBracketSeeding(bracketPhase.id, bPgId, rankedSwissEntrantIds, swissPgId)
					.catch((e) => ({ ok: false as const, error: String(e) }));
				if (result.ok) {
					console.log(`[StartGG] Split Done: pushed ${bName} bracket seeding`);
					// Trigger preview→real conversion
					type PGData = { phaseGroup: { sets: { nodes: { id: unknown; slots: { entrant: { id: unknown } | null }[] }[] } } };
					const setsData = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: bPgId }, { delay: 0 }).catch(() => null);
					const bSets = setsData?.phaseGroup?.sets?.nodes ?? [];
					const previewSet = bSets.find((s) =>
						String(s.id).startsWith('preview_') && s.slots?.length >= 2 && s.slots[0]?.entrant?.id && s.slots[1]?.entrant?.id
					);
					if (previewSet) {
						const dummyWinner = Number(previewSet.slots[0].entrant!.id);
						const rep = await reportSet(String(previewSet.id), dummyWinner, {}).catch(() => ({ ok: false as const }));
						if (rep.ok) {
							const realId = rep.reportedSetId ?? String(previewSet.id);
							await resetSet(realId).catch(() => {});
						}
					}
				} else {
					console.error(`[StartGG] Split Done: ${bName} seeding failed: ${result.error}`);
				}
			}
		} catch (e) {
			console.error(`[StartGG] Split Done: ${bName} error: ${e}`);
		}
	}

	const { reported, failed } = await flushPendingBracketMatches(tournament);

	return Response.json({
		ok: true,
		splitConfirmed: true,
		reported,
		failed,
		errors: tournament.startggSync?.errors ?? []
	});
};

export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	if (tournament.startggSync) {
		tournament.startggSync.errors = [];
	}
	await saveTournament(tournament);
	return Response.json({ ok: true });
};
