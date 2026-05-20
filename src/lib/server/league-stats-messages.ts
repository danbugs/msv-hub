/**
 * Data-driven Discord messages using league stats.
 * Pulls from all-time data with sliding 15-event windows to reduce repetition.
 */

import type { LeagueSeason, LeagueMatch, LeagueEvent } from '$lib/types/league';
import { getLeagueSeason, getRankings, getLeagueConfig } from './league-store';

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

interface Window {
	label: string;
	recent: boolean;
	events: LeagueEvent[];
	matches: LeagueMatch[];
}

const WINDOW_SIZE = 15;

function buildWindows(season: LeagueSeason): Window[] {
	const microEvents = season.events.filter((e) => !e.slug.startsWith('macrospacing-'));
	const allSlugs = new Set(microEvents.map((e) => e.slug));
	const allMatches = season.matches.filter((m) => allSlugs.has(m.eventSlug));

	const windows: Window[] = [];

	if (microEvents.length > 0) {
		windows.push({
			label: `across all ${microEvents.length} micros`,
			recent: true,
			events: microEvents,
			matches: allMatches,
		});
	}

	let first = true;
	for (let end = microEvents.length; end > 0; end -= WINDOW_SIZE) {
		const start = Math.max(0, end - WINDOW_SIZE);
		const slice = microEvents.slice(start, end);
		if (slice.length < 5) continue;
		const slugs = new Set(slice.map((e) => e.slug));
		const firstNum = slice[0].eventNumber;
		const lastNum = slice[slice.length - 1].eventNumber;
		windows.push({
			label: `between MSV#${firstNum} and MSV#${lastNum}`,
			recent: first,
			events: slice,
			matches: allMatches.filter((m) => slugs.has(m.eventSlug)),
		});
		first = false;
	}

	return windows;
}

type MessageGenerator = (season: LeagueSeason, window: Window) => Promise<string | null>;

const generators: MessageGenerator[] = [
	generateRivalryMessage,
	generateWinStreakMessage,
	generateTournamentWinsMessage,
	generateCharacterPopularityMessage,
	generateCharacterPilotMessage,
];

export async function generateStatMessage(): Promise<string> {
	const season = await getLeagueSeason(0);
	if (!season || season.events.length === 0) return 'hello';

	const windows = buildWindows(season);
	if (windows.length === 0) return 'hello';

	const window = pick(windows);
	const shuffled = [...generators].sort(() => Math.random() - 0.5);
	for (const gen of shuffled) {
		const msg = await gen(season, window);
		if (msg) return msg;
	}

	return 'hello';
}

async function generateRivalryMessage(season: LeagueSeason, window: Window): Promise<string | null> {
	const config = await getLeagueConfig();
	const rankings = getRankings(season, { ...config, attendanceBonus: 5 });

	const opponents = new Map<string, Map<string, { tag: string; wins: number; losses: number }>>();

	for (const m of window.matches) {
		if (m.isDQ) continue;
		for (const [pid, oppId, oppTag, won] of [
			[m.player1Id, m.player2Id, m.player2Tag, m.winnerId === m.player1Id],
			[m.player2Id, m.player1Id, m.player1Tag, m.winnerId === m.player2Id],
		] as [string, string, string, boolean][]) {
			const pMap = opponents.get(pid) ?? new Map();
			const opp = pMap.get(oppId) ?? { tag: oppTag, wins: 0, losses: 0 };
			if (won) opp.wins++; else opp.losses++;
			opp.tag = oppTag;
			pMap.set(oppId, opp);
			opponents.set(pid, pMap);
		}
	}

	const seen = new Set<string>();
	const rivals: { p1Tag: string; p2Tag: string; wins: number; losses: number; total: number }[] = [];

	for (const r of rankings.slice(0, 40)) {
		const pMap = opponents.get(r.playerId);
		if (!pMap) continue;
		for (const [oppId, opp] of pMap) {
			const total = opp.wins + opp.losses;
			if (total < 3 || Math.abs(opp.wins - opp.losses) > 1) continue;
			const key = [r.playerId, oppId].sort().join('-');
			if (seen.has(key)) continue;
			seen.add(key);
			rivals.push({ p1Tag: r.gamerTag, p2Tag: opp.tag, wins: opp.wins, losses: opp.losses, total });
		}
	}

	if (rivals.length === 0) return null;
	const r = pick(rivals);
	const templates = [
		`${r.p1Tag} and ${r.p2Tag} played ${r.total} times ${window.label} (${r.wins}-${r.losses}). always a good match`,
		`${r.p1Tag} and ${r.p2Tag} played ${r.total} times ${window.label}. record is ${r.wins}-${r.losses}`,
	];
	if (window.recent) {
		templates.push(`${r.p1Tag} vs ${r.p2Tag}: ${r.wins}-${r.losses} ${window.label} (${r.total} sets). who takes the next one?`);
	}
	return pick(templates);
}

