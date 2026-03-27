import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { sendMessage } from '$lib/server/discord';
import { reportSwissMatch, triggerConversionAndCache } from '$lib/server/startgg-reporter';
import { pushPairingsToPhaseGroup } from '$lib/server/startgg';
import {
	calculateStandings,
	calculateSwissPairings,
	assignStations,
	recommendStreamMatches,
	calculateFinalStandings,
	generateBracket
} from '$lib/server/swiss';
import type { SwissRound, SwissMatch } from '$lib/types/tournament';

/** POST — start next round (generate pairings) or regenerate current round */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (tournament.phase !== 'swiss') return Response.json({ error: 'Tournament is not in Swiss phase' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const regenerate = body.regenerate === true;
	const announceChannel = (body.announceChannel as string | undefined) ?? '';

	// If regenerating, remove the current round if it has no reported results
	if (regenerate && tournament.rounds.length > 0) {
		const current = tournament.rounds[tournament.rounds.length - 1];
		if (current.status === 'active' && current.matches.every((m) => !m.winnerId)) {
			tournament.rounds.pop();
			tournament.currentRound--;
		} else if (current.status === 'active') {
			return Response.json({ error: 'Cannot regenerate round with reported results. Use misreport fix instead.' }, { status: 400 });
		}
	}

	// Check if all matches in the current round are reported
	if (tournament.rounds.length > 0) {
		const lastRound = tournament.rounds[tournament.rounds.length - 1];
		if (lastRound.status === 'active' && lastRound.matches.some((m) => !m.winnerId)) {
			return Response.json({ error: 'Current round has unreported matches' }, { status: 400 });
		}
		// Mark previous round as completed
		if (lastRound.status === 'active') {
			lastRound.status = 'completed';
		}
	}

	// Check if Swiss is complete
	if (tournament.rounds.filter((r) => r.status === 'completed').length >= tournament.settings.numRounds) {
		// Generate final standings and brackets
		const finalStandings = calculateFinalStandings(tournament.entrants, tournament.rounds);
		tournament.finalStandings = finalStandings;

		const mainPlayers = finalStandings.filter((s) => s.bracket === 'main').map((s) => ({ entrantId: s.entrantId, seed: s.rank }));
		const redemptionPlayers = finalStandings.filter((s) => s.bracket === 'redemption').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));

		tournament.brackets = {
			main: generateBracket('main', mainPlayers, finalStandings, tournament.settings),
			redemption: generateBracket('redemption', redemptionPlayers, finalStandings, tournament.settings)
		};
		tournament.phase = 'brackets';

		await saveTournament(tournament);
		return Response.json({ phase: 'brackets', finalStandings, brackets: tournament.brackets });
	}

	// Generate pairings for next round
	const nextRound = tournament.currentRound + 1;
	const completedRounds = tournament.rounds.filter((r) => r.status === 'completed');
	const standings = calculateStandings(tournament.entrants, completedRounds);
	const { pairings, bye } = calculateSwissPairings(standings, nextRound);

	// Build matches
	let matchId = 0;
	const matches: SwissMatch[] = pairings.map(([top, bot]) => ({
		id: `r${nextRound}-m${matchId++}`,
		topPlayerId: top[0],
		bottomPlayerId: bot[0]
	}));

	// Collect players who were on stream last round to avoid repeat stream appearances
	const lastCompleted = completedRounds.at(-1);
	const recentStreamIds = new Set(
		lastCompleted?.matches
			.filter((m) => m.isStream)
			.flatMap((m) => [m.topPlayerId, m.bottomPlayerId])
			.filter(Boolean) as string[]
	);

	// Get stream recommendations and assign stations
	const pairingIds = pairings.map(([t, b]) => [t[0], b[0]] as [string, string]);
	const streamRecs = recommendStreamMatches(pairingIds, standings, tournament.entrants, recentStreamIds);

	// Fix match IDs in stream recs to match our generated IDs
	const recsWithFixedIds = streamRecs.map((rec) => {
		const match = matches.find(
			(m) =>
				(m.topPlayerId === rec.matchId.split('-').slice(1).join('-').split('-')[0]) ||
				rec.topPlayer === tournament.entrants.find((e) => e.id === m.topPlayerId)?.gamerTag
		);
		return { ...rec, matchId: match?.id ?? rec.matchId };
	});

	const assignedMatches = assignStations(matches, tournament.settings, recsWithFixedIds);

	const round: SwissRound = {
		number: nextRound,
		status: 'active',
		matches: assignedMatches,
		byePlayerId: bye ? bye[0] : undefined
	};

	tournament.rounds.push(round);
	tournament.currentRound = nextRound;

	await saveTournament(tournament);

	// For round 2+, push our custom pairings to StartGG's phase group BEFORE triggering
	// conversion/caching — the phase group must have the correct seeding first.
	const roundGroup = tournament.startggPhase1Groups?.[nextRound - 1];
	const pgId = roundGroup?.id;
	const roundPhaseId = roundGroup?.phaseId ?? tournament.startggPhase1Id;
	if (nextRound > 1 && roundPhaseId && pgId) {
		const entrantMap2 = new Map(tournament.entrants.map((e) => [e.id, e]));
		const sgPairings = assignedMatches
			.map((m): [number, number] | null => {
				const t = entrantMap2.get(m.topPlayerId)?.startggEntrantId;
				const b = entrantMap2.get(m.bottomPlayerId)?.startggEntrantId;
				return t && b ? [t, b] : null;
			})
			.filter((p): p is [number, number] => p !== null);
		if (sgPairings.length) {
			const byeEntrantId = bye ? entrantMap2.get(bye[0])?.startggEntrantId : undefined;
			console.log(`[StartGG] Pushing ${sgPairings.length} pairings to phase group ${pgId} (phase ${roundPhaseId}) for round ${nextRound}`);
			const seedResult = await pushPairingsToPhaseGroup(
				roundPhaseId,
				pgId,
				sgPairings,
				byeEntrantId
			).catch((e) => ({ ok: false as const, error: String(e) }));
			if (!seedResult.ok) {
				console.error(`[StartGG] pushPairingsToPhaseGroup failed: ${seedResult.error}`);
				if (!tournament.startggSync) {
					tournament.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
				}
				tournament.startggSync.errors.push({
					matchId: `round-${nextRound}-seed`,
					message: `StartGG re-seed failed for round ${nextRound}: ${seedResult.error}`,
					ts: Date.now()
				});
				await saveTournament(tournament);
			} else {
				console.log(`[StartGG] Re-seed successful for round ${nextRound}`);
			}
		}
	}

	// Fire-and-forget: trigger StartGG preview→real conversion and cache real set IDs.
	// Sets cacheReady=false immediately so the UI shows the "Re-hydrating" banner, then
	// cacheReady=true once real IDs are populated (~30–60 s for round 1; near-instant for later rounds).
	if (pgId) {
		if (!tournament.startggSync) {
			tournament.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
		}
		tournament.startggSync.cacheReady = false;
		await saveTournament(tournament);

		triggerConversionAndCache(tournament, nextRound, pgId).catch(() => {});
	}

	// Optionally announce the new round to a Discord channel.
	if (announceChannel) {
		const CHANNEL_IDS: Record<string, string> = {
			'general':        '1066863005591162961',
			'announcements':  '1066863301885173800',
			'talk-to-balrog': '1317322917129879562'
		};
		const channelId = CHANNEL_IDS[announceChannel] ?? announceChannel;
		const appUrl = (env as Record<string, string | undefined>)['APP_URL']
			? `https://${(env as Record<string, string | undefined>)['APP_URL']}`
			: '';
		const liveLink = appUrl ? ` Check it out here: ${appUrl}/live/${tournament.slug}` : '';
		await sendMessage(channelId, `🎮 Round ${nextRound} is starting!${liveLink}`)
			.catch(() => { /* best-effort */ });
	}

	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
	return Response.json({
		round,
		standings: Object.fromEntries(standings),
		streamRecommendations: recsWithFixedIds.slice(0, 3),
		bye: bye ? { entrantId: bye[0], gamerTag: entrantMap.get(bye[0])?.gamerTag } : null
	});
};

