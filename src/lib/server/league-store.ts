import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import type { LeagueSeason, LeaguePlayerStats, LeagueMatch } from '$lib/types/league';

const LEAGUE_SEASON_PREFIX = 'league:season:';

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

	const matchups = computeMatchups(playerMatches, playerId);

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
		recentMatches: [...playerMatches].reverse()
	};
}

function computeMatchups(matches: LeagueMatch[], playerId: string) {
	const opponents = new Map<string, { tag: string; wins: number; losses: number; total: number }>();

	for (const m of matches) {
		const isP1 = m.player1Id === playerId;
		const oppId = isP1 ? m.player2Id : m.player1Id;
		const oppTag = isP1 ? m.player2Tag : m.player1Tag;
		const won = m.winnerId === playerId;
		const opp = opponents.get(oppId) ?? { tag: oppTag, wins: 0, losses: 0, total: 0 };
		if (won) opp.wins++;
		else opp.losses++;
		opp.total++;
		opp.tag = oppTag;
		opponents.set(oppId, opp);
	}

	let mostWon: { tag: string; playerId: string; count: number } | null = null;
	let mostLost: { tag: string; playerId: string; count: number } | null = null;
	let mostPlayed: { tag: string; playerId: string; count: number } | null = null;
	let bestWinRate: { tag: string; playerId: string; rate: number; total: number } | null = null;
	let worstWinRate: { tag: string; playerId: string; rate: number; total: number } | null = null;

	const MIN_MATCHES_FOR_RATE = 3;

	for (const [oppId, opp] of opponents) {
		if (!mostWon || opp.wins > mostWon.count) mostWon = { tag: opp.tag, playerId: oppId, count: opp.wins };
		if (!mostLost || opp.losses > mostLost.count) mostLost = { tag: opp.tag, playerId: oppId, count: opp.losses };
		if (!mostPlayed || opp.total > mostPlayed.count) mostPlayed = { tag: opp.tag, playerId: oppId, count: opp.total };
		if (opp.total >= MIN_MATCHES_FOR_RATE) {
			const rate = Math.round((opp.wins / opp.total) * 100);
			if (!bestWinRate || rate > bestWinRate.rate) bestWinRate = { tag: opp.tag, playerId: oppId, rate, total: opp.total };
			if (!worstWinRate || rate < worstWinRate.rate) worstWinRate = { tag: opp.tag, playerId: oppId, rate, total: opp.total };
		}
	}

	return { mostWon, mostLost, mostPlayed, bestWinRate, worstWinRate };
}