async function generateWinStreakMessage(_season: LeagueSeason, window: Window): Promise<string | null> {
	const eventWinners: { pid: string; tag: string }[] = [];
	for (const evt of window.events) {
		const p1 = evt.placements.find((p) => p.placement === 1);
		if (p1) eventWinners.push({ pid: p1.playerId, tag: _season.players[p1.playerId]?.gamerTag ?? p1.gamerTag });
	}

	if (eventWinners.length < 2) return null;

	let bestPid = '';
	let bestTag = '';
	let bestStreak = 0;
	let curPid = '';
	let curStreak = 0;

	for (const w of eventWinners) {
		if (w.pid === curPid) {
			curStreak++;
		} else {
			curPid = w.pid;
			curStreak = 1;
		}
		if (curStreak > bestStreak) {
			bestStreak = curStreak;
			bestPid = curPid;
			bestTag = w.tag;
		}
	}

	if (bestStreak < 2) return null;

	const isActive = eventWinners[eventWinners.length - 1].pid === bestPid &&
		eventWinners.slice(-bestStreak).every((w) => w.pid === bestPid);

	if (isActive && window.recent) {
		const templates = [
			`${bestTag} has won ${bestStreak} micros in a row. can anyone stop the streak?`,
			`${bestTag} on a ${bestStreak}-event win streak rn`,
			`${bestStreak} in a row for ${bestTag}. who's stepping up next week?`,
		];
		return pick(templates);
	}

	const templates = [
		`longest win streak ${window.label}: ${bestTag} with ${bestStreak} in a row`,
		`${bestTag} had a ${bestStreak}-event win streak ${window.label}`,
	];
	return pick(templates);
}

async function generateTournamentWinsMessage(_season: LeagueSeason, window: Window): Promise<string | null> {
	const winCounts = new Map<string, { tag: string; count: number }>();
	for (const evt of window.events) {
		const winner = evt.placements.find((p) => p.placement === 1);
		if (!winner) continue;
		const tag = _season.players[winner.playerId]?.gamerTag ?? winner.gamerTag;
		const e = winCounts.get(winner.playerId) ?? { tag, count: 0 };
		e.count++;
		winCounts.set(winner.playerId, e);
	}

	const multiWinners = [...winCounts.values()].filter((w) => w.count >= 2).sort((a, b) => b.count - a.count);
	if (multiWinners.length === 0) return null;

	const w = pick(multiWinners);
	const templates = [
		`${w.count} micro wins for ${w.tag} ${window.label}`,
		`${w.tag} with ${w.count} tournament wins ${window.label}`,
	];
	return pick(templates);
}

async function generateCharacterPopularityMessage(_season: LeagueSeason, window: Window): Promise<string | null> {
	const charCounts = new Map<string, number>();
	for (const m of window.matches) {
		for (const chars of [m.player1Characters, m.player2Characters]) {
			if (!chars) continue;
			for (const c of chars) {
				const name = c.name === 'Random Character' ? 'Random' : c.name;
				charCounts.set(name, (charCounts.get(name) ?? 0) + 1);
			}
		}
	}

	const sorted = [...charCounts.entries()].sort((a, b) => b[1] - a[1]);
	if (sorted.length < 3) return null;

	const style = Math.floor(Math.random() * 3);

	if (style === 0) {
		const [name, count] = sorted[0];
		return `character with the most top 8 representation ${window.label}: ${name} (${count} appearances)`;
	}

	if (style === 1) {
		const top3 = sorted.slice(0, 3).map(([name]) => name);
		return `top 3 characters with the most top 8 representation ${window.label}: ${top3[0]}, ${top3[1]}, ${top3[2]}`;
	}

	const bottom = sorted.filter(([, c]) => c >= 2).slice(-3).map(([name]) => name);
	if (bottom.length < 2) return null;
	return `least represented characters in top 8 ${window.label}: ${bottom.join(', ')}. who's picking them up?`;
}

async function generateCharacterPilotMessage(_season: LeagueSeason, window: Window): Promise<string | null> {
	const charPilots = new Map<string, Map<string, number>>();
	for (const m of window.matches) {
		for (const [pid, chars] of [
			[m.player1Id, m.player1Characters],
			[m.player2Id, m.player2Characters],
		] as [string, typeof m.player1Characters][]) {
			if (!chars) continue;
			for (const c of chars) {
				const name = c.name === 'Random Character' ? 'Random' : c.name;
				const pilots = charPilots.get(name) ?? new Map();
				pilots.set(pid, (pilots.get(pid) ?? 0) + 1);
				charPilots.set(name, pilots);
			}
		}
	}

	const candidates: { charName: string; pilotTag: string; count: number }[] = [];
	for (const [charName, pilots] of charPilots) {
		const total = [...pilots.values()].reduce((a, b) => a + b, 0);
		if (total < 3) continue;
		let topPid = '';
		let topCount = 0;
		for (const [pid, count] of pilots) {
			if (count > topCount) { topPid = pid; topCount = count; }
		}
		const tag = _season.players[topPid]?.gamerTag;
		if (!tag) continue;
		candidates.push({ charName, pilotTag: tag, count: topCount });
	}

	if (candidates.length === 0) return null;
	const c = pick(candidates);
	const templates = [
		`${c.pilotTag} is the top ${c.charName} pilot in top 8 ${window.label} (${c.count} appearances)`,
		`${c.charName}'s biggest rep in top 8 ${window.label}: ${c.pilotTag} with ${c.count} appearances`,
	];
	return pick(templates);
}
