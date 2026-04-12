/**
 * POST /api/tournament/swiss/sync-from-startgg
 *
 * Sync Swiss round results FROM StartGG. For each round's phase group,
 * fetches reported sets and applies them to MSV Hub's match state.
 */

import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { gql } from '$lib/server/startgg';

type GqlRecord = Record<string, unknown>;

// Custom query that includes displayScore (PHASE_GROUP_SETS_QUERY doesn't).
const PG_SETS_WITH_SCORES = `
query PgSets($phaseGroupId: ID!) {
  phaseGroup(id: $phaseGroupId) {
    sets(page: 1, perPage: 64, sortType: STANDARD) {
      nodes {
        id
        winnerId
        displayScore
        slots { entrant { id } }
      }
    }
  }
}`;

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (tournament.phase !== 'swiss') return Response.json({ error: 'Tournament is not in Swiss phase' }, { status: 400 });
	if (!tournament.startggPhase1Groups?.length) return Response.json({ error: 'No Swiss phase groups linked' }, { status: 400 });

	// StartGG entrant ID → MSV Hub entrant ID
	const startggToMsvHub = new Map<number, string>();
	for (const e of tournament.entrants) {
		if (e.startggEntrantId) startggToMsvHub.set(e.startggEntrantId, e.id);
	}

	let synced = 0;
	let skipped = 0;
	const perRound: Record<number, number> = {};
	const debug: string[] = [];
	debug.push(`Phase groups: ${tournament.startggPhase1Groups.length}`);
	debug.push(`Rounds: ${tournament.rounds.length}`);

	for (let i = 0; i < tournament.startggPhase1Groups.length; i++) {
		const pg = tournament.startggPhase1Groups[i];
		const roundNum = i + 1;
		if (!pg?.id) { debug.push(`R${roundNum}: no pg.id`); continue; }

		const round = tournament.rounds.find((r) => r.number === roundNum);
		if (!round) { debug.push(`R${roundNum} (pg ${pg.id}): no round found`); continue; }

		const data = await gql<{ phaseGroup: { sets: { nodes: GqlRecord[] } } }>(
			PG_SETS_WITH_SCORES,
			{ phaseGroupId: pg.id },
			{ delay: 0 }
		).catch((e) => { debug.push(`R${roundNum} GQL error: ${String(e).slice(0, 100)}`); return null; });

		const sets = data?.phaseGroup?.sets?.nodes ?? [];
		debug.push(`R${roundNum} pg ${pg.id}: ${sets.length} sets from StartGG, ${round.matches.length} MSV matches`);
		const withWinners = sets.filter((s) => s.winnerId).length;
		debug.push(`  ${withWinners} sets have winnerId on StartGG`);

		for (const set of sets) {
			const slots = (set.slots ?? []) as GqlRecord[];
			const sgE1 = Number((slots[0]?.entrant as { id?: number } | undefined)?.id);
			const sgE2 = Number((slots[1]?.entrant as { id?: number } | undefined)?.id);
			if (!sgE1 || !sgE2) { skipped++; continue; }

			const msvE1 = startggToMsvHub.get(sgE1);
			const msvE2 = startggToMsvHub.get(sgE2);
			if (!msvE1 || !msvE2) { skipped++; continue; }

			const match = round.matches.find((m) =>
				(m.topPlayerId === msvE1 && m.bottomPlayerId === msvE2) ||
				(m.topPlayerId === msvE2 && m.bottomPlayerId === msvE1)
			);
			if (!match) { skipped++; continue; }

			const winnerId = set.winnerId as number | null | undefined;

			// Sync from StartGG = make MSV Hub match StartGG exactly.
			// If StartGG has no winner but MSV does, clear MSV (user intentionally
			// called sync — they want StartGG to be the source of truth).
			if (!winnerId) {
				if (match.winnerId) {
					match.winnerId = undefined;
					match.topScore = undefined;
					match.bottomScore = undefined;
					match.isDQ = false;
					synced++;
					perRound[roundNum] = (perRound[roundNum] ?? 0) + 1;
				} else {
					skipped++;
				}
				continue;
			}

			const msvWinner = startggToMsvHub.get(Number(winnerId));
			if (!msvWinner) { skipped++; continue; }

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
			// Fallback: infer from winner
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
	}

	// Clear errors for matches that are now reported
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

	return Response.json({ ok: true, synced, skipped, perRound, debug });
};
