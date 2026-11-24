/**
 * Split-start brackets (some seeds start in losers) must have the same shape as the
 * bracket StartGG builds for the same split, because results are reported to StartGG
 * by player pair: if the hub pairs two players StartGG doesn't, the report has nowhere
 * to go.
 *
 * The fixtures are StartGG's own preview brackets, captured from the test tournament
 * for a range of sizes and splits.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	generateBracket, reportBracketMatch, computeBracketRecords,
	isSplitRedemptionReady, generateSplitRedemption
} from './swiss';
import { computeWaves, dependencyRoundOrder } from '$lib/waves';
import type { BracketState } from '$lib/types/tournament';

const FIXTURE_DIRS = [
	path.resolve(import.meta.dirname, 'test-fixtures/split-layouts'),
	...(process.env.SPLIT_LAYOUT_DIR ? [process.env.SPLIT_LAYOUT_DIR] : [])
];

type Slot = { type: 'seed'; rank: number } | { type: 'bye' } | { type: 'set'; id: string; cond: string };
type Layout = { N: number; W: number; sets: { id: string; text: string; slots: [Slot, Slot] }[] };

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const key = (a: string, b: string) => hash([a, b].sort().join('|'));

/** Shape of a bracket as a set of playable matches, each named by who can end up in it. */
function shapeOfLayout(layout: Layout): { final: string | null; matches: Set<string>; firstRound: string[] } {
	const byId = new Map(layout.sets.map((s) => [s.id, s]));
	const matches = new Set<string>();
	const firstRound: string[] = [];
	const memo = new Map<string, { w: string | null; l: string | null }>();
	function resolve(id: string): { w: string | null; l: string | null } {
		const hit = memo.get(id);
		if (hit) return hit;
		const set = byId.get(id)!;
		const ins = set.slots.map((sl) => {
			if (sl.type === 'seed') return `s${sl.rank}`;
			if (sl.type === 'bye') return null;
			const r = resolve(sl.id);
			return sl.cond === 'loser' ? r.l : r.w;
		}).filter((x): x is string => x !== null);
		let out: { w: string | null; l: string | null };
		if (ins.length === 2) {
			const k = key(ins[0], ins[1]);
			matches.add(k);
			if (ins.every((i) => i.startsWith('s'))) firstRound.push([...ins].sort().join(' v '));
			out = { w: `W${k}`, l: `L${k}` };
		} else out = { w: ins[0] ?? null, l: null };
		memo.set(id, out);
		return out;
	}
	const gf = layout.sets.find((s) => s.text === 'Grand Final')!;
	for (const s of layout.sets) if (s.text !== 'Grand Final Reset') resolve(s.id);
	return { final: resolve(gf.id).w, matches, firstRound: firstRound.sort() };
}

function shapeOfBracket(b: BracketState): { final: string | null; matches: Set<string>; firstRound: string[] } {
	const seedOf = new Map(b.players.map((p) => [p.entrantId, p.seed]));
	const matches = new Set<string>();
	const firstRound: string[] = [];
	const memo = new Map<string, { w: string | null; l: string | null }>();
	function resolve(id: string): { w: string | null; l: string | null } {
		const hit = memo.get(id);
		if (hit) return hit;
		const m = b.matches.find((x) => x.id === id)!;
		const ins: string[] = [];
		for (const pid of [m.topPlayerId, m.bottomPlayerId]) if (pid) ins.push(`s${seedOf.get(pid)}`);
		for (const f of b.matches) {
			if (f.winnerId) continue;
			if (f.winnerNextMatchId === id) { const r = resolve(f.id).w; if (r) ins.push(r); }
			if (f.loserNextMatchId === id) { const r = resolve(f.id).l; if (r) ins.push(r); }
		}
		let out: { w: string | null; l: string | null };
		if (ins.length === 2) {
			const k = key(ins[0], ins[1]);
			matches.add(k);
			if (ins.every((i) => i.startsWith('s'))) firstRound.push([...ins].sort().join(' v '));
			out = { w: `W${k}`, l: `L${k}` };
		} else {
			expect(ins.length).toBeLessThan(2);
			out = { w: ins[0] ?? null, l: null };
		}
		memo.set(id, out);
		return out;
	}
	for (const m of b.matches) if (!m.winnerId) resolve(m.id);
	const gf = b.matches.find((m) => m.id.includes('-GF-'))!;
	return { final: resolve(gf.id).w, matches, firstRound: firstRound.sort() };
}

