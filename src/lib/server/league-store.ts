import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import type { LeagueSeason, LeaguePlayerStats, LeagueMatch, SeasonAward } from '$lib/types/league';

const LEAGUE_SEASON_PREFIX = 'league:season:';
const LEAGUE_MERGES_KEY = 'league:merges';
const LEAGUE_CONFIG_KEY = 'league:config';
const LEAGUE_SEASONS_INDEX_KEY = 'league:seasons';
const LEAGUE_BIO_PREFIX = 'league:bio:';

export interface LeagueConfig {
	minEvents: number;
	attendanceBonus: number;
}

const DEFAULT_CONFIG: LeagueConfig = { minEvents: 2, attendanceBonus: 50 };

export async function getLeagueConfig(): Promise<LeagueConfig> {
	const redis = getRedis();
	const data = await redis.get<string>(LEAGUE_CONFIG_KEY);
	if (!data) return DEFAULT_CONFIG;
	const parsed = typeof data === 'string' ? JSON.parse(data) : data as unknown as Partial<LeagueConfig>;
	return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveLeagueConfig(config: LeagueConfig): Promise<void> {
	const redis = getRedis();
	await redis.set(LEAGUE_CONFIG_KEY, JSON.stringify(config));
}

function getRedis(): Redis {
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
	return new Redis({ url, token });
}

export async function getLeagueSeason(id: number): Promise<LeagueSeason | null> {
	const redis = getRedis();
	const data = await redis.get<string>(`${LEAGUE_SEASON_PREFIX}${id}`);
	if (!data) return null;
	return typeof data === 'string' ? JSON.parse(data) : data as unknown as LeagueSeason;
}

export async function saveLeagueSeason(season: LeagueSeason): Promise<void> {
	const redis = getRedis();
	await redis.set(`${LEAGUE_SEASON_PREFIX}${season.id}`, JSON.stringify(season));
	const index = await getSeasonIndex();
	if (!index.find((s) => s.id === season.id)) {
		index.push({ id: season.id, name: season.name });
		await redis.set(LEAGUE_SEASONS_INDEX_KEY, JSON.stringify(index));
	}
}

export async function clearBioCache(seasonId: number): Promise<void> {
	const redis = getRedis();
	const prefix = `${LEAGUE_BIO_PREFIX}${seasonId}:`;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const [, keys] = await redis.scan(0, { match: `${prefix}*`, count: 200 }) as [any, string[]];
	if (keys.length > 0) {
		const pipeline = redis.pipeline();
		for (const key of keys) pipeline.del(key);
		await pipeline.exec();
	}
}

export interface SeasonSummary { id: number; name: string }

export async function getSeasonIndex(): Promise<SeasonSummary[]> {
	const redis = getRedis();
	const data = await redis.get<string>(LEAGUE_SEASONS_INDEX_KEY);
	if (!data) return [];
	return typeof data === 'string' ? JSON.parse(data) : data as unknown as SeasonSummary[];
}

export type MergeMap = Record<string, string>;

export async function getMergeMap(): Promise<MergeMap> {
	const redis = getRedis();
	const data = await redis.get<string>(LEAGUE_MERGES_KEY);
	if (!data) return {};
	return typeof data === 'string' ? JSON.parse(data) : data as unknown as MergeMap;
}

export async function saveMergeMap(merges: MergeMap): Promise<void> {
	const redis = getRedis();
	await redis.set(LEAGUE_MERGES_KEY, JSON.stringify(merges));
}

export async function addMerge(secondaryId: string, primaryId: string): Promise<void> {
	const merges = await getMergeMap();
	merges[secondaryId] = primaryId;
	for (const [k, v] of Object.entries(merges)) {
		if (v === secondaryId) merges[k] = primaryId;
	}
	await saveMergeMap(merges);
}

export async function removeMerge(secondaryId: string): Promise<void> {
	const merges = await getMergeMap();
	delete merges[secondaryId];
	await saveMergeMap(merges);
}

export function getRankings(
	season: LeagueSeason,
	config?: { minEvents?: number; attendanceBonus?: number }
): { playerId: string; gamerTag: string; points: number; rank: number; eventsAttended: number }[] {
	const bonus = config?.attendanceBonus ?? 0;
	const minEvents = config?.minEvents ?? 0;

	const eventCounts = new Map<string, number>();
	for (const evt of season.events) {
		for (const p of evt.placements) {
			eventCounts.set(p.playerId, (eventCounts.get(p.playerId) ?? 0) + 1);
		}
	}

	const players = Object.values(season.players)
		.map((p) => {
			const events = eventCounts.get(p.id) ?? 0;
			return { ...p, eventsAttended: events, adjustedPoints: p.points + events * bonus };
		})
		.filter((p) => p.eventsAttended >= minEvents)
		.sort((a, b) => b.adjustedPoints - a.adjustedPoints || a.sigma - b.sigma);

	return players.map((p, i) => ({
		playerId: p.id,
		gamerTag: p.gamerTag,
		points: p.adjustedPoints,
		rank: i + 1,
		eventsAttended: p.eventsAttended
	}));
}

export function getPlayerStats(season: LeagueSeason, playerId: string, config?: { minEvents?: number; attendanceBonus?: number }): LeaguePlayerStats | null {
	const player = season.players[playerId];
	if (!player) return null;

	const rankings = getRankings(season, config);
	const rankEntry = rankings.find((r) => r.playerId === playerId);
	const rank = rankEntry?.rank ?? rankings.length;

	const playerMatches = season.matches.filter(
		(m) => m.player1Id === playerId || m.player2Id === playerId
	);

	let matchesWon = 0;
	let matchesLost = 0;
	let scoreFor = 0;
	let scoreAgainst = 0;
	for (const m of playerMatches) {
		const isP1 = m.player1Id === playerId;
		if (m.winnerId === playerId) matchesWon++;
		else matchesLost++;
		scoreFor += isP1 ? m.player1Score : m.player2Score;
		scoreAgainst += isP1 ? m.player2Score : m.player1Score;
	}

	const eventSlugs = new Set(playerMatches.map((m) => m.eventSlug));
	const tournamentsPlayed = eventSlugs.size;

	const tournamentStats = { top1: 0, top3: 0, top8: 0, top16: 0, top32: 0 };
	for (const evt of season.events) {
		const pl = evt.placements.find((p) => p.playerId === playerId);
		if (!pl) continue;
		if (pl.placement <= 1) tournamentStats.top1++;
		if (pl.placement <= 3) tournamentStats.top3++;
		if (pl.placement <= 8) tournamentStats.top8++;
		if (pl.placement <= 16) tournamentStats.top16++;
		if (pl.placement <= 32) tournamentStats.top32++;
	}

	const redemptionEvents = new Set<string>();
	for (const m of playerMatches) {
		if (m.phase.startsWith('redemption-')) redemptionEvents.add(m.eventSlug);
	}
	const redemptionCount = redemptionEvents.size;

	const matchups = computeMatchups(playerMatches, playerId, season);
	const characters = computeCharacterStats(playerMatches, playerId);

	const eventMatchMap = new Map<string, LeagueMatch[]>();
	for (const m of playerMatches) {
		const arr = eventMatchMap.get(m.eventSlug) ?? [];
		arr.push(m);
		eventMatchMap.set(m.eventSlug, arr);
	}
	const matchesByEvent = season.events
		.filter((evt) => eventMatchMap.has(evt.slug))
		.map((evt) => ({
			slug: evt.slug,
			name: evt.name,
			date: evt.date,
			eventNumber: evt.eventNumber,
			placement: evt.placements.find((p) => p.playerId === playerId)?.placement,
			matches: eventMatchMap.get(evt.slug)!
		}))
		.reverse();

	const bestWins: { oppTag: string; oppId: string; oppPoints: number; oppRank: number; eventSlug: string; date: string; score: string }[] = [];
	for (const m of playerMatches) {
		if (m.winnerId !== playerId || m.isDQ) continue;
		const isP1 = m.player1Id === playerId;
		const oppId = isP1 ? m.player2Id : m.player1Id;
		const oppTag = isP1 ? m.player2Tag : m.player1Tag;
		const oppRanking = rankings.find((r) => r.playerId === oppId);
		if (!oppRanking) continue;
		const myScore = isP1 ? m.player1Score : m.player2Score;
		const oppScore = isP1 ? m.player2Score : m.player1Score;
		bestWins.push({
			oppTag, oppId, oppPoints: oppRanking.points, oppRank: oppRanking.rank,
			eventSlug: m.eventSlug, date: m.date,
			score: myScore > 0 || oppScore > 0 ? `${myScore}-${oppScore}` : ''
		});
	}
	bestWins.sort((a, b) => a.oppRank - b.oppRank);
	const seen = new Set<string>();
	const uniqueWins: typeof bestWins = [];
	for (const w of bestWins) {
		if (!seen.has(w.oppId)) { seen.add(w.oppId); uniqueWins.push(w); }
	}
	const topWins = uniqueWins.slice(0, 5);

	return {
		player,
		rank,
		totalPlayers: rankings.length,
		matchesPlayed: playerMatches.length,
		matchesWon,
		matchesLost,
		winRate: playerMatches.length > 0 ? Math.round((matchesWon / playerMatches.length) * 100) : 0,
		scoreFor,
		scoreAgainst,
		scoreDiff: scoreFor - scoreAgainst,
		tournamentsPlayed,
		tournamentStats,
		redemptionCount,
		matchups,
		characters,
		recentMatches: [...playerMatches].reverse(),
		matchesByEvent,
		bestWins: topWins
	};
}

function computeMatchups(matches: LeagueMatch[], playerId: string, season: LeagueSeason) {
	const opponents = new Map<string, { tag: string; wins: number; losses: number; total: number; closeGames: number }>();

	for (const m of matches) {
		if (m.isDQ) continue;
		const isP1 = m.player1Id === playerId;
		const oppId = isP1 ? m.player2Id : m.player1Id;
		const oppTag = isP1 ? m.player2Tag : m.player1Tag;
		const won = m.winnerId === playerId;
		const opp = opponents.get(oppId) ?? { tag: oppTag, wins: 0, losses: 0, total: 0, closeGames: 0 };
		if (won) opp.wins++;
		else opp.losses++;
		opp.total++;
		opp.tag = oppTag;
		const myScore = isP1 ? m.player1Score : m.player2Score;
		const oppScore = isP1 ? m.player2Score : m.player1Score;
		if (Math.abs(myScore - oppScore) === 1 && myScore + oppScore >= 3) opp.closeGames++;
		opponents.set(oppId, opp);
	}

	let nemesis: { tag: string; playerId: string; losses: number } | null = null;
	let dominated: { tag: string; playerId: string; wins: number } | null = null;
	let rival: { tag: string; playerId: string; wins: number; losses: number; total: number } | null = null;
	let gatekeeper: { tag: string; playerId: string; wins: number; losses: number; closeGames: number } | null = null;

	for (const [oppId, opp] of opponents) {
		if (opp.losses >= 2 && (!nemesis || opp.losses > nemesis.losses))
			nemesis = { tag: opp.tag, playerId: oppId, losses: opp.losses };

		if (opp.wins >= 2 && (!dominated || opp.wins > dominated.wins))
			dominated = { tag: opp.tag, playerId: oppId, wins: opp.wins };

		if (opp.total >= 3) {
			const diff = Math.abs(opp.wins - opp.losses);
			if (!rival || diff < Math.abs(rival.wins - rival.losses) || (diff === Math.abs(rival.wins - rival.losses) && opp.total > rival.total))
				rival = { tag: opp.tag, playerId: oppId, wins: opp.wins, losses: opp.losses, total: opp.total };
		}

		if (opp.losses > opp.wins && opp.closeGames >= 1 && (!gatekeeper || opp.closeGames > gatekeeper.closeGames))
			gatekeeper = { tag: opp.tag, playerId: oppId, wins: opp.wins, losses: opp.losses, closeGames: opp.closeGames };
	}

	let biggestUpset: { tag: string; playerId: string; upsetFactor: number; eventSlug: string } | null = null;
	const playerPoints = season.players[playerId]?.points ?? 5000;
	for (const m of matches) {
		if (m.winnerId !== playerId || m.isDQ) continue;
		const isP1 = m.player1Id === playerId;
		const oppId = isP1 ? m.player2Id : m.player1Id;
		const oppTag = isP1 ? m.player2Tag : m.player1Tag;
		const oppPoints = season.players[oppId]?.points ?? 5000;
		if (oppPoints <= playerPoints) continue;
		const factor = Math.round(oppPoints - playerPoints);
		if (!biggestUpset || factor > biggestUpset.upsetFactor)
			biggestUpset = { tag: oppTag, playerId: oppId, upsetFactor: factor, eventSlug: m.eventSlug };
	}

	return { nemesis, dominated, rival, gatekeeper, biggestUpset };
}

function computeCharacterStats(matches: LeagueMatch[], playerId: string): { name: string; iconUrl?: string; count: number }[] {
	const charCounts = new Map<string, { count: number; iconUrl?: string }>();
	for (const m of matches) {
		const chars = m.player1Id === playerId ? m.player1Characters : m.player2Characters;
		if (!chars) continue;
		for (const c of chars) {
			const existing = charCounts.get(c.name);
			charCounts.set(c.name, {
				count: (existing?.count ?? 0) + 1,
				iconUrl: existing?.iconUrl ?? c.iconUrl
			});
		}
	}
	return [...charCounts.entries()]
		.map(([name, { count, iconUrl }]) => ({ name, iconUrl, count }))
		.sort((a, b) => b.count - a.count);
}

export function computeSeasonAwards(season: LeagueSeason, overrideMinEvents?: number, config?: { minEvents?: number; attendanceBonus?: number }): SeasonAward[] {
	const awards: SeasonAward[] = [];
	const players = Object.values(season.players);
	const MIN_EVENTS = overrideMinEvents ?? Math.max(2, Math.floor(season.events.length * 0.4));

	// Most Attended (show all tied)
	const attendance = new Map<string, number>();
	for (const evt of season.events) {
		for (const p of evt.placements) {
			attendance.set(p.playerId, (attendance.get(p.playerId) ?? 0) + 1);
		}
	}
	const sortedAttendance = [...attendance.entries()].sort((a, b) => b[1] - a[1]);
	const maxAttendance = sortedAttendance[0]?.[1] ?? 0;
	const tied = sortedAttendance.filter(([, count]) => count === maxAttendance);
	if (tied.length > 0) {
		const tags = tied.map(([pid]) => season.players[pid]?.gamerTag ?? pid).filter(Boolean);
		awards.push({
			title: 'Most Attended',
			description: 'Simple count of events the player appeared in.',
			playerId: tied[0][0],
			playerTag: tags.join(', '),
			value: `${maxAttendance} events${tied.length > 1 ? ` (${tied.length}-way tie)` : ''}`
		});
	}

	// Most Consistent (avg percentile - stdev, min attendance)
	const playerPercentiles = new Map<string, number[]>();
	for (const evt of season.events) {
		const total = evt.placements.length;
		for (const pl of evt.placements) {
			const pct = ((total - pl.placement) / Math.max(total - 1, 1)) * 100;
			const arr = playerPercentiles.get(pl.playerId) ?? [];
			arr.push(pct);
			playerPercentiles.set(pl.playerId, arr);
		}
	}
	const consistencyScores: { pid: string; score: number }[] = [];
	for (const [pid, pcts] of playerPercentiles) {
		if (pcts.length < MIN_EVENTS) continue;
		const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
		const variance = pcts.reduce((s, v) => s + (v - avg) ** 2, 0) / pcts.length;
		consistencyScores.push({ pid, score: avg - Math.sqrt(variance) });
	}
	consistencyScores.sort((a, b) => b.score - a.score);
	if (consistencyScores.length > 0) {
		const top = consistencyScores[0];
		const p = season.players[top.pid];
		if (p) awards.push({
			title: 'Most Consistent',
			description: `Score = avg_percentile - stdev. Rewards both high placement and low variance. Min ${MIN_EVENTS} events.`,
			playerId: p.id, playerTag: p.gamerTag,
			value: `${Math.round(top.score)} consistency score`,
			candidates: consistencyScores.slice(1, 6).map((c) => ({
				playerId: c.pid,
				playerTag: season.players[c.pid]?.gamerTag ?? c.pid,
				value: `${Math.round(c.score)} score`
			}))
		});
	}

	// Most Improved (linear regression slope of points over events)
	const improvementScores: { pid: string; slope: number }[] = [];
	for (const p of players) {
		if ((attendance.get(p.id) ?? 0) < MIN_EVENTS) continue;
		const n = p.rankHistory.length;
		const xs = p.rankHistory.map((_, i) => i);
		const ys = p.rankHistory.map((h) => h.points);
		const xMean = xs.reduce((a, b) => a + b, 0) / n;
		const yMean = ys.reduce((a, b) => a + b, 0) / n;
		let num = 0, den = 0;
		for (let i = 0; i < n; i++) {
			num += (xs[i] - xMean) * (ys[i] - yMean);
			den += (xs[i] - xMean) ** 2;
		}
		const slope = den === 0 ? 0 : num / den;
		if (slope > 0) improvementScores.push({ pid: p.id, slope });
	}
	improvementScores.sort((a, b) => b.slope - a.slope);
	if (improvementScores.length > 0) {
		const top = improvementScores[0];
		const p = season.players[top.pid];
		if (p) awards.push({
			title: 'Most Improved',
			description: `Linear regression slope of TrueSkill points over events. Higher slope = faster improvement. Min ${MIN_EVENTS} events.`,
			playerId: p.id, playerTag: p.gamerTag,
			value: `+${Math.round(top.slope)} pts/event`,
			candidates: improvementScores.slice(1, 6).map((c) => ({
				playerId: c.pid,
				playerTag: season.players[c.pid]?.gamerTag ?? c.pid,
				value: `+${Math.round(c.slope)} pts/event`
			}))
		});
	}

	// Biggest Up and Comer (outside top 17, biggest single-event gain)
	const rankings = getRankings(season, config);
	const topIds = new Set(rankings.slice(0, 17).map((r) => r.playerId));
	const upComerScores: { pid: string; gain: number }[] = [];
	for (const p of players) {
		if (topIds.has(p.id)) continue;
		if ((attendance.get(p.id) ?? 0) < MIN_EVENTS) continue;
		let bestGain = 0;
		for (let i = 1; i < p.rankHistory.length; i++) {
			const gain = p.rankHistory[i].points - p.rankHistory[i - 1].points;
			if (gain > bestGain) bestGain = gain;
		}
		if (bestGain > 0) upComerScores.push({ pid: p.id, gain: bestGain });
	}
	upComerScores.sort((a, b) => b.gain - a.gain);
	if (upComerScores.length > 0) {
		const top = upComerScores[0];
		const p = season.players[top.pid];
		if (p) awards.push({
			title: 'Biggest Up and Comer',
			description: `Biggest single-event rating gain by a player outside the top 17. Min ${MIN_EVENTS} events.`,
			playerId: p.id, playerTag: p.gamerTag,
			value: `+${top.gain} pts in one event`,
			candidates: upComerScores.slice(1, 6).map((c) => ({
				playerId: c.pid,
				playerTag: season.players[c.pid]?.gamerTag ?? c.pid,
				value: `+${c.gain} pts`
			}))
		});
	}

	// Biggest Upset (highest points gap win, bracket only, non-DQ)
	let biggestUpset: { winnerId: string; loserId: string; gap: number; event: string } | null = null;
	for (const m of season.matches) {
		if (m.phase === 'swiss' || m.isDQ) continue;
		const winner = season.players[m.winnerId];
		const loser = season.players[m.winnerId === m.player1Id ? m.player2Id : m.player1Id];
		if (!winner || !loser) continue;
		if (loser.points <= winner.points) continue;
		const gap = loser.points - winner.points;
		if (!biggestUpset || gap > biggestUpset.gap)
			biggestUpset = { winnerId: winner.id, loserId: loser.id, gap, event: m.eventSlug };
	}
	if (biggestUpset) {
		const w = season.players[biggestUpset.winnerId];
		const l = season.players[biggestUpset.loserId];
		if (w && l) awards.push({
			title: 'Biggest Upset',
			description: 'Largest rating gap win in bracket (non-Swiss, non-DQ). Higher gap = bigger upset.',
			playerId: w.id, playerTag: w.gamerTag,
			secondPlayerId: l.id, secondPlayerTag: l.gamerTag,
			value: `+${biggestUpset.gap} pts gap vs ${l.gamerTag}`
		});
	}

	// Biggest Rivalry (closest h2h, min 3 sets, excluding DQs)
	const h2h = new Map<string, { p1: string; p2: string; p1Wins: number; p2Wins: number; total: number }>();
	for (const m of season.matches) {
		if (m.isDQ) continue;
		const key = [m.player1Id, m.player2Id].sort().join(':');
		const entry = h2h.get(key) ?? { p1: m.player1Id, p2: m.player2Id, p1Wins: 0, p2Wins: 0, total: 0 };
		const sorted = [m.player1Id, m.player2Id].sort();
		if (m.winnerId === sorted[0]) entry.p1Wins++;
		else entry.p2Wins++;
		entry.total++;
		entry.p1 = sorted[0];
		entry.p2 = sorted[1];
		h2h.set(key, entry);
	}
	const rivalries = [...h2h.values()]
		.filter((e) => e.total >= 3)
		.sort((a, b) => {
			const diffA = Math.abs(a.p1Wins - a.p2Wins);
			const diffB = Math.abs(b.p1Wins - b.p2Wins);
			if (diffA !== diffB) return diffA - diffB;
			return b.total - a.total;
		});
	if (rivalries.length > 0) {
		const best = rivalries[0];
		const p1 = season.players[best.p1];
		const p2 = season.players[best.p2];
		if (p1 && p2) awards.push({
			title: 'Rivalry of the Season',
			description: 'Closest head-to-head record with min 3 sets (non-DQ). Ranked by smallest win difference, then total sets as tiebreaker.',
			playerId: p1.id, playerTag: p1.gamerTag,
			secondPlayerId: p2.id, secondPlayerTag: p2.gamerTag,
			value: `${p1.gamerTag} ${best.p1Wins}-${best.p2Wins} ${p2.gamerTag}`,
			candidates: rivalries.slice(1, 6).map((r) => {
				const rp1 = season.players[r.p1];
				const rp2 = season.players[r.p2];
				return {
					playerId: r.p1,
					playerTag: `${rp1?.gamerTag ?? r.p1} vs ${rp2?.gamerTag ?? r.p2}`,
					value: `${r.p1Wins}-${r.p2Wins} (${r.total} sets)`
				};
			})
		});
	}

	return awards;
}
