import { describe, it } from 'vitest';
import { createRating, rate1v1, ratingToPoints, DEFAULT_SIGMA, SIGMA_FLOOR, POINTS_SCALE } from './trueskill';
import type { Rating } from './trueskill';
import { Redis } from '@upstash/redis';
import type { LeagueSeason, LeagueMatch } from '$lib/types/league';

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL!,
	token: process.env.UPSTASH_REDIS_REST_TOKEN!
});

async function getSeasonData(seasonId: number): Promise<LeagueSeason | null> {
	return redis.get<LeagueSeason>(`league:season:${seasonId}`);
}

interface MatchTrace {
	event: string;
	eventNumber: number;
	opponent: string;
	opponentMu: number;
	opponentSigma: number;
	won: boolean;
	muBefore: number;
	muAfter: number;
	sigmaBefore: number;
	sigmaAfter: number;
	delta: number;
	phase: string;
	roundLabel: string;
	isDQ: boolean;
}

function tracePlayer(
	season: LeagueSeason,
	playerId: string,
	passCount: number
): { traces: MatchTrace[][]; finalMu: number; finalSigma: number } {
	const events = season.events;
	const allMatches = season.matches;

	// Group matches by event
	const matchesByEvent = new Map<string, LeagueMatch[]>();
	for (const m of allMatches) {
		const arr = matchesByEvent.get(m.eventSlug) ?? [];
		arr.push(m);
		matchesByEvent.set(m.eventSlug, arr);
	}

	const allPassTraces: MatchTrace[][] = [];
	let prevRatings: Map<string, Rating> | undefined;

	for (let pass = 0; pass < passCount; pass++) {
		const ratings = new Map<string, Rating>();
		if (prevRatings) {
			for (const [id, r] of prevRatings) {
				ratings.set(id, createRating(r.mu, DEFAULT_SIGMA / 2));
			}
		}

		const passTraces: MatchTrace[] = [];

		for (const evt of events) {
			const eventMatches = matchesByEvent.get(evt.slug) ?? [];

			for (const m of eventMatches) {
				if (!ratings.has(m.player1Id)) ratings.set(m.player1Id, createRating());
				if (!ratings.has(m.player2Id)) ratings.set(m.player2Id, createRating());

				if (m.isDQ) continue;

				const r1 = ratings.get(m.player1Id)!;
				const r2 = ratings.get(m.player2Id)!;

				const isPlayer1 = m.player1Id === playerId;
				const isPlayer2 = m.player2Id === playerId;
				const isTarget = isPlayer1 || isPlayer2;

				const myRatingBefore = isPlayer1 ? r1 : r2;
				const oppRating = isPlayer1 ? r2 : r1;
				const won = m.winnerId === playerId;

				const result = m.winnerId === m.player1Id ? rate1v1(r1, r2) : rate1v1(r2, r1);
				if (m.winnerId === m.player1Id) {
					ratings.set(m.player1Id, result.winner);
					ratings.set(m.player2Id, result.loser);
				} else {
					ratings.set(m.player2Id, result.winner);
					ratings.set(m.player1Id, result.loser);
				}

				if (isTarget) {
					const myRatingAfter = ratings.get(playerId)!;
					passTraces.push({
						event: evt.slug,
						eventNumber: evt.eventNumber,
						opponent: isPlayer1 ? m.player2Tag : m.player1Tag,
						opponentMu: oppRating.mu,
						opponentSigma: oppRating.sigma,
						won,
						muBefore: myRatingBefore.mu,
						muAfter: myRatingAfter.mu,
						sigmaBefore: myRatingBefore.sigma,
						sigmaAfter: myRatingAfter.sigma,
						delta: ratingToPoints(myRatingAfter) - ratingToPoints(myRatingBefore),
						phase: m.phase,
						roundLabel: m.roundLabel,
						isDQ: !!m.isDQ
					});
				}
			}
		}

		allPassTraces.push(passTraces);
		prevRatings = ratings;
	}

	const finalRating = prevRatings!.get(playerId)!;
	return { traces: allPassTraces, finalMu: finalRating.mu, finalSigma: finalRating.sigma };
}

