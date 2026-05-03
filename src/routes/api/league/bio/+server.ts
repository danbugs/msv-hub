import type { RequestHandler } from './$types';
import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import { getLeagueSeason, getPlayerStats } from '$lib/server/league-store';
import { getPlayerTier } from '$lib/types/league';
import { generatePlayerBio } from '$lib/server/ai';

function getRedis(): Redis {
	return new Redis({ url: env.UPSTASH_REDIS_REST_URL!, token: env.UPSTASH_REDIS_REST_TOKEN! });
}

function bioKey(seasonId: number, playerId: string): string {
	return `league:bio:${seasonId}:${playerId}`;
}

export const GET: RequestHandler = async ({ url }) => {
	const seasonId = parseInt(url.searchParams.get('season') ?? '10', 10);
	const playerId = url.searchParams.get('playerId');
	if (!playerId) return Response.json({ error: 'Missing playerId' }, { status: 400 });

	const redis = getRedis();
	const cached = await redis.get<string>(bioKey(seasonId, playerId));
	if (cached) return Response.json({ bio: cached });

	const season = await getLeagueSeason(seasonId);
	if (!season) return Response.json({ error: 'Season not found' }, { status: 404 });

	const stats = getPlayerStats(season, playerId);
	if (!stats) return Response.json({ error: 'Player not found' }, { status: 404 });

	const tier = getPlayerTier(stats.player.points);
	const history = stats.player.rankHistory;
	let trend: 'rising' | 'falling' | 'steady' = 'steady';
	if (history.length >= 3) {
		const recent = history.slice(-3);
		const pointsDiff = recent[recent.length - 1].points - recent[0].points;
		if (pointsDiff > 100) trend = 'rising';
		else if (pointsDiff < -100) trend = 'falling';
	}

	const bio = await generatePlayerBio({
		gamerTag: stats.player.gamerTag,
		rank: stats.rank,
		totalPlayers: stats.totalPlayers,
		points: stats.player.points,
		tier: tier.name,
		winRate: stats.winRate,
		matchesPlayed: stats.matchesPlayed,
		tournamentsPlayed: stats.tournamentsPlayed,
		characters: stats.characters.slice(0, 3).map((c) => c.name),
		nemesis: stats.matchups.nemesis?.tag,
		rival: stats.matchups.rival?.tag,
		dominated: stats.matchups.dominated?.tag,
		tournamentStats: stats.tournamentStats,
		trend
	});

	if (bio) await redis.set(bioKey(seasonId, playerId), bio);

	return Response.json({ bio });
};