function makeBracket(n: number, winners: number): BracketState {
	const players = Array.from({ length: n }, (_, i) => ({ entrantId: `p${i + 1}`, seed: i + 1 }));
	return generateBracket('main', players, [], undefined, undefined, winners);
}

/** Play a bracket to the end; `pick` chooses the winner of each match. */
function playOut(b: BracketState, pick: (top: string, bottom: string) => string, onReport?: (b: BracketState) => void): BracketState {
	for (let guard = 0; guard < 1000; guard++) {
		const m = b.matches.find((x) => x.topPlayerId && x.bottomPlayerId && !x.winnerId);
		if (!m) return b;
		b = reportBracketMatch(b, m.id, pick(m.topPlayerId!, m.bottomPlayerId!));
		onReport?.(b);
	}
	throw new Error('bracket did not finish');
}

const layouts: Layout[] = FIXTURE_DIRS.flatMap((dir) =>
	fs.existsSync(dir)
		? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Layout)
		: []
).sort((a, b) => a.N - b.N || a.W - b.W);

describe('bracket shape matches StartGG', () => {
	it('has fixtures', () => expect(layouts.length).toBeGreaterThan(0));

	for (const layout of layouts) {
		it(`${layout.N} players, ${layout.W} in winners`, () => {
			const theirs = shapeOfLayout(layout);
			const ours = shapeOfBracket(makeBracket(layout.N, layout.W));
			expect(theirs.final).not.toBeNull();
			expect(ours.firstRound).toEqual(theirs.firstRound);
			expect(ours.matches.size).toBe(theirs.matches.size);
			expect(ours.final).toBe(theirs.final);
		});
	}
});

/** Small deterministic RNG so a failing play-through can be reproduced. */
function rng(seed: number) {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
		return x / 0xffffffff;
	};
}
const favourite = (top: string, bottom: string) => (Number(top.slice(1)) < Number(bottom.slice(1)) ? top : bottom);

