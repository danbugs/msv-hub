import { describe, it, expect } from 'vitest';
import { createRating, rate1v1, ratingToPoints, DEFAULT_SIGMA } from './trueskill';
import type { Rating } from './trueskill';

/**
 * Simulate a season resembling MSV: ~40 players, ~13 events, ~50 matches/event.
 * Measure how many multi-pass iterations it takes for mu values to stabilize.
 */

// Deterministic pseudo-random (xorshift32) so tests are reproducible
function makeRng(seed: number) {
	let s = seed | 0;
	return () => {
		s ^= s << 13;
		s ^= s >> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

interface SimMatch {
	player1: number;
	player2: number;
	winner: number; // index of winner
	event: number;
}

function generateSeason(
	playerCount: number,
	eventCount: number,
	matchesPerEvent: number,
	seed: number
): { matches: SimMatch[]; trueSkills: number[] } {
	const rng = makeRng(seed);
	// Assign "true" skill levels (spread across a realistic range)
	const trueSkills = Array.from({ length: playerCount }, () => 15 + rng() * 20); // mu 15-35

	const matches: SimMatch[] = [];
	for (let evt = 0; evt < eventCount; evt++) {
		// Each event: subset of players (70-100% attend)
		const attending = Array.from({ length: playerCount }, (_, i) => i)
			.filter(() => rng() > 0.15);

		for (let m = 0; m < matchesPerEvent && attending.length >= 2; m++) {
			const i = Math.floor(rng() * attending.length);
			let j = Math.floor(rng() * (attending.length - 1));
			if (j >= i) j++;
			const p1 = attending[i];
			const p2 = attending[j];

			// Winner determined probabilistically by true skill difference
			const diff = trueSkills[p1] - trueSkills[p2];
			const winProb = 1 / (1 + Math.exp(-diff / 4)); // logistic based on skill gap
			const winner = rng() < winProb ? p1 : p2;

			matches.push({ player1: p1, player2: p2, winner, event: evt });
		}
	}
	return { matches, trueSkills };
}

function runPass(
	matches: SimMatch[],
	eventCount: number,
	initialRatings?: Map<number, Rating>,
	resetSigma?: number
): Map<number, Rating> {
	const ratings = new Map<number, Rating>();
	if (initialRatings && resetSigma) {
		for (const [id, r] of initialRatings) {
			ratings.set(id, createRating(r.mu, resetSigma));
		}
	}

	for (let evt = 0; evt < eventCount; evt++) {
		const eventMatches = matches.filter((m) => m.event === evt);
		for (const m of eventMatches) {
			if (!ratings.has(m.player1)) ratings.set(m.player1, createRating());
			if (!ratings.has(m.player2)) ratings.set(m.player2, createRating());

			const r1 = ratings.get(m.player1)!;
			const r2 = ratings.get(m.player2)!;

			const result = m.winner === m.player1 ? rate1v1(r1, r2) : rate1v1(r2, r1);
			if (m.winner === m.player1) {
				ratings.set(m.player1, result.winner);
				ratings.set(m.player2, result.loser);
			} else {
				ratings.set(m.player2, result.winner);
				ratings.set(m.player1, result.loser);
			}
		}
	}
	return ratings;
}

function computeMaxDelta(a: Map<number, Rating>, b: Map<number, Rating>): {
	maxDeltaMu: number;
	maxDeltaPoints: number;
	avgDeltaPoints: number;
	playerId: number;
} {
	let maxDeltaMu = 0;
	let maxDeltaPoints = 0;
	let totalDelta = 0;
	let count = 0;
	let playerId = -1;

	for (const [id, rB] of b) {
		const rA = a.get(id);
		if (!rA) continue;
		const dMu = Math.abs(rA.mu - rB.mu);
		const dPts = Math.abs(ratingToPoints(rA) - ratingToPoints(rB));
		if (dMu > maxDeltaMu) {
			maxDeltaMu = dMu;
			maxDeltaPoints = dPts;
			playerId = id;
		}
		totalDelta += dPts;
		count++;
	}

	return { maxDeltaMu, maxDeltaPoints, avgDeltaPoints: count > 0 ? totalDelta / count : 0, playerId };
}

describe('TrueSkill multi-pass convergence', () => {
	// MSV-like parameters
	const PLAYER_COUNT = 45;
	const EVENT_COUNT = 13;
	const MATCHES_PER_EVENT = 50;

	it('measures convergence across passes (MSV-scale season)', () => {
		const { matches } = generateSeason(PLAYER_COUNT, EVENT_COUNT, MATCHES_PER_EVENT, 42);

		const MAX_PASSES = 20;
		const passResults: Map<number, Rating>[] = [];
		const deltas: { pass: number; maxDeltaPoints: number; avgDeltaPoints: number; maxDeltaMu: number }[] = [];

		let prevRatings: Map<number, Rating> | undefined;

		for (let pass = 1; pass <= MAX_PASSES; pass++) {
			const ratings = runPass(
				matches,
				EVENT_COUNT,
				prevRatings,
				prevRatings ? DEFAULT_SIGMA / 2 : undefined
			);
			passResults.push(ratings);

			if (prevRatings) {
				// Compare final mu of this pass vs previous pass's FINAL mu (not the reset sigma version)
				const prevFinal = passResults[passResults.length - 2];
				const delta = computeMaxDelta(prevFinal, ratings);
				deltas.push({ pass, ...delta });
			}

			prevRatings = ratings;
		}

		console.log('\n=== Multi-pass convergence (MSV-scale: 45 players, 13 events, 50 matches/event) ===');
		console.log('Pass | Max Δ pts | Avg Δ pts | Max Δ mu');
		console.log('-----|----------|----------|--------');
		for (const d of deltas) {
			console.log(
				`  ${String(d.pass).padStart(2)}  |  ${String(d.maxDeltaPoints).padStart(6)}   |  ${d.avgDeltaPoints.toFixed(1).padStart(6)}   | ${d.maxDeltaMu.toFixed(4)}`
			);
		}

		// Find convergence point (max delta < 1 point)
		const convergedAt = deltas.findIndex((d) => d.maxDeltaPoints < 1);
		console.log(`\nConverged (max Δ < 1pt) at pass: ${convergedAt >= 0 ? deltas[convergedAt].pass : 'NOT within ' + MAX_PASSES}`);

		// Find convergence point (max delta < 10 points)
		const roughConvergedAt = deltas.findIndex((d) => d.maxDeltaPoints < 10);
		console.log(`Rough convergence (max Δ < 10pt) at pass: ${roughConvergedAt >= 0 ? deltas[roughConvergedAt].pass : 'NOT within ' + MAX_PASSES}`);

		// The test should at least show convergence within 20 passes
		const lastDelta = deltas[deltas.length - 1];
		expect(lastDelta.maxDeltaPoints).toBeLessThan(50);
	});

	it('measures convergence across 3 different season seeds', () => {
		for (const seed of [42, 123, 7777]) {
			const { matches } = generateSeason(PLAYER_COUNT, EVENT_COUNT, MATCHES_PER_EVENT, seed);

			const MAX_PASSES = 25;
			const deltas: { pass: number; maxDeltaPoints: number; avgDeltaPoints: number }[] = [];
			let prevRatings: Map<number, Rating> | undefined;
			let prevFinalRatings: Map<number, Rating> | undefined;

			for (let pass = 1; pass <= MAX_PASSES; pass++) {
				const ratings = runPass(
					matches, EVENT_COUNT,
					prevRatings, prevRatings ? DEFAULT_SIGMA / 2 : undefined
				);

				if (prevFinalRatings) {
					const delta = computeMaxDelta(prevFinalRatings, ratings);
					deltas.push({ pass, maxDeltaPoints: delta.maxDeltaPoints, avgDeltaPoints: delta.avgDeltaPoints });
				}

				prevFinalRatings = ratings;
				prevRatings = ratings;
			}

			const convergedAt1 = deltas.findIndex((d) => d.maxDeltaPoints < 1);
			const convergedAt5 = deltas.findIndex((d) => d.maxDeltaPoints < 5);
			console.log(
				`\nSeed ${seed}: converged <1pt at pass ${convergedAt1 >= 0 ? deltas[convergedAt1].pass : '>25'}, ` +
				`<5pt at pass ${convergedAt5 >= 0 ? deltas[convergedAt5].pass : '>25'}, ` +
				`final max Δ = ${deltas[deltas.length - 1].maxDeltaPoints}pt`
			);
		}
	});

	it('compares accuracy against true skill at different pass counts', () => {
		const { matches, trueSkills } = generateSeason(PLAYER_COUNT, EVENT_COUNT, MATCHES_PER_EVENT, 42);

		// Normalize true skills to the same scale as TrueSkill points
		const trueMin = Math.min(...trueSkills);
		const trueMax = Math.max(...trueSkills);

		const passesToTest = [1, 2, 3, 5, 8, 10, 15, 20];
		console.log('\n=== Accuracy vs true skill at different pass counts ===');
		console.log('Passes | Rank correlation | Avg |mu - true| (normalized)');
		console.log('-------|-----------------|-----------------------------');

		for (const targetPass of passesToTest) {
			let prevRatings: Map<number, Rating> | undefined;
			let ratings: Map<number, Rating> = new Map();

			for (let pass = 1; pass <= targetPass; pass++) {
				ratings = runPass(
					matches, EVENT_COUNT,
					prevRatings, prevRatings ? DEFAULT_SIGMA / 2 : undefined
				);
				prevRatings = ratings;
			}

			// Compare estimated rankings vs true skill rankings
			const estimated = [...ratings.entries()]
				.map(([id, r]) => ({ id, mu: r.mu }))
				.sort((a, b) => b.mu - a.mu);
			const trueRanked = trueSkills
				.map((s, i) => ({ id: i, skill: s }))
				.filter((t) => ratings.has(t.id))
				.sort((a, b) => b.skill - a.skill);

			// Spearman rank correlation
			const estRanks = new Map(estimated.map((e, i) => [e.id, i + 1]));
			const trueRanks = new Map(trueRanked.map((t, i) => [t.id, i + 1]));
			const n = estimated.length;
			let d2sum = 0;
			for (const [id, estRank] of estRanks) {
				const trueRank = trueRanks.get(id) ?? n;
				d2sum += (estRank - trueRank) ** 2;
			}
			const rho = 1 - (6 * d2sum) / (n * (n * n - 1));

			// Average normalized mu error
			let totalErr = 0;
			let count = 0;
			for (const [id, r] of ratings) {
				const trueNorm = (trueSkills[id] - trueMin) / (trueMax - trueMin);
				const muNorm = (r.mu - 15) / 20; // rough normalization to same scale
				totalErr += Math.abs(trueNorm - muNorm);
				count++;
			}

			console.log(
				`   ${String(targetPass).padStart(2)}   |     ${rho.toFixed(4)}      |         ${(totalErr / count).toFixed(4)}`
			);
		}
	});
});
