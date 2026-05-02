import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { sendMessage } from '$lib/server/discord';
import { reportSwissMatch, triggerConversionAndCache } from '$lib/server/startgg-reporter';
import { pushPairingsToPhaseGroup, pushFinalStandingsSeeding, gql, EVENT_PHASES_QUERY, TOURNAMENT_QUERY, fetchPhaseGroups } from '$lib/server/startgg';
import { addEntrantsToPhase, finalizePlacements } from '$lib/server/startgg-admin';
import {
	calculateStandings,
	calculateSwissPairings,
	assignStations,
	recommendStreamMatches,
	calculateFinalStandings,
	generateBracket,
	assignBracketStations
} from '$lib/server/swiss';
import type { SwissRound, SwissMatch } from '$lib/types/tournament';

/** POST — start next round (generate pairings) or regenerate current round */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
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

		const isExperimental1 = tournament.mode === 'experimental1';

		// Experimental #1: all players go to main bracket (redemption auto-generated later)
		if (isExperimental1) {
			for (const s of finalStandings) s.bracket = 'main';
		}

		tournament.finalStandings = finalStandings;

		const mainPlayers = finalStandings.filter((s) => s.bracket === 'main').map((s) => ({ entrantId: s.entrantId, seed: s.rank }));
		const redemptionPlayers = finalStandings.filter((s) => s.bracket === 'redemption').map((s, i) => ({ entrantId: s.entrantId, seed: i + 1 }));

		// Build last Swiss round opponent map for bracket rematch avoidance
		const lastSwissRound = tournament.rounds.filter((r) => r.status === 'completed').at(-1);
		const lastRoundOpponents = new Map<string, string>();
		if (lastSwissRound) {
			for (const m of lastSwissRound.matches) {
				if (m.topPlayerId && m.bottomPlayerId) {
					lastRoundOpponents.set(m.topPlayerId, m.bottomPlayerId);
					lastRoundOpponents.set(m.bottomPlayerId, m.topPlayerId);
				}
			}
		}

		if (isExperimental1) {
			// All players in one main bracket, no redemption yet
			let mainBracket = generateBracket('main', mainPlayers, finalStandings, undefined, lastRoundOpponents);
			mainBracket = assignBracketStations(mainBracket, tournament.settings);
			tournament.brackets = { main: mainBracket };
		} else {
			tournament.brackets = {
				main: generateBracket('main', mainPlayers, finalStandings, undefined, lastRoundOpponents),
				redemption: generateBracket('redemption', redemptionPlayers, finalStandings, undefined, lastRoundOpponents)
			};
		}
		tournament.phase = 'brackets';

		if (!isExperimental1) {
			// Assign stations: split non-stream stations evenly between main and redemption.
			const totalStations = tournament.settings.numStations;
			const streamStn = tournament.settings.streamStation;
			const allRegularStations = Array.from({ length: totalStations }, (_, i) => i + 1).filter(s => s !== streamStn);
			const halfIdx = Math.floor(allRegularStations.length / 2);
			const mainStations = allRegularStations.slice(0, halfIdx);
			const redemptionStations = allRegularStations.slice(halfIdx);

			const mainReady = tournament.brackets.main.matches.filter(m => m.topPlayerId && m.bottomPlayerId && !m.winnerId);
			const redReady = tournament.brackets.redemption?.matches.filter(m => m.topPlayerId && m.bottomPlayerId && !m.winnerId) ?? [];

			const standingsMap = new Map(finalStandings.map(s => [s.entrantId, s]));
			let bestStreamMatch: typeof mainReady[0] | undefined;
			let bestHype = Infinity;
			for (const m of mainReady) {
				const s1 = standingsMap.get(m.topPlayerId!)?.rank ?? 999;
				const s2 = standingsMap.get(m.bottomPlayerId!)?.rank ?? 999;
				const hype = s1 + s2;
				if (hype < bestHype) { bestHype = hype; bestStreamMatch = m; }
			}
			if (bestStreamMatch) {
				bestStreamMatch.station = streamStn;
				bestStreamMatch.isStream = true;
			}

			let mainIdx = 0;
			for (const m of mainReady) {
				if (m.isStream) continue;
				if (mainIdx < mainStations.length) m.station = mainStations[mainIdx++];
			}
			let redIdx = 0;
			for (const m of redReady) {
				if (redIdx < redemptionStations.length) m.station = redemptionStations[redIdx++];
			}
		}

		// Auto-discover and link bracket events from StartGG, then push seeding
		// Always try discovery — event IDs from a previous run may be stale.
		if (tournament.startggEventSlug) {
			try {
				const slugMatch = tournament.startggEventSlug.match(/tournament\/([^/]+)/);
				if (slugMatch) {
					const tData = await gql<{ tournament: { events: { id: number; name: string; numEntrants: number }[] } }>(
						TOURNAMENT_QUERY, { slug: slugMatch[1] }
					);
					const allEvents = tData?.tournament?.events ?? [];
					const otherEvents = allEvents.filter((e) => e.id !== tournament.startggEventId);
					const mainEvt = otherEvents.find((e) => /main/i.test(e.name));
					const redEvt = otherEvents.find((e) => /redemption/i.test(e.name));
					if (mainEvt) {
						tournament.startggMainBracketEventId = mainEvt.id;
						console.log(`[StartGG] Auto-linked main bracket event: ${mainEvt.name} (${mainEvt.id})`);
					}
					if (redEvt) {
						tournament.startggRedemptionBracketEventId = redEvt.id;
						console.log(`[StartGG] Auto-linked redemption bracket event: ${redEvt.name} (${redEvt.id})`);
					}
					// Fallback: if exactly 2 non-Swiss events, larger = main
					if (!mainEvt && !redEvt && otherEvents.length === 2) {
						const sorted = [...otherEvents].sort((a, b) => b.numEntrants - a.numEntrants);
						tournament.startggMainBracketEventId = sorted[0].id;
						tournament.startggRedemptionBracketEventId = sorted[1].id;
						console.log(`[StartGG] Auto-linked by size: main=${sorted[0].name}, redemption=${sorted[1].name}`);
					}
				}
			} catch (e) {
				console.error(`[StartGG] Bracket event auto-discovery failed: ${e}`);
			}
		}

		// Bracket seeding + conversion happens when TO clicks "Split Done" (startgg-sync POST)
		// after they assign players to bracket events on StartGG.

		// Push final Swiss standings to the "Final Standings" phase on StartGG
		// If IDs aren't stored (tournament created before this feature), look them up now.
		if (!tournament.startggFinalStandingsPhaseId && tournament.startggEventId) {
			try {
				const phaseData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
					EVENT_PHASES_QUERY, { eventId: tournament.startggEventId }
				);
				const fsp = phaseData?.event?.phases?.find((p) => p.name.toLowerCase().includes('final'));
				if (fsp) {
					tournament.startggFinalStandingsPhaseId = fsp.id;
					const groups = await fetchPhaseGroups(fsp.id).catch(() => []);
					if (groups.length > 0) tournament.startggFinalStandingsPhaseGroupId = groups[0].id;
					console.log(`[StartGG] Resolved Final Standings phase: ${fsp.id}, PG: ${tournament.startggFinalStandingsPhaseGroupId}`);
				}
			} catch { /* best effort */ }
		}
		// Add all entrants to Final Standings phase (groupTypeId 6 = custom schedule)
		if (tournament.startggFinalStandingsPhaseId && tournament.startggEventId) {
			const allEntrantIds = tournament.entrants
				.map((e) => e.startggEntrantId)
				.filter((id): id is number => id !== undefined);
			await addEntrantsToPhase(tournament.startggEventId, tournament.startggFinalStandingsPhaseId, allEntrantIds, undefined, 6)
				.catch((e) => console.error(`[StartGG] Failed to add entrants to Final Standings: ${e}`));
		}

		// Finalize placements using the admin REST endpoint
		let finalStandingsSynced = false;
		if (tournament.startggFinalStandingsPhaseGroupId) {
			const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
			const standings = finalStandings
				.map((s, i) => {
					const sgId = entrantMap.get(s.entrantId)?.startggEntrantId;
					return sgId ? { entrantId: sgId, placement: i + 1 } : null;
				})
				.filter((s): s is { entrantId: number; placement: number } => s !== null);
			if (standings.length) {
				const result = await finalizePlacements(tournament.startggFinalStandingsPhaseGroupId, standings)
					.catch((e) => ({ ok: false as const, error: String(e) }));
				finalStandingsSynced = result.ok;
				if (!result.ok) {
					console.error(`[StartGG] finalizePlacements failed: ${result.error}`);
				} else {
					console.log(`[StartGG] Finalized ${standings.length} placements`);
				}
			}
		}

		await saveTournament(tournament);
		return Response.json({
			phase: 'brackets', finalStandings, brackets: tournament.brackets,
			startggFinalStandingsSynced: finalStandingsSynced,
			startggMainBracketLinked: !!tournament.startggMainBracketEventId,
			startggRedemptionBracketLinked: !!tournament.startggRedemptionBracketEventId
		});
	}

	// Generate pairings for next round
	const nextRound = tournament.currentRound + 1;
	const completedRounds = tournament.rounds.filter((r) => r.status === 'completed');
	const standings = calculateStandings(tournament.entrants, completedRounds);
	const { pairings, bye } = calculateSwissPairings(standings, nextRound);

	// Build matches — ensure lower seed is always on top (left) side
	const seedMap = new Map(tournament.entrants.map((e) => [e.id, e.initialSeed]));
	let matchId = 0;
	const matches: SwissMatch[] = pairings.map(([p1, p2]) => {
		const s1 = seedMap.get(p1[0]) ?? Infinity;
		const s2 = seedMap.get(p2[0]) ?? Infinity;
		const [top, bot] = s1 <= s2 ? [p1, p2] : [p2, p1];
		return { id: `r${nextRound}-m${matchId++}`, topPlayerId: top[0], bottomPlayerId: bot[0] };
	});

	// Collect players who were on stream last round to avoid back-to-back appearances
	const lastCompleted = completedRounds.at(-1);
	const recentStreamIds = new Set(
		lastCompleted?.matches
			.filter((m) => m.isStream)
			.flatMap((m) => [m.topPlayerId, m.bottomPlayerId])
			.filter(Boolean) as string[]
	);

	// Cumulative stream counts: every stream appearance across all Swiss rounds AND brackets.
	// Used to spread stream time across more players.
	const streamCountByPlayer = new Map<string, number>();
	function tally(ids: (string | undefined)[]) {
		for (const id of ids) if (id) streamCountByPlayer.set(id, (streamCountByPlayer.get(id) ?? 0) + 1);
	}
	for (const r of tournament.rounds) {
		for (const m of r.matches) {
			if (m.isStream) tally([m.topPlayerId, m.bottomPlayerId]);
		}
	}
	for (const bracketName of ['main', 'redemption'] as const) {
		const b = tournament.brackets?.[bracketName];
		if (b) for (const m of b.matches) if (m.isStream) tally([m.topPlayerId, m.bottomPlayerId]);
	}

	// Get stream recommendations and assign stations
	const pairingIds = pairings.map(([t, b]) => [t[0], b[0]] as [string, string]);
	const streamRecs = recommendStreamMatches(pairingIds, standings, tournament.entrants, recentStreamIds, streamCountByPlayer);

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
	const roundGroup = tournament.startggPhase1Groups?.find(g => g.roundNumber === nextRound)
		?? tournament.startggPhase1Groups?.[nextRound - 1];
	const pgId = roundGroup?.id;
	const roundPhaseId = roundGroup?.phaseId ?? tournament.startggPhase1Id;
	if (nextRound > 1 && roundPhaseId && pgId) {
		// Add all entrants to this round's phase (they're only in R1 by default)
		if (tournament.startggEventId) {
			const allEntrantIds = tournament.entrants
				.map((e) => e.startggEntrantId)
				.filter((id): id is number => id !== undefined);
			if (allEntrantIds.length) {
				const addResult = await addEntrantsToPhase(tournament.startggEventId, roundPhaseId, allEntrantIds)
					.catch((e) => ({ ok: false as const, error: String(e) }));
				if (addResult.ok) {
					console.log(`[StartGG] Added ${allEntrantIds.length} entrants to round ${nextRound} phase ${roundPhaseId}`);
				} else {
					console.error(`[StartGG] Failed to add entrants to round ${nextRound}: ${addResult.error}`);
				}
			}
		}

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
				// Pool is already started (from previous test run or prior attempt).
				// Show the Phase Reset banner so user can reset on StartGG and retry.
				if (!tournament.startggSync) {
					tournament.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
				}
				tournament.startggSync.pendingPhaseReset = {
					roundNumber: nextRound,
					phaseGroupId: pgId,
					phaseId: roundPhaseId
				};
				await saveTournament(tournament);
			} else {
				console.log(`[StartGG] Re-seed successful for round ${nextRound}`);
			}
		}
	}

	// Fire-and-forget background cache (returns quickly; the lock on reports handles
	// races if the user clicks before caching finishes).
	if (pgId) {
		if (!tournament.startggSync) {
			tournament.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
		}
		tournament.startggSync.cacheReady = false;
		await saveTournament(tournament);

		const conversionPromise = triggerConversionAndCache(tournament, nextRound, pgId).catch(() => {});
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const ctx = (platform as any)?.context;
			if (ctx?.waitUntil) ctx.waitUntil(conversionPromise);
		} catch { /* not on Vercel */ }
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

	// A "fix" is any change to an already-reported match (different winner OR different score).
	// This triggers pairing regeneration for the next active round.
	const wasMisreport = match.winnerId !== undefined;
	const winnerChanged = match.winnerId !== undefined && match.winnerId !== winnerId;
	// Snapshot original state so we can revert if StartGG report fails (for new reports)
	const origWinnerId = match.winnerId;
	const origTopScore = match.topScore;
	const origBottomScore = match.bottomScore;
	const origIsDQ = match.isDQ;
	match.winnerId = winnerId;
	if (isDQ) { match.isDQ = true; match.topScore = undefined; match.bottomScore = undefined; }
	else { match.isDQ = false; if (topScore !== undefined) match.topScore = topScore; if (bottomScore !== undefined) match.bottomScore = bottomScore; }

	// Distributed lock: serialize reports during preview→real conversion AND
	// when background caching hasn't populated preview IDs yet (R2+ first report).
	const { acquireLock, waitForLock, releaseLock } = await import('$lib/server/store');
	const lockKey = `lock:swiss_convert:${tournament.slug}:${targetRound.number}`;

	const hasRealId = match.startggSetId && !match.startggSetId.startsWith('preview_');
	let gotLock = false;

	if (!hasRealId) {
		gotLock = await acquireLock(lockKey, 15);
		if (!gotLock) {
			// Another report holds the lock — wait, then reload to get the real IDs it cached
			await waitForLock(lockKey, 10000);
			const reloaded = await getActiveTournament();
			if (reloaded) {
				const reloadedRound = reloaded.rounds.find((r) => r.number === targetRound!.number);
				const reloadedMatch = reloadedRound?.matches.find((m) => m.id === matchId);
				if (reloadedMatch?.startggSetId) {
					match.startggSetId = reloadedMatch.startggSetId;
				}
			}
		} else if (!match.startggSetId) {
			// Got the lock but no cached ID yet — wait briefly for background cache to populate
			// (R2+ case where user reports before bg cache finished).
			for (let attempt = 0; attempt < 5; attempt++) {
				await new Promise<void>((r) => setTimeout(r, 1000));
				const reloaded = await getActiveTournament();
				if (!reloaded) break;
				const rr = reloaded.rounds.find((r) => r.number === targetRound!.number);
				const rm = rr?.matches.find((m) => m.id === matchId);
				if (rm?.startggSetId) {
					match.startggSetId = rm.startggSetId;
					break;
				}
			}
		}
	}

	// Report to StartGG.
	const sgResult = await reportSwissMatch(tournament, targetRound.number, match).catch(
		(e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })
	);

	if (gotLock) await releaseLock(lockKey);

	// If StartGG reporting failed AND this was a new report (not a fix/misreport),
	// revert local state so the UI doesn't show the match as reported when it isn't.
	// For misreport fixes, keep the original winner so tournament state doesn't break.
	if (!sgResult.ok && !wasMisreport) {
		match.winnerId = origWinnerId;
		match.topScore = origTopScore;
		match.bottomScore = origBottomScore;
		match.isDQ = origIsDQ;
	}

	// Safe merge: re-load fresh state so concurrent reports don't overwrite each other.
	// Only apply this specific match's changes to the latest state.
	const fresh = await getActiveTournament();
	if (fresh) {
		const freshRound = fresh.rounds.find((r) => r.number === targetRound.number);
		const freshMatch = freshRound?.matches.find((m) => m.id === matchId);
		if (freshMatch) {
			freshMatch.winnerId = match.winnerId;
			freshMatch.topScore = match.topScore;
			freshMatch.bottomScore = match.bottomScore;
			freshMatch.isDQ = match.isDQ;
			freshMatch.startggSetId = match.startggSetId;
			// Merge any cached set IDs from conversion (other matches in this round).
			// Overwrite when the fresh copy has a preview ID and ours is real —
			// otherwise stale preview IDs would stick around after conversion.
			if (freshRound) {
				for (const m of targetRound.matches) {
					if (!m.startggSetId) continue;
					const fm = freshRound.matches.find((fm) => fm.id === m.id);
					if (!fm) continue;
					const newIsPreview = m.startggSetId.startsWith('preview_');
					const freshIsPreview = fm.startggSetId?.startsWith('preview_') ?? false;
					// Copy if fresh has nothing, OR if fresh has preview and ours is real
					if (!fm.startggSetId || (freshIsPreview && !newIsPreview)) {
						fm.startggSetId = m.startggSetId;
					}
				}
			}
			if (tournament.startggSync) {
				const freshCacheReady = fresh.startggSync?.cacheReady;
				fresh.startggSync = tournament.startggSync;
				// Preserve cacheReady=true if the background caching completed
				if (freshCacheReady === true) fresh.startggSync.cacheReady = true;
			}
		}
		await saveTournament(fresh);
	} else {
		await saveTournament(tournament);
	}

	// If a winner was changed in a completed round, regenerate the first ACTIVE round
	// with no reported results. Skip completed rounds in between — they stay untouched.
	let regeneratedNextRound = false;
	console.log(`[PATCH] wasMisreport=${wasMisreport} winnerChanged=${winnerChanged} round=${targetRound.number} status=${targetRound.status}`);
	if (winnerChanged && targetRound.status === 'completed') {
		const latestState = await getActiveTournament();
		if (latestState) {
			const nextRound = latestState.rounds.find(
				(r) => r.number > targetRound.number && r.status === 'active' && r.matches.every((m) => !m.winnerId)
			);
			if (nextRound) {
				// Regenerate pairings for the next round using corrected standings
				const completedRounds = latestState.rounds.filter((r) => r.status === 'completed');
				const standings = calculateStandings(latestState.entrants, completedRounds);
				const { pairings, bye } = calculateSwissPairings(standings, nextRound.number);

				let matchId2 = 0;
				const newMatches: SwissMatch[] = pairings.map(([top, bot]) => ({
					id: `r${nextRound.number}-m${matchId2++}`,
					topPlayerId: top[0],
					bottomPlayerId: bot[0]
				}));

				const pairingIds = pairings.map(([t, b]) => [t[0], b[0]] as [string, string]);
				const lastCompleted = completedRounds.at(-1);
				const recentStreamIds = new Set(
					lastCompleted?.matches.filter((m) => m.isStream).flatMap((m) => [m.topPlayerId, m.bottomPlayerId]).filter(Boolean) as string[]
				);
				const streamCountByPlayer2 = new Map<string, number>();
				const tallyFn = (ids: (string | undefined)[]) => {
					for (const id of ids) if (id) streamCountByPlayer2.set(id, (streamCountByPlayer2.get(id) ?? 0) + 1);
				};
				for (const r of latestState.rounds) for (const m of r.matches) if (m.isStream) tallyFn([m.topPlayerId, m.bottomPlayerId]);
				for (const bracketName of ['main', 'redemption'] as const) {
					const b = latestState.brackets?.[bracketName];
					if (b) for (const m of b.matches) if (m.isStream) tallyFn([m.topPlayerId, m.bottomPlayerId]);
				}
				const streamRecs = recommendStreamMatches(pairingIds, standings, latestState.entrants, recentStreamIds, streamCountByPlayer2);
				const recsFixed = streamRecs.map((rec) => {
					const m = newMatches.find((nm) =>
						rec.topPlayer === latestState.entrants.find((e) => e.id === nm.topPlayerId)?.gamerTag
					);
					return { ...rec, matchId: m?.id ?? rec.matchId };
				});
				const assigned = assignStations(newMatches, latestState.settings, recsFixed);

				nextRound.matches = assigned;
				nextRound.byePlayerId = bye ? bye[0] : undefined;
				regeneratedNextRound = true;

				// Try to re-seed on StartGG. If the pool is already started (conversion
				// already happened), set pendingPhaseReset so the UI shows a prompt.
				const roundGroup = latestState.startggPhase1Groups?.find(g => g.roundNumber === nextRound.number)
					?? latestState.startggPhase1Groups?.[nextRound.number - 1];
				const rPgId = roundGroup?.id;
				const rPhaseId = roundGroup?.phaseId ?? latestState.startggPhase1Id;
				// Since we trigger conversion at round start, the pool is always started.
				// Set pendingPhaseReset so the user resets the phase on StartGG, then
				// clicks "Phase Reset Done" to re-seed and re-convert.
				if (!latestState.startggSync) {
					latestState.startggSync = { splitConfirmed: false, pendingBracketMatchIds: [], errors: [] };
				}
				// Clear cached set IDs since pairings changed
				for (const m of nextRound.matches) m.startggSetId = undefined;

				if (rPhaseId && rPgId) {
					latestState.startggSync.pendingPhaseReset = {
						roundNumber: nextRound.number,
						phaseGroupId: rPgId,
						phaseId: rPhaseId
					};
					console.log(`[PATCH] Set pendingPhaseReset for round ${nextRound.number} (PG ${rPgId})`);
				}
				await saveTournament(latestState);
			}
		}
	}

	const roundComplete = targetRound.matches.every((m) => m.winnerId);

	return Response.json({
		ok: true,
		match,
		wasMisreport,
		roundComplete,
		regeneratedNextRound,
		startgg: { ok: sgResult.ok, error: sgResult.ok ? undefined : sgResult.error }
	});
};