describe('Momonokill real data analysis', () => {
	it('trace Momo match-by-match in season 11', async () => {
		const season = await getSeasonData(11);
		if (!season) { console.log('Season 11 not found in Redis'); return; }

		// Find Momo
		const momoEntry = Object.entries(season.players).find(
			([, p]) => p.gamerTag.toLowerCase().includes('momo')
		);
		if (!momoEntry) { console.log('Momonokill not found in season 11'); return; }

		const [momoId, momoPlayer] = momoEntry;
		console.log(`\n=== Momonokill (${momoId}): ${momoPlayer.gamerTag} ===`);
		console.log(`Final stored rating: ${momoPlayer.points} pts (mu=${momoPlayer.mu.toFixed(3)}, σ=${momoPlayer.sigma.toFixed(3)})`);

		// Run 2-pass trace
		const { traces } = tracePlayer(season, momoId, 2);
		const pass2Traces = traces[1]; // Use pass 2 (the final one)

		// Group by event
		const eventGroups = new Map<string, MatchTrace[]>();
		for (const t of pass2Traces) {
			const arr = eventGroups.get(t.event) ?? [];
			arr.push(t);
			eventGroups.set(t.event, arr);
		}

		console.log('\n--- Pass 2 (final) match-by-match ---');
		let runningPts = 0;
		let firstEvent = true;
		for (const [slug, matches] of eventGroups) {
			const wins = matches.filter(m => m.won).length;
			const losses = matches.filter(m => !m.won).length;
			const eventDelta = matches.reduce((sum, m) => sum + m.delta, 0);
			const startPts = ratingToPoints({ mu: matches[0].muBefore, sigma: matches[0].sigmaBefore });
			const endPts = ratingToPoints({ mu: matches[matches.length - 1].muAfter, sigma: matches[matches.length - 1].sigmaAfter });

			if (firstEvent) { runningPts = startPts; firstEvent = false; }

			const shortSlug = slug.replace('microspacing-vancouver-', 'MSV#').replace('macrospacing-vancouver-', 'MACRO#');
			const isMacro = slug.includes('macro');
			console.log(`\n${shortSlug}${isMacro ? ' [MACRO]' : ''}: ${wins}W-${losses}L | ${startPts} → ${endPts} pts (${eventDelta >= 0 ? '+' : ''}${eventDelta})`);

			for (const m of matches) {
				const oppPts = ratingToPoints({ mu: m.opponentMu, sigma: m.opponentSigma });
				const myPts = ratingToPoints({ mu: m.muBefore, sigma: m.sigmaBefore });
				const ratingGap = myPts - oppPts;
				console.log(
					`  ${m.won ? 'W' : 'L'} vs ${m.opponent.padEnd(18)} ` +
					`(opp: ${String(oppPts).padStart(5)}pts, gap: ${(ratingGap >= 0 ? '+' : '') + ratingGap}) ` +
					`Δ${(m.delta >= 0 ? '+' : '') + m.delta}  ` +
					`[${m.phase} ${m.roundLabel}] ` +
					`σ=${m.sigmaBefore.toFixed(2)}→${m.sigmaAfter.toFixed(2)}`
				);
			}

			runningPts = endPts;
		}

		// Summary stats
		const totalWins = pass2Traces.filter(t => t.won).length;
		const totalLosses = pass2Traces.filter(t => !t.won).length;
		const totalDelta = pass2Traces.reduce((sum, t) => sum + t.delta, 0);

		// Wins against higher-rated vs lower-rated
		const winsVsHigher = pass2Traces.filter(t => t.won && t.opponentMu > t.muBefore).length;
		const winsVsLower = pass2Traces.filter(t => t.won && t.opponentMu <= t.muBefore).length;
		const lossesVsHigher = pass2Traces.filter(t => !t.won && t.opponentMu > t.muBefore).length;
		const lossesVsLower = pass2Traces.filter(t => !t.won && t.opponentMu <= t.muBefore).length;

		// Average delta per win vs per loss
		const avgWinDelta = pass2Traces.filter(t => t.won).reduce((sum, t) => sum + t.delta, 0) / totalWins;
		const avgLossDelta = pass2Traces.filter(t => !t.won).reduce((sum, t) => sum + t.delta, 0) / totalLosses;

		// Macro vs Micro breakdown
		const macroTraces = pass2Traces.filter(t => t.event.includes('macro'));
		const microTraces = pass2Traces.filter(t => !t.event.includes('macro'));
		const macroDelta = macroTraces.reduce((sum, t) => sum + t.delta, 0);
		const microDelta = microTraces.reduce((sum, t) => sum + t.delta, 0);
		const macroWins = macroTraces.filter(t => t.won).length;
		const macroLosses = macroTraces.filter(t => !t.won).length;

		console.log('\n=== SUMMARY ===');
		console.log(`Record: ${totalWins}W-${totalLosses}L (${(totalWins / (totalWins + totalLosses) * 100).toFixed(1)}% WR)`);
		console.log(`Total Δ: ${totalDelta >= 0 ? '+' : ''}${totalDelta} pts`);
		console.log(`Avg win Δ: ${avgWinDelta.toFixed(1)} pts | Avg loss Δ: ${avgLossDelta.toFixed(1)} pts`);
		console.log(`Wins vs higher-rated: ${winsVsHigher} | Wins vs lower-rated: ${winsVsLower}`);
		console.log(`Losses vs higher-rated: ${lossesVsHigher} | Losses vs lower-rated: ${lossesVsLower}`);
		if (macroTraces.length > 0) {
			console.log(`\nMacro events: ${macroWins}W-${macroLosses}L, Δ${macroDelta >= 0 ? '+' : ''}${macroDelta} pts`);
			console.log(`Micro events: ${microTraces.filter(t => t.won).length}W-${microTraces.filter(t => !t.won).length}L, Δ${microDelta >= 0 ? '+' : ''}${microDelta} pts`);
		}

		// Per-event trajectory
		console.log('\n=== EVENT TRAJECTORY ===');
		let prevEndPts = 0;
		for (const [slug, matches] of eventGroups) {
			const startPts = ratingToPoints({ mu: matches[0].muBefore, sigma: matches[0].sigmaBefore });
			const endPts = ratingToPoints({ mu: matches[matches.length - 1].muAfter, sigma: matches[matches.length - 1].sigmaAfter });
			const shortSlug = slug.replace('microspacing-vancouver-', 'MSV#').replace('macrospacing-vancouver-', 'MACRO#');
			const wins = matches.filter(m => m.won).length;
			const losses = matches.filter(m => !m.won).length;
			if (prevEndPts === 0) prevEndPts = startPts;
			console.log(`${shortSlug.padEnd(12)} ${String(endPts).padStart(5)}pts  ${wins}W-${losses}L  Δ${((endPts - startPts) >= 0 ? '+' : '') + (endPts - startPts)}`);
			prevEndPts = endPts;
		}
	});

	it('compare pass 1 vs pass 2 for Momo', async () => {
		const season = await getSeasonData(11);
		if (!season) return;

		const momoEntry = Object.entries(season.players).find(
			([, p]) => p.gamerTag.toLowerCase().includes('momo')
		);
		if (!momoEntry) return;
		const [momoId] = momoEntry;

		const { traces } = tracePlayer(season, momoId, 2);

		// Compare event-end points between passes
		console.log('\n=== Pass 1 vs Pass 2 event trajectory ===');
		console.log('Event        | Pass 1 end | Pass 2 end | Difference');
		console.log('-------------|------------|------------|----------');

		for (const passIdx of [0, 1]) {
			const eventGroups = new Map<string, MatchTrace[]>();
			for (const t of traces[passIdx]) {
				const arr = eventGroups.get(t.event) ?? [];
				arr.push(t);
				eventGroups.set(t.event, arr);
			}
		}

		// Build event-end maps for both passes
		const pass1Ends = new Map<string, number>();
		const pass2Ends = new Map<string, number>();

		for (const t of traces[0]) {
			pass1Ends.set(t.event, ratingToPoints({ mu: t.muAfter, sigma: t.sigmaAfter }));
		}
		for (const t of traces[1]) {
			pass2Ends.set(t.event, ratingToPoints({ mu: t.muAfter, sigma: t.sigmaAfter }));
		}

		for (const slug of pass1Ends.keys()) {
			const p1 = pass1Ends.get(slug)!;
			const p2 = pass2Ends.get(slug)!;
			const shortSlug = slug.replace('microspacing-vancouver-', 'MSV#').replace('macrospacing-vancouver-', 'MACRO#');
			console.log(`${shortSlug.padEnd(13)}| ${String(p1).padStart(10)} | ${String(p2).padStart(10)} | ${((p2 - p1) >= 0 ? '+' : '') + (p2 - p1)}`);
		}
	});

	it('analyze macro vs micro impact across all players', async () => {
		const season = await getSeasonData(11);
		if (!season) return;

		const events = season.events;
		const allMatches = season.matches;

		const macroSlugs = new Set(events.filter(e => e.slug.includes('macro')).map(e => e.slug));
		const microSlugs = new Set(events.filter(e => !e.slug.includes('macro')).map(e => e.slug));

		if (macroSlugs.size === 0) {
			console.log('No macro events in season 11');
			return;
		}

		console.log(`\n=== Macro vs Micro analysis ===`);
		console.log(`Macro events (${macroSlugs.size}): ${[...macroSlugs].map(s => s.replace('macrospacing-vancouver-', 'MACRO#')).join(', ')}`);
		console.log(`Micro events (${microSlugs.size}): ${[...microSlugs].map(s => s.replace('microspacing-vancouver-', 'MSV#')).join(', ')}`);

		// Count entrants per event type
		const macroEvents = events.filter(e => macroSlugs.has(e.slug));
		const microEvents = events.filter(e => microSlugs.has(e.slug));

		const avgMacroEntrants = macroEvents.reduce((sum, e) => sum + e.entrantCount, 0) / macroEvents.length;
		const avgMicroEntrants = microEvents.reduce((sum, e) => sum + e.entrantCount, 0) / microEvents.length;

		console.log(`Avg macro entrants: ${avgMacroEntrants.toFixed(0)}`);
		console.log(`Avg micro entrants: ${avgMicroEntrants.toFixed(0)}`);

		// Matches per event type
		const macroMatches = allMatches.filter(m => macroSlugs.has(m.eventSlug));
		const microMatches = allMatches.filter(m => microSlugs.has(m.eventSlug));
		console.log(`Macro matches: ${macroMatches.length} (${(macroMatches.length / macroSlugs.size).toFixed(0)}/event)`);
		console.log(`Micro matches: ${microMatches.length} (${(microMatches.length / microSlugs.size).toFixed(0)}/event)`);

		// Run TrueSkill and see how much macro events move ratings vs micro
		const ratings = new Map<string, Rating>();
		const macroDeltas = new Map<string, number>(); // player -> total macro delta
		const microDeltas = new Map<string, number>(); // player -> total micro delta

		for (const evt of events) {
			const eventMatches = allMatches.filter(m => m.eventSlug === evt.slug);
			const isMacro = macroSlugs.has(evt.slug);

			for (const m of eventMatches) {
				if (!ratings.has(m.player1Id)) ratings.set(m.player1Id, createRating());
				if (!ratings.has(m.player2Id)) ratings.set(m.player2Id, createRating());
				if (m.isDQ) continue;

				const r1 = ratings.get(m.player1Id)!;
				const r2 = ratings.get(m.player2Id)!;
				const p1Before = ratingToPoints(r1);
				const p2Before = ratingToPoints(r2);

				const result = m.winnerId === m.player1Id ? rate1v1(r1, r2) : rate1v1(r2, r1);
				if (m.winnerId === m.player1Id) {
					ratings.set(m.player1Id, result.winner);
					ratings.set(m.player2Id, result.loser);
				} else {
					ratings.set(m.player2Id, result.winner);
					ratings.set(m.player1Id, result.loser);
				}

				const p1After = ratingToPoints(ratings.get(m.player1Id)!);
				const p2After = ratingToPoints(ratings.get(m.player2Id)!);
				const deltaMap = isMacro ? macroDeltas : microDeltas;

				deltaMap.set(m.player1Id, (deltaMap.get(m.player1Id) ?? 0) + (p1After - p1Before));
				deltaMap.set(m.player2Id, (deltaMap.get(m.player2Id) ?? 0) + (p2After - p2Before));
			}
		}

		// Top 20 players by final rating, show macro vs micro contribution
		const ranked = [...ratings.entries()]
			.map(([id, r]) => ({
				id,
				tag: season.players[id]?.gamerTag ?? id,
				pts: ratingToPoints(r),
				macroDelta: macroDeltas.get(id) ?? 0,
				microDelta: microDeltas.get(id) ?? 0
			}))
			.sort((a, b) => b.pts - a.pts)
			.slice(0, 25);

		console.log('\n--- Top 25 players: macro vs micro point contribution (pass 1 only) ---');
		console.log('Rank | Player              | Total   | Micro Δ | Macro Δ | Macro %');
		console.log('-----|---------------------|---------|---------|---------|--------');
		for (let i = 0; i < ranked.length; i++) {
			const p = ranked[i];
			const total = p.macroDelta + p.microDelta;
			const macroPct = total !== 0 ? ((p.macroDelta / Math.abs(total)) * 100).toFixed(0) : '0';
			console.log(
				`  ${String(i + 1).padStart(2)}  | ${p.tag.padEnd(19)} | ${String(p.pts).padStart(5)}   | ${(p.microDelta >= 0 ? '+' : '') + String(p.microDelta).padStart(5)} | ${(p.macroDelta >= 0 ? '+' : '') + String(p.macroDelta).padStart(5)} | ${macroPct}%`
			);
		}
	});
});
