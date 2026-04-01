import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { fetchAllSets, fetchAllEntrants, gql, PHASE_GROUP_SEEDS_QUERY } from '$lib/server/startgg';
import { generateBracket, reportBracketMatch } from '$lib/server/swiss';
import type { BracketMatch } from '$lib/types/tournament';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GqlRecord = Record<string, any>;

/**
 * POST — Sync bracket state FROM StartGG.
 * Regenerates a fresh bracket, then applies all reported results from StartGG.
 * This brings MSV Hub in line with whatever state StartGG is in.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.finalStandings) return Response.json({ error: 'No final standings' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const bracketName = (body as { bracketName?: string }).bracketName as 'main' | 'redemption' | undefined;
	if (!bracketName) return Response.json({ error: 'bracketName required' }, { status: 400 });

	const eventId = bracketName === 'main'
		? tournament.startggMainBracketEventId
		: tournament.startggRedemptionBracketEventId;
	if (!eventId) return Response.json({ error: `No ${bracketName} bracket event linked` }, { status: 400 });

	const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
	if (!swissPgId) return Response.json({ error: 'No Swiss phase group' }, { status: 400 });

	// Step 1: Build player ID translation (bracket entrant ID → MSV Hub entrant ID)
	// Swiss seeds: Swiss entrant ID → player ID
	const swissSeedsData = await gql<{ phaseGroup: { seeds: { nodes: GqlRecord[] } } }>(
		PHASE_GROUP_SEEDS_QUERY, { phaseGroupId: swissPgId, page: 1, perPage: 64 }, { delay: 0 }
	).catch(() => null);
	const swissSeeds = swissSeedsData?.phaseGroup?.seeds?.nodes ?? [];
	const swissEntrantToPlayer = new Map<number, number>();
	for (const s of swissSeeds) {
		const eid = s.entrant?.id;
		const pid = s.entrant?.participants?.[0]?.player?.id;
		if (eid && pid) swissEntrantToPlayer.set(Number(eid), Number(pid));
	}

	// MSV Hub entrant: Swiss entrant ID → MSV Hub ID
	const swissToMsvHub = new Map<number, string>();
	for (const e of tournament.entrants) {
		if (e.startggEntrantId) swissToMsvHub.set(e.startggEntrantId, e.id);
	}

	// Player ID → MSV Hub ID (via Swiss entrant)
	const playerToMsvHub = new Map<number, string>();
	for (const [swissEid, playerId] of swissEntrantToPlayer) {
		const msvId = swissToMsvHub.get(swissEid);
		if (msvId) playerToMsvHub.set(playerId, msvId);
	}

	// Bracket entrants: bracket entrant ID → player ID
	const bracketEntrants = await fetchAllEntrants(eventId, undefined).catch(() => []);
	const bracketEntrantToMsvHub = new Map<number, string>();
	for (const e of bracketEntrants as GqlRecord[]) {
		const eid = e.id;
		const pid = e.participants?.[0]?.player?.id;
		if (eid && pid) {
			const msvId = playerToMsvHub.get(Number(pid));
			if (msvId) bracketEntrantToMsvHub.set(Number(eid), msvId);
		}
	}

	// Step 2: Fetch all sets from StartGG
	const sets = await fetchAllSets(eventId, undefined, 0);

	// Step 3: Regenerate a fresh bracket
	const standings = tournament.finalStandings;
	const players = bracketName === 'main'
		? standings.filter((s) => s.bracket === 'main').map((s) => ({ entrantId: s.entrantId, seed: s.rank }))
		: standings.filter((s) => s.bracket === 'redemption').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));

	if (!tournament.brackets) {
		return Response.json({ error: 'No brackets' }, { status: 400 });
	}

	let bracket = generateBracket(bracketName, players, standings);

	// Step 4: Apply StartGG results to the fresh bracket
	// Sort sets by completion order (unreported last)
	const reportedSets = (sets as GqlRecord[])
		.filter((s) => s.winnerId)
		.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

	let synced = 0;
	let notFound = 0;

	for (const set of reportedSets) {
		const slots = set.slots ?? [];
		const sgWinnerId = Number(set.winnerId);
		const sgE1 = Number(slots[0]?.entrant?.id);
		const sgE2 = Number(slots[1]?.entrant?.id);
		if (!sgE1 || !sgE2 || !sgWinnerId) continue;

		const msvE1 = bracketEntrantToMsvHub.get(sgE1);
		const msvE2 = bracketEntrantToMsvHub.get(sgE2);
		const msvWinner = bracketEntrantToMsvHub.get(sgWinnerId);
		if (!msvE1 || !msvE2 || !msvWinner) { notFound++; continue; }

		// Find matching bracket match
		const match = bracket.matches.find((m: BracketMatch) =>
			!m.winnerId &&
			((m.topPlayerId === msvE1 && m.bottomPlayerId === msvE2) ||
			 (m.topPlayerId === msvE2 && m.bottomPlayerId === msvE1))
		);
		if (!match) { notFound++; continue; }

		// Extract scores from displayScore (e.g., "1Test 3 - 2Test 1" → 3, 1)
		let topScore: number | undefined;
		let bottomScore: number | undefined;
		const displayScore = set.displayScore as string | undefined;
		if (displayScore) {
			const parts = displayScore.split(' - ');
			if (parts.length === 2) {
				const s1 = Number(parts[0].replace(/[^0-9]/g, ''));
				const s2 = Number(parts[1].replace(/[^0-9]/g, ''));
				if (!isNaN(s1) && !isNaN(s2)) {
					// Figure out which score belongs to top/bottom
					if (msvE1 === match.topPlayerId) { topScore = s1; bottomScore = s2; }
					else { topScore = s2; bottomScore = s1; }
				}
			}
		}

		try {
			bracket = reportBracketMatch(bracket, match.id, msvWinner, undefined, undefined, topScore, bottomScore);
			// Copy StartGG set ID
			const updatedMatch = bracket.matches.find((m: BracketMatch) => m.id === match.id);
			if (updatedMatch) updatedMatch.startggSetId = String(set.id);
			synced++;
		} catch {
			notFound++;
		}
	}

	tournament.brackets[bracketName] = bracket;

	// Clear errors for this bracket
	if (tournament.startggSync) {
		tournament.startggSync.errors = tournament.startggSync.errors.filter(
			(e) => !bracket.matches.some((m: BracketMatch) => m.id === e.matchId)
		);
	}

	await saveTournament(tournament);
	return Response.json({ ok: true, bracketName, synced, notFound, totalSetsOnStartGG: reportedSets.length });
};