describe('split-start bracket', () => {
	for (let n = 8; n <= 40; n++) {
		const winners = Math.ceil(n / 2);
		it(`${n} players: bottom half is out after one loss, top half after two`, () => {
			for (const seed of [1, 2, 3]) {
				const rand = rng(n * 100 + seed);
				const start = makeBracket(n, winners);
				expect(start.winnersCount).toBe(winners);
				// Nobody has a result before a set is played.
				expect(computeBracketRecords(start.matches).size).toBe(0);
				const b = playOut(start, (t, bt) => (rand() < 0.5 ? t : bt));
				expect(b.matches.filter((m) => !m.winnerId && (m.topPlayerId || m.bottomPlayerId))).toEqual([]);
				const records = computeBracketRecords(b.matches);
				const gf = [...b.matches].reverse().find((m) => m.id.includes('-GF') && m.winnerId)!;
				for (let i = 1; i <= n; i++) {
					const id = `p${i}`;
					if (id === gf.winnerId) continue;
					expect(records.get(id)?.losses, `${id} losses`).toBe(i <= winners ? 2 : 1);
				}
			}
		});
	}

	it('does not open with a set two players just played in Swiss', () => {
		const players = Array.from({ length: 24 }, (_, i) => ({ entrantId: `p${i + 1}`, seed: i + 1 }));
		const firstSets = (b: BracketState) =>
			b.matches.filter((m) => !m.winnerId && m.topPlayerId && m.bottomPlayerId).map((m) => [m.topPlayerId!, m.bottomPlayerId!].sort().join(' v '));
		// 8 v 9 opens winners and 13 v 23 opens losers in the plain layout.
		expect(firstSets(makeBracket(24, 12))).toEqual(expect.arrayContaining(['p8 v p9', 'p13 v p23']));
		const last = new Map([['p8', 'p9'], ['p9', 'p8'], ['p13', 'p23'], ['p23', 'p13']]);
		const b = generateBracket('main', players, [], undefined, last, 12);
		expect(firstSets(b)).not.toContain('p8 v p9');
		expect(firstSets(b)).not.toContain('p13 v p23');
		// Nobody changes side: the top twelve of the standings are still the winners-side starters.
		const top = b.players.filter((p) => p.seed <= 12).map((p) => Number(p.entrantId.slice(1)));
		expect(top.every((n) => n <= 12)).toBe(true);
		expect(b.winnersCount).toBe(12);
		// And it stays a bracket StartGG can mirror: same shape as the plain 24/12 layout.
		expect(shapeOfBracket(b).final).toBe(shapeOfBracket(makeBracket(24, 12)).final);
	});

	it('24 players: redemption takes the 12 early exits, later exits in winners', () => {
		let b = makeBracket(24, 12);
		expect(b.redemptionCutoffRound).toBe(-2);
		const firstLosers = b.matches.filter((m) => m.round === -1);
		expect(firstLosers.length).toBe(8);
		expect(isSplitRedemptionReady(b)).toBe(false);
		let readyAfter = 0;
		b = playOut(b, favourite, (now) => { if (!readyAfter && isSplitRedemptionReady(now)) readyAfter = now.matches.filter((m) => m.winnerId && m.topPlayerId && m.bottomPlayerId).length; });
		expect(readyAfter).toBeGreaterThan(0);
		const red = generateSplitRedemption(b);
		expect(red.players.length).toBe(12);
		expect(red.winnersCount).toBe(4);
		// Top four redemption seeds are the players who won a set before going out.
		const records = computeBracketRecords(b.matches);
		expect(red.players.slice(0, 4).every((p) => records.get(p.entrantId)!.wins === 1)).toBe(true);
		expect(red.players.slice(4).every((p) => records.get(p.entrantId)!.wins === 0)).toBe(true);
		const done = playOut(red, favourite);
		expect(done.matches.filter((m) => !m.winnerId && (m.topPlayerId || m.bottomPlayerId))).toEqual([]);
	});

	it('32 players: redemption takes 16, split 8 and 8', () => {
		const b = playOut(makeBracket(32, 16), favourite);
		expect(b.redemptionCutoffRound).toBe(-2);
		const red = generateSplitRedemption(b);
		expect(red.players.length).toBe(16);
		expect(red.winnersCount).toBe(8);
	});

	it('redemption never includes a player with two wins, at any size', () => {
		for (let n = 16; n <= 36; n++) {
			const rand = rng(n);
			const b = playOut(makeBracket(n, Math.ceil(n / 2)), (t, bt) => (rand() < 0.5 ? t : bt));
			const records = computeBracketRecords(b.matches);
			const red = generateSplitRedemption(b);
			expect(red.players.length).toBeGreaterThanOrEqual(4);
			for (const p of red.players) expect(records.get(p.entrantId)!.wins).toBeLessThanOrEqual(1);
			// Every bottom-half player who went out with at most one win is in.
			for (let i = Math.ceil(n / 2) + 1; i <= n; i++) {
				const r = records.get(`p${i}`)!;
				if (r.losses >= 1 && r.wins <= 1) expect(red.players.some((p) => p.entrantId === `p${i}`), `p${i} at n=${n}`).toBe(true);
			}
		}
	});
});

describe('split-start waves', () => {
	const sizes = (b: BracketState) => dependencyRoundOrder(b.matches).map((g) => g.length);

	it('24 players: nine rounds, half of losers round 1 waits for winners round 1', () => {
		expect(sizes(makeBracket(24, 12))).toEqual([8, 8, 6, 5, 2, 2, 1, 1, 1]);
	});

	it('32 players: nine rounds, losers round 1 runs alongside winners round 1', () => {
		expect(sizes(makeBracket(32, 16))).toEqual([16, 12, 6, 5, 2, 2, 1, 1, 1]);
	});

	it('redemption joins after the cutoff round and ends with main', () => {
		for (const [n, startsAfter] of [[24, 3], [32, 2]] as const) {
			const main = playOut(makeBracket(n, n / 2), favourite);
			const red = generateSplitRedemption(main);
			const waves = computeWaves(main, red, 'experimental2', 64);
			const wave = (b: BracketState, pick: 'min' | 'max') => {
				const ws = b.matches.map((m) => waves.get(m.id)?.wave).filter((w): w is number => w !== undefined);
				return pick === 'min' ? Math.min(...ws) : Math.max(...ws);
			};
			expect(wave(red, 'min')).toBe(startsAfter + 1);
			expect(wave(red, 'max')).toBe(wave(main, 'max'));
		}
	});
});