/** PATCH — report a match result or fix a misreport */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const body = await request.json();
	const { matchId, winnerId, roundNumber, topScore, bottomScore, isDQ } = body as {
		matchId: string;
		winnerId: string;
		roundNumber?: number;
		topScore?: number;
		bottomScore?: number;
		isDQ?: boolean;
	};

	if (!matchId || !winnerId) {
		return Response.json({ error: 'matchId and winnerId are required' }, { status: 400 });
	}

	// Find the match across all rounds
	let targetRound: SwissRound | undefined;
	for (const round of tournament.rounds) {
		if (roundNumber !== undefined && round.number !== roundNumber) continue;
		const match = round.matches.find((m) => m.id === matchId);
		if (match) {
			targetRound = round;
			break;
		}
	}

	if (!targetRound) return Response.json({ error: 'Match not found' }, { status: 404 });

	const match = targetRound.matches.find((m) => m.id === matchId)!;
	if (winnerId !== match.topPlayerId && winnerId !== match.bottomPlayerId) {
		return Response.json({ error: 'winnerId must be one of the match players' }, { status: 400 });
	}

	const wasMisreport = match.winnerId !== undefined && match.winnerId !== winnerId;
	match.winnerId = winnerId;
	if (isDQ) { match.isDQ = true; match.topScore = undefined; match.bottomScore = undefined; }
	else { match.isDQ = false; if (topScore !== undefined) match.topScore = topScore; if (bottomScore !== undefined) match.bottomScore = bottomScore; }

	// Save MSV Hub state immediately so the UI gets an instant response.
	await saveTournament(tournament);

	const roundComplete = targetRound.matches.every((m) => m.winnerId);
	const roundNum = targetRound.number;

	// Fire StartGG report in the background — never block the UI.
	// After reporting, re-load the latest tournament and merge only StartGG fields
	// to avoid overwriting concurrent match reports.
	reportSwissMatch(tournament, roundNum, match)
		.then(async () => {
			const fresh = await getActiveTournament();
			if (!fresh) return;
			// Merge startggSetId onto the match in the fresh state
			const freshRound = fresh.rounds.find((r) => r.number === roundNum);
			const freshMatch = freshRound?.matches.find((m) => m.id === matchId);
			if (freshMatch) freshMatch.startggSetId = match.startggSetId;
			// Merge StartGG sync state (errors, cacheReady, etc.)
			if (tournament.startggSync) fresh.startggSync = tournament.startggSync;
			await saveTournament(fresh);
		})
		.catch(() => {});

	return Response.json({
		ok: true,
		match,
		wasMisreport,
		roundComplete,
		startgg: { ok: true, background: true }
	});
};
