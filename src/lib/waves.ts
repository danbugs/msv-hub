import type { BracketMatch, BracketState } from '$lib/types/tournament';

export interface WaveAssignment {
	wave: number;
	color: string;
	badgeColor: string;
	label: string;
}

export type WaveMap = Map<string, WaveAssignment>;

type Half = 'P1' | 'P2' | 'all';
type RoundSpec = { bracket: 'main' | 'redemption'; round: number | 'GF' | 'GFR'; half: Half };
type WaveTable = RoundSpec[][];

// 8 hues, each with two variants (P1=saturated, P2=muted) = 16 wave colors
const WAVE_COLORS = [
	'oklch(0.65 0.14 250 / 15%)', // 1  blue
	'oklch(0.65 0.10 250 / 12%)', // 2  blue muted
	'oklch(0.65 0.14 190 / 15%)', // 3  teal
	'oklch(0.65 0.10 190 / 12%)', // 4  teal muted
	'oklch(0.65 0.14 150 / 15%)', // 5  green
	'oklch(0.65 0.14 85 / 15%)',  // 6  yellow
	'oklch(0.65 0.14 120 / 15%)', // 7  lime
	'oklch(0.65 0.10 120 / 12%)', // 8  lime muted
	'oklch(0.65 0.14 55 / 15%)',  // 9  orange
	'oklch(0.65 0.10 55 / 12%)',  // 10 orange muted
	'oklch(0.65 0.14 340 / 15%)', // 11 pink
	'oklch(0.65 0.10 340 / 12%)', // 12 pink muted
	'oklch(0.65 0.14 25 / 15%)',  // 13 red
	'oklch(0.65 0.10 25 / 12%)',  // 14 red muted
	'oklch(0.65 0.14 310 / 15%)', // 15 purple
	'oklch(0.65 0.10 310 / 12%)', // 16 purple muted
];

// Badge colors (opaque, for the wave number indicator)
const WAVE_BADGE_COLORS = [
	'oklch(0.55 0.14 250)', 'oklch(0.60 0.10 250)',
	'oklch(0.55 0.14 190)', 'oklch(0.60 0.10 190)',
	'oklch(0.55 0.14 150)', 'oklch(0.55 0.14 85)',
	'oklch(0.55 0.14 120)', 'oklch(0.60 0.10 120)',
	'oklch(0.55 0.14 55)',  'oklch(0.60 0.10 55)',
	'oklch(0.55 0.14 340)', 'oklch(0.60 0.10 340)',
	'oklch(0.55 0.14 25)',  'oklch(0.60 0.10 25)',
	'oklch(0.55 0.14 310)', 'oklch(0.60 0.10 310)',
];

function M(round: number | 'GF' | 'GFR', half: Half = 'all'): RoundSpec {
	return { bracket: 'main', round, half };
}
function R(round: number | 'GF' | 'GFR', half: Half = 'all'): RoundSpec {
	return { bracket: 'redemption', round, half };
}

// 64 main players → 32 WR1 matches, redemption ~32 players
const WAVE_TABLE_64: WaveTable = [
	[M(1, 'P1')],                                // Wave 1:  Main P1 WR1
	[M(1, 'P2')],                                 // Wave 2:  Main P2 WR1
	[M(2, 'P1'), M(-1, 'P1')],                    // Wave 3:  Main P1 WR2 + P1 LR1
	[M(2, 'P2'), M(-1, 'P2')],                    // Wave 4:  Main P2 WR2 + P2 LR1
	[M(-2)],                                      // Wave 5:  Main LR2
	[R(1)],                                       // Wave 6:  Red WR1
	[M(3), M(-3)],                                // Wave 7:  Main WR3 + Main LR3
	[M(-4), R(-1)],                               // Wave 8:  Main LR4 + Red LR1
	[R(2), R(-2)],                                // Wave 9:  Red WR2 + Red LR2
	[M(4), M(-5), R(3), R(-3)],                   // Wave 10: Main WQF + Main LR5 + Red WQF + Red LR3
	[M(-6), R(-4), M(5), R(4)],                   // Wave 11: Main LR6 + Red LR4 + Main WSF + Red WSF
	[M(6), M(-7), R(5), R(-5)],                    // Wave 12: Main WF + Main LR7 + Red WF + Red LR5
	[M(-8), R(-6)],                               // Wave 13: Main LR8 + Red LR6
	[M(-9), R(-7)],                               // Wave 14: Main LR9 + Red LR7
	[M(-10), R(-8)],                              // Wave 15: Main LF + Red LF
	[M('GF'), R('GF')],                           // Wave 16: Main GF + Red GF
];

// 32 main players → 16 WR1 matches, redemption ~16 players
// Main: WR1(16) WR2(8) WR3(4) WR4(2) WR5(1=WF) GF | LR1(8) LR2(8) LR3(4) LR4(4) LR5(2) LR6(2) LR7(1) LR8(1=LF)
// Red:  WR1(8) WR2(4) WR3(2) WR4(1=WF) GF | LR1(4) LR2(4) LR3(2) LR4(2) LR5(1) LR6(1=LF)
const WAVE_TABLE_32: WaveTable = [
	[M(1, 'P1')],                                 // Wave 1:  Main P1 WR1 (8)
	[M(1, 'P2')],                                 // Wave 2:  Main P2 WR1 (8)
	[M(2), M(-1)],                                // Wave 3:  Main WR2 + LR1 (8+8=16)
	[M(-2)],                                      // Wave 4:  Main LR2 (8)
	[R(1)],                                       // Wave 5:  Red WR1 (8)
	[M(3), M(-3), R(-1)],                         // Wave 6:  Main WR3 + Main LR3 + Red LR1 (4+4+4=12)
	[M(-4), R(2), R(-2)],                         // Wave 7:  Main LR4 + Red WR2 + Red LR2 (4+4+4=12)
	[M(4), M(-5), R(3), R(-3)],                   // Wave 8:  Main WSF + Main LR5 + Red WQF + Red LR3 (2+2+2+2=8)
	[M(-6), R(-4), R(4)],                         // Wave 9:  Main LR6 + Red LR4 + Red WSF (2+2+1=5)
	[M(5), M(-7), R(4), R(-5)],                    // Wave 10: Main WF + Main LR7 + Red WF + Red LR5 (1+1+1+1=4)
	[M(-8), R(-6)],                               // Wave 11: Main LF + Red LF (1+1=2)
	[M('GF'), R('GF')],                           // Wave 12: Main GF + Red GF (1+1=2)
];

