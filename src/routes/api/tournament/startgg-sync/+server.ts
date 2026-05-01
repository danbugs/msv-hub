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
import { env } from '$env/dynamic/private';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { flushPendingBracketMatches } from '$lib/server/startgg-reporter';
import { pushBracketSeeding, gql, EVENT_PHASES_QUERY, TOURNAMENT_QUERY, fetchPhaseGroups } from '$lib/server/startgg';
import { assignBracketSplit, getTournamentParticipants, updateParticipantEvents } from '$lib/server/startgg-admin';
import { sendMessage } from '$lib/server/discord';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const announceChannel = ((body as { announceChannel?: string }).announceChannel ?? '').trim();

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (tournament.phase !== 'brackets' && tournament.phase !== 'completed') {
		return Response.json({ error: 'Tournament is not in brackets phase' }, { status: 400 });
	}
	if (!tournament.brackets) {
		return Response.json({ error: 'No brackets generated' }, { status: 400 });
	}

	const isGauntlet = tournament.mode === 'gauntlet';

	if (!isGauntlet && !tournament.finalStandings) {
		return Response.json({ error: 'No final standings' }, { status: 400 });
	}

	const logs: string[] = [];
	const log = (msg: string) => { logs.push(msg); console.log(`[split-done] ${msg}`); };

	// Step 1: Auto-assign players to bracket events on StartGG
	const swissEventId = tournament.startggEventId;
	let mainEventId = tournament.startggMainBracketEventId;
	let redEventId = tournament.startggRedemptionBracketEventId;
	const eventSlug = tournament.startggEventSlug;

	const hasGauntletRedemption = isGauntlet && !!tournament.brackets.redemption;

	// Auto-discover bracket events if not yet linked
	if (eventSlug && (!mainEventId || (!isGauntlet && !redEventId) || (hasGauntletRedemption && !redEventId))) {
		const tournamentSlug = eventSlug.match(/tournament\/([^/]+)/)?.[1];
		if (tournamentSlug) {
			const tData = await gql<{ tournament: { events: { id: number; name: string; numEntrants: number }[] } }>(
				TOURNAMENT_QUERY, { slug: tournamentSlug }
			);
			const allEvents = tData?.tournament?.events ?? [];
			const otherEvents = allEvents.filter((e) => e.id !== swissEventId);
			if (!mainEventId) {
				const mainEvt = otherEvents.find((e) => /main/i.test(e.name));
				if (mainEvt) { mainEventId = mainEvt.id; tournament.startggMainBracketEventId = mainEvt.id; log(`Auto-linked main: ${mainEvt.name} (${mainEvt.id})`); }
			}
			if (!redEventId) {
				const redEvt = otherEvents.find((e) => /redemption/i.test(e.name));
				if (redEvt) { redEventId = redEvt.id; tournament.startggRedemptionBracketEventId = redEvt.id; log(`Auto-linked redemption: ${redEvt.name} (${redEvt.id})`); }
			}
			if (!mainEventId && !redEventId && otherEvents.length === 2) {
				const sorted = [...otherEvents].sort((a, b) => b.numEntrants - a.numEntrants);
				mainEventId = sorted[0].id; tournament.startggMainBracketEventId = sorted[0].id;
				redEventId = sorted[1].id; tournament.startggRedemptionBracketEventId = sorted[1].id;
				log(`Auto-linked by size: main=${sorted[0].name}, redemption=${sorted[1].name}`);
			}
		}
	}

	let splitResult = { mainOk: 0, redemptionOk: 0, failed: 0, errors: [] as string[] };

	if (isGauntlet) {
		// Gauntlet: move ALL players to main bracket event
		if (swissEventId && mainEventId && eventSlug) {
			const tournamentSlug = eventSlug.match(/tournament\/([^/]+)/)?.[1];
			if (tournamentSlug) {
				const allTags = tournament.entrants.map((e) => e.gamerTag);
				log(`Gauntlet: assigning all ${allTags.length} players to Main bracket...`);
				splitResult = await assignBracketSplit(
					tournamentSlug, swissEventId, mainEventId,
					redEventId ?? mainEventId,
					allTags, [], log
				);

				// If redemption bracket exists, add eliminated players to redemption event
				if (hasGauntletRedemption && redEventId) {
					const redemptionBracket = tournament.brackets.redemption!;
					const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e]));
					const redTags = new Set(
						redemptionBracket.players
							.map((p) => entrantMap.get(p.entrantId)?.gamerTag?.toLowerCase())
							.filter((t): t is string => !!t)
					);
					log(`Gauntlet: adding ${redTags.size} eliminated players to Redemption event...`);

					const redPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
						EVENT_PHASES_QUERY, { eventId: redEventId }
					);
					const redPhaseId = redPhaseData?.event?.phases?.[0]?.id;

					const participants = await getTournamentParticipants(tournamentSlug);
					let redOk = 0;
					for (const p of participants) {
						if (!redTags.has(p.gamerTag.toLowerCase())) continue;
						if (p.currentEventIds.includes(redEventId)) { redOk++; continue; }
						const newEvents = [...new Set([...p.currentEventIds, redEventId])];
						const phaseDests = redPhaseId ? [{ eventId: redEventId, phaseId: redPhaseId }] : [];
						const result = await updateParticipantEvents(p.participantId, newEvents, phaseDests);
						if (result.ok) { redOk++; log(`  ✓ ${p.gamerTag} → +Redemption`); }
						else { splitResult.failed++; log(`  ✗ ${p.gamerTag}: ${result.error}`); }
					}
					splitResult.redemptionOk = redOk;
				}
			}
		} else {
			log('Skipping auto-assign: missing event IDs');
		}
	} else {
		// Default: split players into main and redemption
		if (swissEventId && mainEventId && redEventId && eventSlug && tournament.finalStandings) {
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
	}

	// Step 2: Push bracket seeding + trigger conversion
	let swissPgId = tournament.startggPhase1Groups?.[0]?.id;
	if (!swissPgId && eventSlug) {
		const swissPhaseData = await gql<{ event: { phases: { id: number }[] } }>(
			EVENT_PHASES_QUERY, { eventId: swissEventId }
		);
		const swissPhaseId = swissPhaseData?.event?.phases?.[0]?.id;
		if (swissPhaseId) {
			const groups = await fetchPhaseGroups(swissPhaseId).catch(() => []);
			if (groups.length) {
				swissPgId = groups[0].id;
				tournament.startggPhase1Groups = groups.map((g) => ({ ...g, phaseId: swissPhaseId, roundNumber: 1 }));
				log(`Resolved Swiss phase group: ${swissPgId}`);
			}
		}
	}
	if (!swissPgId) log('WARNING: Could not resolve Swiss phase group — seeding will not be pushed');
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

	// Step 4: Optionally announce bracket start to Discord.
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
		const tSlugMatch = eventSlug?.match(/^(tournament\/[^/]+)/);
		const tournamentUrl = tSlugMatch ? `https://start.gg/${tSlugMatch[1]}` : '';
		const lines = ['🏆 Brackets are starting!'];
		if (tournamentUrl) lines.push(`Bracket on StartGG: ${tournamentUrl}`);
		if (appUrl) lines.push(`MSV Hub live: ${appUrl}/live/${tournament.slug}`);
		await sendMessage(channelId, lines.join('\n')).catch(() => { /* best-effort */ });
	}

	// Concurrency-safe save: reload from Redis and merge bracket match results.
	// The sync takes a long time (many API calls); matches may have been reported
	// concurrently via the bracket PATCH endpoint. Without merging, we'd overwrite them.
	const fresh = await getActiveTournament();
	if (fresh?.brackets) {
		for (const bn of ['main', 'redemption'] as const) {
			const ourBracket = tournament.brackets?.[bn];
			const freshBracket = fresh.brackets[bn];
			if (!ourBracket || !freshBracket) continue;
			for (let i = 0; i < freshBracket.matches.length; i++) {
				const fm = freshBracket.matches[i];
				const om = ourBracket.matches.find((m) => m.id === fm.id);
				if (!om) continue;
				// Keep whichever has a winner (prefer fresh = concurrently reported)
				if (fm.winnerId) continue;
				if (om.winnerId) freshBracket.matches[i] = om;
			}
		}
		// Carry over sync state and metadata from our run
		if (!fresh.startggSync) {
			fresh.startggSync = { splitConfirmed: true, pendingBracketMatchIds: [], errors: [] };
		} else {
			fresh.startggSync.splitConfirmed = true;
			fresh.startggSync.pendingBracketMatchIds = tournament.startggSync?.pendingBracketMatchIds ?? [];
			fresh.startggSync.errors = tournament.startggSync?.errors ?? [];
		}
		fresh.startggMainBracketEventId = tournament.startggMainBracketEventId;
		fresh.startggRedemptionBracketEventId = tournament.startggRedemptionBracketEventId;
		fresh.startggPhase1Groups = tournament.startggPhase1Groups;
		await saveTournament(fresh);
	} else {
		if (!tournament.startggSync) {
			tournament.startggSync = { splitConfirmed: true, pendingBracketMatchIds: [], errors: [] };
		} else {
			tournament.startggSync.splitConfirmed = true;
		}
		await saveTournament(tournament);
	}

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
