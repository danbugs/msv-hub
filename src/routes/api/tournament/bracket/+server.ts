import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { reportBracketMatch, isGauntletRedemptionReady, generateGauntletRedemption, assignBracketStations } from '$lib/server/swiss';
import { reportBracketMatch as reportBracketMatchToStartGG } from '$lib/server/startgg-reporter';
import { gql, EVENT_PHASES_QUERY, pushBracketSeeding, fetchPhaseGroups } from '$lib/server/startgg';
import { getTournamentParticipants, updateParticipantEvents } from '$lib/server/startgg-admin';

/** PATCH — report a bracket match result */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.brackets) return Response.json({ error: 'No brackets generated' }, { status: 400 });

	const body = await request.json();
	const { bracketName, matchId, winnerId, topCharacters, bottomCharacters, topScore, bottomScore, gameWinners, isDQ } = body as {
		bracketName: 'main' | 'redemption';
		matchId: string;
		winnerId: string;
		topCharacters?: string[];
		bottomCharacters?: string[];
		topScore?: number;
		bottomScore?: number;
		gameWinners?: ('top' | 'bottom')[];
		isDQ?: boolean;
	};

	if (!bracketName || !matchId || !winnerId) {
		return Response.json({ error: 'bracketName, matchId, and winnerId are required' }, { status: 400 });
	}

	const bracket = tournament.brackets[bracketName];
	if (!bracket) return Response.json({ error: `Bracket "${bracketName}" not found` }, { status: 404 });

	// Guard: don't allow editing a GF result if the GF Reset match has been reported.
	// The reset match's state would become inconsistent. Reset GFR first.
	const targetMatch = bracket.matches.find((m) => m.id === matchId);
	const isGFEdit = targetMatch && targetMatch.winnerId && !matchId.includes('-GFR-');
	if (isGFEdit) {
		const maxRound = Math.max(...bracket.matches.filter((m) => !m.id.includes('-GFR-')).map((m) => m.round));
		const isGF = targetMatch.round === maxRound;
		if (isGF) {
			const gfr = bracket.matches.find((m) => m.id.includes('-GFR-'));
			if (gfr?.winnerId) {
				return Response.json({
					error: 'Cannot edit Grand Finals result: the Reset match has already been reported. Unreport the Reset match first (edit it), then edit the Grand Finals.'
				}, { status: 400 });
			}
		}
	}

	try {
		const otherName = bracketName === 'main' ? 'redemption' : 'main';
		const otherBracket = tournament.brackets[otherName];
		const otherHasStream = otherBracket?.matches.some((m) => m.isStream && !m.winnerId) ?? false;

		// Cumulative stream appearances across all Swiss rounds + brackets.
		// Used to spread stream time across more players instead of same seeds each week.
		const streamCountByPlayer = new Map<string, number>();
		const tally = (ids: (string | undefined)[]) => {
			for (const id of ids) if (id) streamCountByPlayer.set(id, (streamCountByPlayer.get(id) ?? 0) + 1);
		};
		for (const r of tournament.rounds) for (const m of r.matches) if (m.isStream) tally([m.topPlayerId, m.bottomPlayerId]);
		for (const bn of ['main', 'redemption'] as const) {
			const b = tournament.brackets?.[bn];
			if (b) for (const m of b.matches) if (m.isStream) tally([m.topPlayerId, m.bottomPlayerId]);
		}

		tournament.brackets[bracketName] = reportBracketMatch(
			bracket, matchId, winnerId, topCharacters, bottomCharacters, topScore, bottomScore,
			tournament.settings, bracketName, otherHasStream, gameWinners, isDQ, streamCountByPlayer
		);
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 400 });
	}

	// Auto-generate redemption bracket when all 0-2 / 1-2 players are eliminated
	// (applies to both gauntlet and experimental1 modes)
	const hasAutoRedemption = tournament.mode === 'gauntlet' || tournament.mode === 'experimental1';
	let redemptionGenerated = false;
	if (hasAutoRedemption && bracketName === 'main' && !tournament.brackets.redemption) {
		const mainMatches = tournament.brackets.main.matches;
		if (isGauntletRedemptionReady(mainMatches)) {
			const mainOccupied = new Set(
				mainMatches
					.filter((m) => m.station !== undefined && !m.winnerId)
					.map((m) => m.station!)
			);
			tournament.brackets.redemption = generateGauntletRedemption(
				mainMatches, tournament.entrants, tournament.settings, mainOccupied
			);
			redemptionGenerated = true;

			// Push redemption seeding to StartGG
			const redEventId = tournament.startggRedemptionBracketEventId;
			const mainEventId = tournament.startggMainBracketEventId;
			if (redEventId && mainEventId) {
				(async () => {
					try {
						const redPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
							EVENT_PHASES_QUERY, { eventId: redEventId }
						);
						const redPhaseId = redPhaseData?.event?.phases?.[0]?.id;
						if (!redPhaseId) return;
						const redGroups = await fetchPhaseGroups(redPhaseId).catch(() => []);
						const redPgId = redGroups[0]?.id;
						if (!redPgId) return;

						const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));

						// Ensure players are in the redemption event
						const eventSlug = tournament.startggEventSlug;
						const tournamentSlug = eventSlug?.match(/tournament\/([^/]+)/)?.[1];
						if (tournamentSlug) {
							const participants = await getTournamentParticipants(tournamentSlug);
							const redPlayerIds = new Set(
								tournament.brackets!.redemption!.players.map((p) => p.entrantId)
							);
							for (const p of participants) {
								if (p.currentEventIds.includes(redEventId)) continue;
								const matchesRedPlayer = tournament.entrants.some(
									(e) => redPlayerIds.has(e.id) && e.gamerTag === p.gamerTag
								);
								if (!matchesRedPlayer) continue;
								const targetEvents = [...new Set([...p.currentEventIds, redEventId])];
								const phaseDests = [{ eventId: redEventId, phaseId: redPhaseId }];
								await updateParticipantEvents(p.participantId, targetEvents, phaseDests);
							}
						}

						// Source PG = Main bracket (where entrant IDs currently live)
						const mainPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
							EVENT_PHASES_QUERY, { eventId: mainEventId }
						);
						const mainPhaseId = mainPhaseData?.event?.phases?.[0]?.id;
						if (!mainPhaseId) return;
						const mainGroups = await fetchPhaseGroups(mainPhaseId).catch(() => []);
						const mainPgId = mainGroups[0]?.id;
						if (!mainPgId) return;
						const rankedEntrantIds = tournament.brackets!.redemption!.players
							.sort((a, b) => a.seed - b.seed)
							.map((p) => entrantMap.get(p.entrantId)?.startggEntrantId)
							.filter((id): id is number => id !== undefined);

						if (rankedEntrantIds.length) {
							await pushBracketSeeding(redPhaseId, redPgId, rankedEntrantIds, mainPgId);
						}
					} catch (e) {
						console.error('[bracket] Redemption seeding push failed:', e);
					}
				})();
			}
		}
	}

	// Reassign stations on the OTHER bracket when a match frees a station
	// (applies to both gauntlet and experimental1 modes — they share stations across brackets)
	if (hasAutoRedemption && tournament.brackets.redemption) {
		const otherName = bracketName === 'main' ? 'redemption' : 'main';
		const otherBracket = tournament.brackets[otherName];
		if (otherBracket) {
			const hasWaiting = otherBracket.matches.some(
				(m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId && m.station === undefined
			);
			if (hasWaiting) {
				const thisBracketOccupied = new Set(
					tournament.brackets[bracketName].matches
						.filter((m) => m.station !== undefined && !m.winnerId)
						.map((m) => m.station!)
				);
				tournament.brackets[otherName] = assignBracketStations(
					otherBracket, tournament.settings, otherName as 'main' | 'redemption',
					false, undefined, thisBracketOccupied
				);
			}
		}
	}

	// Check if all bracket matches are complete
	const allComplete = Object.values(tournament.brackets).filter(Boolean).every((b) =>
		b!.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).every((m) => m.winnerId)
	);

	if (allComplete) tournament.phase = 'completed';

	// Report to StartGG (queued if split not yet confirmed or report fails).
	const reportedMatch = tournament.brackets[bracketName].matches.find((m) => m.id === matchId)!;
	const sgResult = await reportBracketMatchToStartGG(tournament, bracketName, reportedMatch).catch(
		(e) => {
			// Thrown errors get queued for retry instead of being lost
			const sync = tournament.startggSync ?? { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
			if (!tournament.startggSync) tournament.startggSync = sync;
			const pendingKey = `${bracketName}:${matchId}`;
			if (!sync.pendingBracketMatchIds.includes(pendingKey)) {
				sync.pendingBracketMatchIds.push(pendingKey);
			}
			return { ok: false, queued: true, error: e instanceof Error ? e.message : String(e) };
		}
	);

	// Concurrency-safe save: reload the latest tournament from Redis and merge our
	// bracket changes into it. Protects against two bracket reports racing where
	// the second one loads stale state and overwrites the first's winner.
	const fresh = await getActiveTournament();
	if (fresh?.brackets && fresh.brackets[bracketName]) {
		const freshBracket = fresh.brackets[bracketName];
		const ourBracket = tournament.brackets[bracketName];
		const freshMatchIds = new Set(freshBracket.matches.map((m) => m.id));
		const ourMatchMap = new Map(ourBracket.matches.map((m) => [m.id, m]));

		// Merge existing fresh matches
		for (let i = 0; i < freshBracket.matches.length; i++) {
			const fm = freshBracket.matches[i];
			const om = ourMatchMap.get(fm.id);
			if (!om) continue;
			// If we just modified this match (the one being reported), take our version
			if (fm.id === matchId) {
				freshBracket.matches[i] = om;
				continue;
			}
			// Preserve fresh's winner if it has one (don't overwrite concurrent reports)
			if (fm.winnerId) continue;
			// Merge player slots individually so concurrent reports advancing
			// different players into the same downstream match don't overwrite
			// each other (e.g. WR2 loser drop-in + LR1 winner into same LR2 match).
			if (om.topPlayerId && !fm.topPlayerId) fm.topPlayerId = om.topPlayerId;
			if (om.bottomPlayerId && !fm.bottomPlayerId) fm.bottomPlayerId = om.bottomPlayerId;
			if (om.station !== undefined && fm.station === undefined) fm.station = om.station;
			if (om.isStream && !fm.isStream) fm.isStream = om.isStream;
			if (om.calledAt && !fm.calledAt) fm.calledAt = om.calledAt;
		}

		// Append matches that exist in OUR bracket but not fresh (e.g. newly-created GFR)
		for (const om of ourBracket.matches) {
			if (!freshMatchIds.has(om.id)) {
				freshBracket.matches.push(om);
			}
		}

		// Remove matches that OUR bracket dropped (e.g. GFR deleted when GF flipped to top-winner)
		freshBracket.matches = freshBracket.matches.filter((fm) => ourMatchMap.has(fm.id));

		if (tournament.phase === 'completed') fresh.phase = 'completed';
		if (redemptionGenerated && tournament.brackets.redemption) {
			fresh.brackets!.redemption = tournament.brackets.redemption;
			// Reset splitConfirmed so match reports queue until redemption sync completes
			if (!fresh.startggSync) fresh.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
			else fresh.startggSync.splitConfirmed = false;
		}
		// Merge pending bracket match IDs (union of fresh + ours)
		if (tournament.startggSync) {
			if (!fresh.startggSync) fresh.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
			const merged = new Set([...fresh.startggSync.pendingBracketMatchIds, ...(tournament.startggSync.pendingBracketMatchIds ?? [])]);
			fresh.startggSync.pendingBracketMatchIds = [...merged];
		}
		await saveTournament(fresh);
		tournament.brackets[bracketName] = freshBracket;
	} else {
		if (redemptionGenerated && tournament.startggSync) {
			tournament.startggSync.splitConfirmed = false;
		}
		await saveTournament(tournament);
	}
	return Response.json({
		ok: true,
		bracket: tournament.brackets[bracketName],
		redemptionBracket: redemptionGenerated ? tournament.brackets.redemption : undefined,
		tournamentComplete: allComplete,
		pendingBracketMatchIds: tournament.startggSync?.pendingBracketMatchIds ?? [],
		startgg: {
			ok: sgResult.ok,
			queued: sgResult.queued ?? false,
			error: sgResult.ok ? undefined : sgResult.error
		}
	});
};
