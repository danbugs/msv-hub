/**
 * Data-driven Discord messages using league stats.
 * Replaces AI-generated "motivational" messages with real stats from the current season.
 */

import { getLeagueSeason, getRankings, getLeagueConfig, getSeasonIndex, getPlayerStats } from './league-store';

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

type MessageGenerator = (seasonId: number) => Promise<string | null>;

const generators: MessageGenerator[] = [
	generateRivalryMessage,
	generateWinStreakMessage,
	generateNemesisMessage,
	generateDominatedMessage,
	generateCharacterPopularityMessage,
];

/**
 * Generate a stat-based community message from the current league season.
 * Returns a fallback if no season data is available.
 */
export async function generateStatMessage(): Promise<string> {
	const seasons = await getSeasonIndex();
	if (seasons.length === 0) return fallback();

	const latestId = Math.max(...seasons.map((s) => s.id));

	const shuffled = [...generators].sort(() => Math.random() - 0.5);
	for (const gen of shuffled) {
		const msg = await gen(latestId);
		if (msg) return msg;
	}

	return fallback();
}

function fallback(): string {
	const messages = [
		'who planning to be up regging they micro?',
		'wondering who gonna get fastest reg...',
		"who's bringing setups this week?",
		'what character do u wanna see more of at micro?',
	];
	return pick(messages);
}

async function loadSeason(seasonId: number) {
	const season = await getLeagueSeason(seasonId);
	if (!season || season.events.length === 0) return null;
	const config = await getLeagueConfig();
	const rankings = getRankings(season, config);
	return { season, config, rankings };
}

async function generateRivalryMessage(seasonId: number): Promise<string | null> {
	const data = await loadSeason(seasonId);
	if (!data) return null;
	const { season, rankings } = data;

	const rivals: { p1Tag: string; p2Tag: string; wins: number; losses: number; total: number }[] = [];
	const seen = new Set<string>();

	for (const r of rankings.slice(0, 30)) {
		const stats = getPlayerStats(season, r.playerId, data.config);
		if (!stats?.matchups.rival) continue;
		const key = [r.playerId, stats.matchups.rival.playerId].sort().join('-');
		if (seen.has(key)) continue;
		seen.add(key);
		rivals.push({
			p1Tag: r.gamerTag,
			p2Tag: stats.matchups.rival.tag,
			wins: stats.matchups.rival.wins,
			losses: stats.matchups.rival.losses,
			total: stats.matchups.rival.total,
		});
	}

	if (rivals.length === 0) return null;
	const r = pick(rivals);
	const templates = [
		`${r.p1Tag} vs ${r.p2Tag}: ${r.wins}-${r.losses} this season (${r.total} sets). who takes the next one?`,
		`${r.p1Tag} and ${r.p2Tag} have played ${r.total} sets this season (${r.wins}-${r.losses}). always a good match`,
		`the ${r.p1Tag} vs ${r.p2Tag} matchup has gone to ${r.total} sets this season. record is ${r.wins}-${r.losses}`,
	];
	return pick(templates);
}

async function generateWinStreakMessage(seasonId: number): Promise<string | null> {
	const data = await loadSeason(seasonId);
	if (!data) return null;
	const { season } = data;

	const eventWinners: { pid: string; tag: string }[] = [];
	for (const evt of season.events) {
		if (evt.slug.startsWith('macrospacing-')) continue;
		const p1 = evt.placements.find((p) => p.placement === 1);
		if (p1) eventWinners.push({ pid: p1.playerId, tag: season.players[p1.playerId]?.gamerTag ?? p1.gamerTag });
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

	if (isActive) {
		const templates = [
			`${bestTag} has won ${bestStreak} micros in a row. can anyone stop the streak?`,
			`${bestTag} on a ${bestStreak}-event win streak rn`,
			`${bestStreak} in a row for ${bestTag}. who's stepping up next week?`,
		];
		return pick(templates);
	}

	const templates = [
		`longest win streak this season: ${bestTag} with ${bestStreak} in a row`,
		`${bestTag} had a ${bestStreak}-event win streak this season. will anyone match it?`,
	];
	return pick(templates);
}

async function generateNemesisMessage(seasonId: number): Promise<string | null> {
	const data = await loadSeason(seasonId);
	if (!data) return null;
	const { season, rankings } = data;

	const pairs: { playerTag: string; nemesisTag: string; losses: number }[] = [];
	for (const r of rankings.slice(0, 20)) {
		const stats = getPlayerStats(season, r.playerId, data.config);
		if (!stats?.matchups.nemesis || stats.matchups.nemesis.losses < 3) continue;
		pairs.push({
			playerTag: r.gamerTag,
			nemesisTag: stats.matchups.nemesis.tag,
			losses: stats.matchups.nemesis.losses,
		});
	}

	if (pairs.length === 0) return null;
	const p = pick(pairs);
	const templates = [
		`${p.playerTag} has lost to ${p.nemesisTag} ${p.losses} times this season. the bracket demon`,
		`${p.nemesisTag} keeps gatekeeping ${p.playerTag} (${p.losses}-0 this season)`,
	];
	return pick(templates);
}

async function generateDominatedMessage(seasonId: number): Promise<string | null> {
	const data = await loadSeason(seasonId);
	if (!data) return null;
	const { season, rankings } = data;

	const pairs: { playerTag: string; victimTag: string; wins: number }[] = [];
	for (const r of rankings.slice(0, 20)) {
		const stats = getPlayerStats(season, r.playerId, data.config);
		if (!stats?.matchups.dominated || stats.matchups.dominated.wins < 3) continue;
		pairs.push({
			playerTag: r.gamerTag,
			victimTag: stats.matchups.dominated.tag,
			wins: stats.matchups.dominated.wins,
		});
	}

	if (pairs.length === 0) return null;
	const p = pick(pairs);
	const templates = [
		`${p.playerTag} has beaten ${p.victimTag} ${p.wins} times this season without dropping a set`,
		`${p.victimTag} just can't seem to figure out ${p.playerTag} (0-${p.wins} this season)`,
	];
	return pick(templates);
}

async function generateCharacterPopularityMessage(seasonId: number): Promise<string | null> {
	const data = await loadSeason(seasonId);
	if (!data) return null;
	const { season } = data;

	const charCounts = new Map<string, number>();
	for (const m of season.matches) {
		for (const chars of [m.player1Characters, m.player2Characters]) {
			if (!chars) continue;
			for (const c of chars) {
				charCounts.set(c.name, (charCounts.get(c.name) ?? 0) + 1);
			}
		}
	}

	const sorted = [...charCounts.entries()].sort((a, b) => b[1] - a[1]);
	if (sorted.length < 3) return null;

	const style = Math.floor(Math.random() * 3);

	if (style === 0) {
		const [name, count] = sorted[0];
		return `most played character this season: ${name} with ${count} game appearances`;
	}

	if (style === 1) {
		const top3 = sorted.slice(0, 3).map(([name]) => name);
		return `top 3 most played characters this season: ${top3[0]}, ${top3[1]}, ${top3[2]}`;
	}

	const bottom = sorted.filter(([, c]) => c >= 2).slice(-3).map(([name]) => name);
	if (bottom.length < 2) return null;
	return `underrepresented characters this season: ${bottom.join(', ')}. who's picking them up?`;
}
