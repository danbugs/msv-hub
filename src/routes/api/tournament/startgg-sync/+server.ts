/**
 * POST /api/tournament/startgg-sync
 *
 * "Split Done" — automatically assigns players to main/redemption bracket events
 * on StartGG, pushes seeding, triggers conversion, and flushes queued reports.
 *
 * DELETE /api/tournament/startgg-sync
 *
 * Clears stored StartGG errors from the tournament state.
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { flushPendingBracketMatches } from '$lib/server/startgg-reporter';
import { pushBracketSeeding, gql, EVENT_PHASES_QUERY, fetchPhaseGroups } from '$lib/server/startgg';
import { assignBracketSplit } from '$lib/server/startgg-admin';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (tournament.phase !== 'brackets' && tournament.phase !== 'completed') {
		return Response.json({ error: 'Tournament is not in brackets phase' }, { status: 400 });
	}
	if (!tournament.finalStandings || !tournament.brackets) {
		return Response.json({ error: 'No final standings or brackets' }, { status: 400 });
	}

	const logs: string[] = [];
	const log = (msg: string) => { logs.push(msg); console.log(`[split-done] ${msg}`); };

	// Step 1: Auto-assign players to bracket events on StartGG
	const swissEventId = tournament.startggEventId;
	const mainEventId = tournament.startggMainBracketEventId;
	const redEventId = tournament.startggRedemptionBracketEventId;
	const eventSlug = tournament.startggEventSlug;

	let splitResult = { mainOk: 0, redemptionOk: 0, failed: 0, errors: [] as string[] };

	if (swissEventId && mainEventId && redEventId && eventSlug) {
		const tournamentSlug = eventSlug.match(/tournament\/([^/]+)/)?.[1];
		if (tournamentSlug) {
			const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
			const mainTags = tournament.finalStandings
				.filter((s) => s.bracket === 'main')
				.map((s) => entrantMap.get(s.entrantId)?.gamerTag ?? '')
				.filter(Boolean);
			const redTags = tournament.finalStandings
				.filter((s) => s.bracket === 'redemption')
				.map((s) => entrantMap.get(s.entrantId)?.gamerTag ?? '')
				.filter(Boolean);

			log(`Assigning ${mainTags.length} players to Main, ${redTags.length} to Redemption...`);
			splitResult = await assignBracketSplit(
				tournamentSlug, swissEventId, mainEventId, redEventId, mainTags, redTags, log
			);
		}
	} else {
		log('Skipping auto-assign: missing event IDs');
	}

	// Step 2: Push bracket seeding + trigger conversion
	const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
	const bracketEntrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
	for (const [bName, bEventId] of [
		['main', mainEventId] as const,
		['redemption', redEventId] as const
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
					log(`Pushed ${bName} bracket seeding`);
					// No dummy report needed — preview IDs work for first bracket report.
					// Real IDs are cached via admin REST after the first report.
				} else {
					log(`${bName} bracket seeding failed: ${result.error}`);
				}
			}
		} catch (e) {
			log(`${bName} bracket error: ${e}`);
		}
	}

	// Step 3: Flush pending bracket reports
	const { reported, failed } = await flushPendingBracketMatches(tournament);

	return Response.json({
		ok: true,
		splitConfirmed: true,
		split: splitResult,
		reported,
		failed,
		logs,
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
