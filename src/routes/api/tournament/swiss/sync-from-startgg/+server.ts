/**
 * POST /api/tournament/swiss/sync-from-startgg
 *
 * Sync Swiss round results FROM StartGG. For each round's phase group,
 * fetches reported sets and applies them to MSV Hub's match state.
 * Useful when matches were reported directly on StartGG or state drifted.
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { fetchAllSets } from '$lib/server/startgg';

type GqlRecord = Record<string, unknown>;

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.startggEventId) return Response.json({ error: 'No StartGG event linked' }, { status: 400 });
	if (tournament.phase !== 'swiss') return Response.json({ error: 'Tournament is not in Swiss phase' }, { status: 400 });

	// Map StartGG entrant ID → MSV Hub entrant ID
	const startggToMsvHub = new Map<number, string>();
	for (const e of tournament.entrants) {
		if (e.startggEntrantId) startggToMsvHub.set(e.startggEntrantId, e.id);
	}

	// Map phase group ID → round number
	const pgIdToRound = new Map<number, number>();
	for (let i = 0; i < (tournament.startggPhase1Groups?.length ?? 0); i++) {
		const pg = tournament.startggPhase1Groups![i];
		if (pg?.id) pgIdToRound.set(pg.id, i + 1);
	}

	// Fetch all sets in the event
	const sets = await fetchAllSets(tournament.startggEventId, undefined, 0);

	let synced = 0;
	let skipped = 0;
	const perRound: Record<number, number> = {};

	for (const set of sets as GqlRecord[]) {
		const winnerId = set.winnerId as number | null | undefined;
		if (!winnerId) { skipped++; continue; }

		const pg = set.phaseGroup as { id?: number } | undefined;
		const pgId = pg?.id;
		if (!pgId) { skipped++; continue; }

		const roundNum = pgIdToRound.get(Number(pgId));
		if (!roundNum) { skipped++; continue; } // Not a Swiss round phase group

		const slots = (set.slots ?? []) as GqlRecord[];
		const sgE1 = Number((slots[0]?.entrant as { id?: number } | undefined)?.id);
		const sgE2 = Number((slots[1]?.entrant as { id?: number } | undefined)?.id);
		if (!sgE1 || !sgE2) { skipped++; continue; }

		const msvE1 = startggToMsvHub.get(sgE1);
		const msvE2 = startggToMsvHub.get(sgE2);
		const msvWinner = startggToMsvHub.get(Number(winnerId));
		if (!msvE1 || !msvE2 || !msvWinner) { skipped++; continue; }

		const round = tournament.rounds.find((r) => r.number === roundNum);
		if (!round) { skipped++; continue; }

		const match = round.matches.find((m) =>
			(m.topPlayerId === msvE1 && m.bottomPlayerId === msvE2) ||
			(m.topPlayerId === msvE2 && m.bottomPlayerId === msvE1)
		);
		if (!match) { skipped++; continue; }

		// Extract scores from displayScore (e.g. "PlayerA 2 - PlayerB 1")
		let topScore = 0;
		let bottomScore = 0;
		const ds = set.displayScore as string | undefined;
		if (ds) {
			const parts = ds.split(' - ');
			if (parts.length === 2) {
				const s1 = Number(parts[0].replace(/[^0-9]/g, ''));
				const s2 = Number(parts[1].replace(/[^0-9]/g, ''));
				if (!isNaN(s1) && !isNaN(s2)) {
					if (msvE1 === match.topPlayerId) { topScore = s1; bottomScore = s2; }
					else { topScore = s2; bottomScore = s1; }
				}
			}
		}
		// If scores weren't parseable, infer from winner
		if (topScore === 0 && bottomScore === 0) {
			if (msvWinner === match.topPlayerId) topScore = 2;
			else bottomScore = 2;
		}

		match.winnerId = msvWinner;
		match.topScore = topScore;
		match.bottomScore = bottomScore;
		match.isDQ = false;
		match.startggSetId = String(set.id);
		synced++;
		perRound[roundNum] = (perRound[roundNum] ?? 0) + 1;
	}

	// Clear errors for matches that are now reported correctly
	if (tournament.startggSync?.errors) {
		const reportedIds = new Set<string>();
		for (const r of tournament.rounds) {
			for (const m of r.matches) {
				if (m.winnerId) reportedIds.add(m.id);
			}
		}
		tournament.startggSync.errors = tournament.startggSync.errors.filter(
			(e) => !reportedIds.has(e.matchId)
		);
	}

	await saveTournament(tournament);

	return Response.json({
		ok: true,
		synced,
		skipped,
		perRound,
		totalSetsOnStartGG: (sets as GqlRecord[]).length
	});
};
