import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import type { LeagueSeason, LeaguePlayerStats, LeagueMatch, SeasonAward } from '$lib/types/league';

const LEAGUE_SEASON_PREFIX = 'league:season:';
const LEAGUE_MERGES_KEY = 'league:merges';

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

export function getRankings(season: LeagueSeason): { playerId: string; gamerTag: string; points: number; rank: number }[] {
	const players = Object.values(season.players);
	players.sort((a, b) => b.points - a.points || a.sigma - b.sigma);
	return players.map((p, i) => ({
		playerId: p.id,
		gamerTag: p.gamerTag,
		points: p.points,
		rank: i + 1
	}));
}

export function getPlayerStats(season: LeagueSeason, playerId: string): LeaguePlayerStats | null {
	const player = season.players[playerId];
	if (!player) return null;

	const rankings = getRankings(season);
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

	const matchups = computeMatchups(playerMatches, playerId, season);
	const characters = computeCharacterStats(playerMatches, playerId);

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
		matchups,
		characters,
		recentMatches: [...playerMatches].reverse()
	};
}

function computeMatchups(matches: LeagueMatch[], playerId: string, season: LeagueSeason) {
	const opponents = new Map<string, { tag: string; wins: number; losses: number; total: number; closeGames: number }>();

	for (const m of matches) {
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
		if (m.winnerId !== playerId) continue;
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

export function computeSeasonAwards(season: LeagueSeason): SeasonAward[] {
	const awards: SeasonAward[] = [];
	const players = Object.values(season.players);
	const MIN_EVENTS = Math.max(2, Math.floor(season.events.length * 0.4));

	// Most Attended
	const attendance = new Map<string, number>();
	for (const evt of season.events) {
		for (const p of evt.placements) {
			attendance.set(p.playerId, (attendance.get(p.playerId) ?? 0) + 1);
		}
	}
	const mostAttended = [...attendance.entries()].sort((a, b) => b[1] - a[1])[0];
	if (mostAttended) {
		const p = season.players[mostAttended[0]];
		if (p) awards.push({
			title: 'Iron Man',
			description: 'Most events attended',
			playerId: p.id, playerTag: p.gamerTag,
			value: `${mostAttended[1]} events`
		});
	}

	// Most Consistent (avg percentile - stdev, min 40% attendance)
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
	let bestConsistency = -Infinity;
	let consistentPlayer: string | null = null;
	for (const [pid, pcts] of playerPercentiles) {
		if (pcts.length < MIN_EVENTS) continue;
		const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
		const variance = pcts.reduce((s, v) => s + (v - avg) ** 2, 0) / pcts.length;
		const score = avg - Math.sqrt(variance);
		if (score > bestConsistency) { bestConsistency = score; consistentPlayer = pid; }
	}
	if (consistentPlayer) {
		const p = season.players[consistentPlayer];
		if (p) awards.push({
			title: 'The Rock',
			description: 'Most consistent performer',
			playerId: p.id, playerTag: p.gamerTag,
			value: `${Math.round(bestConsistency)} consistency score`
		});
	}

	// Most Improved (linear regression slope of points over events)
	let bestSlope = -Infinity;
	let improvedPlayer: string | null = null;
	for (const p of players) {
		if (p.rankHistory.length < MIN_EVENTS) continue;
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
		if (slope > bestSlope) { bestSlope = slope; improvedPlayer = p.id; }
	}
	if (improvedPlayer && bestSlope > 0) {
		const p = season.players[improvedPlayer];
		if (p) awards.push({
			title: 'Rising Star',
			description: 'Most improved rating trend',
			playerId: p.id, playerTag: p.gamerTag,
			value: `+${Math.round(bestSlope)} pts/event`
		});
	}

	// Biggest Up and Comer (outside top 17, biggest single-event gain)
	const rankings = getRankings(season);
	const topIds = new Set(rankings.slice(0, 17).map((r) => r.playerId));
	let bestGain = 0;
	let upComer: { id: string; gain: number } | null = null;
	for (const p of players) {
		if (topIds.has(p.id)) continue;
		for (let i = 1; i < p.rankHistory.length; i++) {
			const gain = p.rankHistory[i].points - p.rankHistory[i - 1].points;
			if (gain > bestGain) { bestGain = gain; upComer = { id: p.id, gain }; }
		}
	}
	if (upComer) {
		const p = season.players[upComer.id];
		if (p) awards.push({
			title: 'Up and Comer',
			description: 'Biggest single-event breakout (outside top 17)',
			playerId: p.id, playerTag: p.gamerTag,
			value: `+${upComer.gain} pts in one event`
		});
	}

	// Biggest Upset (highest points gap win, bracket only)
	let biggestUpset: { winnerId: string; loserId: string; gap: number; event: string } | null = null;
	for (const m of season.matches) {
		if (m.phase === 'swiss') continue;
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
			title: 'Giant Slayer',
			description: 'Biggest bracket upset of the season',
			playerId: w.id, playerTag: w.gamerTag,
			secondPlayerId: l.id, secondPlayerTag: l.gamerTag,
			value: `+${biggestUpset.gap} pts gap vs ${l.gamerTag}`
		});
	}

	// Biggest Rivalry (closest h2h, min 3 sets)
	const h2h = new Map<string, { p1: string; p2: string; p1Wins: number; p2Wins: number; total: number }>();
	for (const m of season.matches) {
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
	let bestRivalry: { p1: string; p2: string; p1Wins: number; p2Wins: number; total: number } | null = null;
	for (const entry of h2h.values()) {
		if (entry.total < 3) continue;
		const diff = Math.abs(entry.p1Wins - entry.p2Wins);
		if (!bestRivalry ||
			diff < Math.abs(bestRivalry.p1Wins - bestRivalry.p2Wins) ||
			(diff === Math.abs(bestRivalry.p1Wins - bestRivalry.p2Wins) && entry.total > bestRivalry.total))
			bestRivalry = entry;
	}
	if (bestRivalry) {
		const p1 = season.players[bestRivalry.p1];
		const p2 = season.players[bestRivalry.p2];
		if (p1 && p2) awards.push({
			title: 'Rivalry of the Season',
			description: 'Closest head-to-head record',
			playerId: p1.id, playerTag: p1.gamerTag,
			secondPlayerId: p2.id, secondPlayerTag: p2.gamerTag,
			value: `${p1.gamerTag} ${bestRivalry.p1Wins}-${bestRivalry.p2Wins} ${p2.gamerTag}`
		});
	}

	return awards;
}
