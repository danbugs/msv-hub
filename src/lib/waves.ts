import type { BracketMatch, BracketState } from '$lib/types/tournament';

export interface WaveAssignment {
	wave: number;
	color: string;
	badgeColor: string;
	label: string;
}

export type WaveMap = Map<string, WaveAssignment>;

const WAVE_COLORS = [
	'oklch(0.65 0.14 250 / 15%)',
	'oklch(0.65 0.10 250 / 12%)',
	'oklch(0.65 0.14 190 / 15%)',
	'oklch(0.65 0.10 190 / 12%)',
	'oklch(0.65 0.14 150 / 15%)',
	'oklch(0.65 0.14 85 / 15%)',
	'oklch(0.65 0.14 120 / 15%)',
	'oklch(0.65 0.10 120 / 12%)',
	'oklch(0.65 0.14 55 / 15%)',
	'oklch(0.65 0.10 55 / 12%)',
	'oklch(0.65 0.14 340 / 15%)',
	'oklch(0.65 0.10 340 / 12%)',
	'oklch(0.65 0.14 25 / 15%)',
	'oklch(0.65 0.10 25 / 12%)',
	'oklch(0.65 0.14 310 / 15%)',
	'oklch(0.65 0.10 310 / 12%)',
];

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

function assignWave(map: WaveMap, matches: BracketMatch[], waveNum: number): void {
	const idx = (waveNum - 1) % WAVE_COLORS.length;
	const info: WaveAssignment = {
		wave: waveNum,
		color: WAVE_COLORS[idx],
		badgeColor: WAVE_BADGE_COLORS[idx],
		label: `Wave ${waveNum}`,
	};
	for (const m of matches) map.set(m.id, info);
}

function resolveGFRound(matches: BracketMatch[]): number {
	const gf = matches.find((m) => m.id.includes('-GF-') && !m.id.includes('-GFR-'));
	return gf?.round ?? Math.max(...matches.map((m) => m.round));
}

// DE round calling order: WR1, WR2+LR1, LR2, WR3+LR3, LR4, WR4+LR5, LR6, ...
function deRoundOrder(matches: BracketMatch[]): BracketMatch[][] {
	const byRound = new Map<number, BracketMatch[]>();
	for (const m of matches) {
		if (m.id.includes('-GFR-')) continue;
		if (!byRound.has(m.round)) byRound.set(m.round, []);
		byRound.get(m.round)!.push(m);
	}
	for (const ms of byRound.values()) ms.sort((a, b) => a.matchIndex - b.matchIndex);

	const winRounds = [...byRound.keys()].filter((r) => r > 0).sort((a, b) => a - b);
	const losRounds = [...byRound.keys()].filter((r) => r < 0).sort((a, b) => Math.abs(a) - Math.abs(b));

	const gfRound = resolveGFRound(matches);
	const groups: BracketMatch[][] = [];

	if (byRound.has(winRounds[0])) groups.push(byRound.get(winRounds[0])!);

	let li = 0;
	for (let wi = 1; wi < winRounds.length; wi++) {
		const wr = winRounds[wi];
		if (wr === gfRound) continue;
		const combined = [...(byRound.get(wr) ?? [])];
		if (li < losRounds.length) combined.push(...(byRound.get(losRounds[li]) ?? []));
		li++;
		if (combined.length) groups.push(combined);
		if (li < losRounds.length) {
			const lr = byRound.get(losRounds[li]);
			if (lr?.length) groups.push(lr);
			li++;
		}
	}
	while (li < losRounds.length) {
		const lr = byRound.get(losRounds[li]);
		if (lr?.length) groups.push(lr);
		li++;
	}
	if (byRound.has(gfRound)) groups.push(byRound.get(gfRound)!);

	return groups;
}

export function computeWaves(
	main: BracketState,
	redemption: BracketState | undefined,
	_mode: 'default' | 'gauntlet' = 'default',
	stationCount = 16
): WaveMap {
	const map: WaveMap = new Map();
	const mainMatches = main.matches;
	const redMatches = redemption?.matches ?? [];

	const mainGroups = deRoundOrder(mainMatches);
	const redGroups = deRoundOrder(redMatches);
	const maxLen = Math.max(mainGroups.length, redGroups.length);
	let waveNum = 1;

	for (let i = 0; i < maxLen; i++) {
		// Combine same-depth groups from both brackets (independent of each other)
		const group = [...(mainGroups[i] ?? []), ...(redGroups[i] ?? [])];
		if (group.length === 0) continue;
		// Split into chunks of stationCount if the group is too large
		for (let j = 0; j < group.length; j += stationCount) {
			assignWave(map, group.slice(j, j + stationCount), waveNum++);
		}
	}

	// GFR gets same wave as GF
	for (const m of [...mainMatches, ...redMatches]) {
		if (m.id.includes('-GFR-') && !map.has(m.id)) {
			const gfMatch = (m.id.startsWith('main') ? mainMatches : redMatches)
				.find((g) => g.id.includes('-GF-') && !g.id.includes('-GFR-'));
			const gfWave = gfMatch ? map.get(gfMatch.id) : undefined;
			if (gfWave) {
				map.set(m.id, { ...gfWave });
			}
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