// 16 main players → 8 WR1 matches, redemption ~8 players
// Main: WR1(8) WR2(4) WR3(2) WR4(1=WF) GF | LR1(4) LR2(4) LR3(2) LR4(2) LR5(1) LR6(1=LF)
// Red:  WR1(4) WR2(2) WR3(1=WF) GF | LR1(2) LR2(2) LR3(1) LR4(1=LF)
const WAVE_TABLE_16: WaveTable = [
	[M(1)],                                       // Wave 1:  Main WR1 (8)
	[M(2), M(-1)],                                // Wave 2:  Main WR2 + LR1 (4+4=8)
	[M(-2)],                                      // Wave 3:  Main LR2 (4)
	[R(1)],                                       // Wave 4:  Red WR1 (4)
	[M(3), M(-3), R(2), R(-1)],                   // Wave 5:  Main WR3 + LR3 + Red WR2 + Red LR1 (2+2+2+2=8)
	[M(-4), R(-2), R(3)],                         // Wave 6:  Main LR4 + Red LR2 + Red WR3 (2+2+1=5)
	[M(4), M(-5), R(-3)],                           // Wave 7:  Main WF + Main LR5 + Red LR3 (1+1+1=3)
	[M(-6), R(-4)],                               // Wave 8:  Main LF + Red LF (1+1=2)
	[M('GF'), R('GF')],                           // Wave 9:  Main GF + Red GF (1+1=2)
];

function getWaveTable(mainPlayerCount: number): WaveTable {
	const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(mainPlayerCount, 4))));
	if (bracketSize >= 64) return WAVE_TABLE_64;
	if (bracketSize >= 32) return WAVE_TABLE_32;
	return WAVE_TABLE_16;
}

function resolveGFRound(matches: BracketMatch[]): number {
	const gf = matches.find((m) => m.id.includes('-GF-') && !m.id.includes('-GFR-'));
	return gf?.round ?? Math.max(...matches.map((m) => m.round));
}

function matchesForSpec(
	spec: RoundSpec,
	mainMatches: BracketMatch[],
	redMatches: BracketMatch[]
): BracketMatch[] {
	const src = spec.bracket === 'main' ? mainMatches : redMatches;
	if (src.length === 0) return [];

	let roundMatches: BracketMatch[];

	if (spec.round === 'GF') {
		const gfRound = resolveGFRound(src);
		roundMatches = src.filter((m) =>
			m.round === gfRound && !m.id.includes('-GFR-')
		);
	} else if (spec.round === 'GFR') {
		roundMatches = src.filter((m) => m.id.includes('-GFR-'));
	} else {
		roundMatches = src.filter((m) => m.round === spec.round);
	}

	roundMatches.sort((a, b) => a.matchIndex - b.matchIndex);

	if (spec.half === 'all') return roundMatches;
	const mid = Math.ceil(roundMatches.length / 2);
	return spec.half === 'P1' ? roundMatches.slice(0, mid) : roundMatches.slice(mid);
}

export function computeWaves(
	main: BracketState,
	redemption: BracketState | undefined
): WaveMap {
	const map: WaveMap = new Map();
	const table = getWaveTable(main.players.length);
	const mainMatches = main.matches;
	const redMatches = redemption?.matches ?? [];

	for (let wi = 0; wi < table.length; wi++) {
		const wave = wi + 1;
		const color = WAVE_COLORS[wi % WAVE_COLORS.length];
		const badgeColor = WAVE_BADGE_COLORS[wi % WAVE_BADGE_COLORS.length];
		const label = `Wave ${wave}`;

		for (const spec of table[wi]) {
			const matches = matchesForSpec(spec, mainMatches, redMatches);
			for (const m of matches) {
				map.set(m.id, { wave, color, label, badgeColor });
			}
		}
	}

	// GFR gets same wave as GF
	for (const m of [...mainMatches, ...redMatches]) {
		if (m.id.includes('-GFR-') && !map.has(m.id)) {
			const lastWave = table.length;
			map.set(m.id, {
				wave: lastWave,
				color: WAVE_COLORS[(lastWave - 1) % WAVE_COLORS.length],
				label: `Wave ${lastWave}`,
				badgeColor: WAVE_BADGE_COLORS[(lastWave - 1) % WAVE_BADGE_COLORS.length],
			});
		}
	}

	return map;
}

export function getWaveSummary(waveMap: WaveMap): { wave: number; color: string; badgeColor: string; label: string; count: number }[] {
	const summary = new Map<number, { color: string; badgeColor: string; label: string; count: number }>();
	for (const [, info] of waveMap) {
		const existing = summary.get(info.wave);
		if (existing) {
			existing.count++;
		} else {
			summary.set(info.wave, { color: info.color, badgeColor: info.badgeColor, label: info.label, count: 1 });
		}
	}
	return [...summary.entries()]
		.sort(([a], [b]) => a - b)
		.map(([wave, info]) => ({ wave, ...info }));
}
