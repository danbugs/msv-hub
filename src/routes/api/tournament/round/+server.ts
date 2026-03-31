import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { sendMessage } from '$lib/server/discord';
import { reportSwissMatch, triggerConversionAndCache } from '$lib/server/startgg-reporter';
import { pushPairingsToPhaseGroup, pushFinalStandingsSeeding, pushBracketSeeding, reportSet, resetSet, gql, EVENT_PHASES_QUERY, TOURNAMENT_QUERY, PHASE_GROUP_SETS_QUERY, fetchPhaseGroups } from '$lib/server/startgg';
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
			main: generateBracket('main', mainPlayers, finalStandings),
			redemption: generateBracket('redemption', redemptionPlayers, finalStandings)
		};
		tournament.phase = 'brackets';

		// Assign stations: split non-stream stations evenly between main and redemption.
		// Stream station (e.g. 16) is separate — assigned to the highest-hype main match.
		const totalStations = tournament.settings.numStations;
		const streamStn = tournament.settings.streamStation;
		// Build pool of all regular stations (excluding stream)
		const allRegularStations = Array.from({ length: totalStations }, (_, i) => i + 1).filter(s => s !== streamStn);
		const halfIdx = Math.ceil(allRegularStations.length / 2);
		const mainStations = allRegularStations.slice(0, halfIdx);
		const redemptionStations = allRegularStations.slice(halfIdx);

		// Find ready matches for each bracket
		const mainReady = tournament.brackets.main.matches.filter(m => m.topPlayerId && m.bottomPlayerId && !m.winnerId);
		const redReady = tournament.brackets.redemption.matches.filter(m => m.topPlayerId && m.bottomPlayerId && !m.winnerId);

		// Pick the highest-hype main match for stream (lowest combined seed = best players)
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

		// Assign remaining main stations
		let mainIdx = 0;
		for (const m of mainReady) {
			if (m.isStream) continue;
			if (mainIdx < mainStations.length) m.station = mainStations[mainIdx++];
		}
		// Assign redemption stations
		let redIdx = 0;
		for (const m of redReady) {
			if (redIdx < redemptionStations.length) m.station = redemptionStations[redIdx++];
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

		// Push bracket seeding to linked StartGG bracket events.
		// Uses pushBracketSeeding which matches players by player ID across events
		// (entrant IDs differ between Swiss and bracket events on StartGG).
		const swissPgId = tournament.startggPhase1Groups?.[0]?.id;
		console.log(`[StartGG] Bracket seeding: mainEvent=${tournament.startggMainBracketEventId} redEvent=${tournament.startggRedemptionBracketEventId} swissPgId=${swissPgId}`);
		const bracketEntrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
		for (const [bName, bEventId] of [
			['main', tournament.startggMainBracketEventId] as const,
			['redemption', tournament.startggRedemptionBracketEventId] as const
		]) {
			if (!bEventId || !tournament.brackets) {
				console.log(`[StartGG] Skipping ${bName} bracket seeding: eventId=${bEventId} hasBrackets=${!!tournament.brackets}`);
				continue;
			}
			if (!swissPgId) {
				console.log(`[StartGG] Skipping ${bName} bracket seeding: no Swiss phase group ID`);
				continue;
			}
			const bracket = tournament.brackets[bName];
			if (!bracket) continue;
			try {
				const epData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
					EVENT_PHASES_QUERY, { eventId: bEventId }
				);
				const bracketPhase = epData?.event?.phases?.[0];
				if (!bracketPhase) { console.log(`[StartGG] No phases in ${bName} bracket event ${bEventId}`); continue; }
				const bGroups = await fetchPhaseGroups(bracketPhase.id).catch(() => []);
				if (!bGroups.length) { console.log(`[StartGG] No phase groups in ${bName} bracket phase ${bracketPhase.id}`); continue; }
				const bPgId = bGroups[0].id;

				const rankedSwissEntrantIds = bracket.players
					.sort((a, b) => a.seed - b.seed)
					.map((p) => bracketEntrantMap.get(p.entrantId)?.startggEntrantId)
					.filter((id): id is number => id !== undefined);
				if (rankedSwissEntrantIds.length) {
					const result = await pushBracketSeeding(bracketPhase.id, bPgId, rankedSwissEntrantIds, swissPgId)
						.catch((e) => ({ ok: false as const, error: String(e) }));
					if (result.ok) {
						console.log(`[StartGG] Pushed ${bName} bracket seeding (${rankedSwissEntrantIds.length} players)`);

						// Trigger preview→real conversion via dummy report + reset
						// (same approach as Swiss round start)
						type PGData = { phaseGroup: { sets: { nodes: { id: unknown; slots: { entrant: { id: unknown } | null }[] }[] } } };
						const setsData = await gql<PGData>(PHASE_GROUP_SETS_QUERY, { phaseGroupId: bPgId }, { delay: 0 }).catch(() => null);
						const bSets = setsData?.phaseGroup?.sets?.nodes ?? [];
						const previewSet = bSets.find((s) =>
							String(s.id).startsWith('preview_') && s.slots?.length >= 2 && s.slots[0]?.entrant?.id && s.slots[1]?.entrant?.id
						);
						if (previewSet) {
							const dummyWinner = Number(previewSet.slots[0].entrant!.id);
							console.log(`[StartGG] Converting ${bName} bracket preview IDs via dummy report...`);
							const rep = await reportSet(String(previewSet.id), dummyWinner, {}).catch(() => ({ ok: false as const }));
							if (rep.ok) {
								const realId = rep.reportedSetId ?? String(previewSet.id);
								const rstResult = await resetSet(realId).catch((e) => ({ ok: false, error: String(e) }));
								console.log(`[StartGG] Reset dummy set ${realId}: ${rstResult.ok ? 'ok' : 'failed — ' + (rstResult as {error?:string}).error}`);
							} else {
								console.log(`[StartGG] Dummy report failed for ${bName} (may already be converted)`);
							}
						} else {
							console.log(`[StartGG] No preview sets found in ${bName} bracket (already converted)`);
						}
					} else {
						console.error(`[StartGG] ${bName} bracket seeding failed: ${result.error}`);
					}
				}
			} catch (e) {
				console.error(`[StartGG] ${bName} bracket seeding error: ${e}`);
			}
		}

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
		let finalStandingsSynced = false;
		if (tournament.startggFinalStandingsPhaseId && tournament.startggFinalStandingsPhaseGroupId) {
			const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
			const rankedEntrantIds = finalStandings
				.map((s) => entrantMap.get(s.entrantId)?.startggEntrantId)
				.filter((id): id is number => id !== undefined);
			if (rankedEntrantIds.length) {
				const result = await pushFinalStandingsSeeding(
					tournament.startggFinalStandingsPhaseId,
					tournament.startggFinalStandingsPhaseGroupId,
					rankedEntrantIds
				).catch((e) => ({ ok: false as const, error: String(e) }));
				finalStandingsSynced = result.ok;
				if (!result.ok) {
					console.error(`[StartGG] pushFinalStandingsSeeding failed: ${result.error}`);
				}
			}
		}

		// Auto-confirm split since bracket setup is fully automated now
		if (!tournament.startggSync) {
			tournament.startggSync = { splitConfirmed: true, pendingBracketMatchIds: [], errors: [] };
		} else {
			tournament.startggSync.splitConfirmed = true;
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

	// A "fix" is any change to an already-reported match (different winner OR different score).
	// This triggers pairing regeneration for the next active round.
	const wasMisreport = match.winnerId !== undefined;
	const winnerChanged = match.winnerId !== undefined && match.winnerId !== winnerId;
	match.winnerId = winnerId;
	if (isDQ) { match.isDQ = true; match.topScore = undefined; match.bottomScore = undefined; }
	else { match.isDQ = false; if (topScore !== undefined) match.topScore = topScore; if (bottomScore !== undefined) match.bottomScore = bottomScore; }

	// Report to StartGG — save match result immediately, then merge StartGG metadata.
	const sgResult = await reportSwissMatch(tournament, targetRound.number, match).catch(
		(e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })
	);

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
			// Merge any cached set IDs from conversion (other matches in this round)
			if (freshRound) {
				for (const m of targetRound.matches) {
					if (m.startggSetId) {
						const fm = freshRound.matches.find((fm) => fm.id === m.id);
						if (fm && !fm.startggSetId) fm.startggSetId = m.startggSetId;
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
				const streamRecs = recommendStreamMatches(pairingIds, standings, latestState.entrants, recentStreamIds);
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
				const roundGroup = latestState.startggPhase1Groups?.[nextRound.number - 1];
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
