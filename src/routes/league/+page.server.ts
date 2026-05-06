import type { PageServerLoad } from './$types';
import { getLeagueSeason, getRankings, getLeagueConfig, getSeasonIndex } from '$lib/server/league-store';
import { getPlayerTier, getTournamentTiers } from '$lib/types/league';

export const load: PageServerLoad = async ({ url }) => {
	const seasonParam = url.searchParams.get('season') ?? '10';
	const seasonId = seasonParam === 'all-time' ? 0 : parseInt(seasonParam, 10);
	const season = await getLeagueSeason(seasonId);
	const seasons = await getSeasonIndex();

	if (!season) return { season: null, rankings: [], seasonId, seasonParam, events: [], awards: [], seasons };

	const config = await getLeagueConfig();
	const rankings = getRankings(season, config);

	const playerMatchCounts = new Map<string, { wins: number; losses: number; events: Set<string> }>();
	for (const m of season.matches) {
		for (const pid of [m.player1Id, m.player2Id]) {
			if (!playerMatchCounts.has(pid)) playerMatchCounts.set(pid, { wins: 0, losses: 0, events: new Set() });
			const entry = playerMatchCounts.get(pid)!;
			entry.events.add(m.eventSlug);
			if (m.winnerId === pid) entry.wins++;
			else entry.losses++;
		}
	}

	const playerChars = new Map<string, Map<string, { count: number; iconUrl?: string }>>();
	for (const m of season.matches) {
		for (const [pid, chars] of [[m.player1Id, m.player1Characters], [m.player2Id, m.player2Characters]] as const) {
			if (!chars) continue;
			const charMap = playerChars.get(pid) ?? new Map();
			for (const c of chars) {
				const existing = charMap.get(c.name);
				charMap.set(c.name, { count: (existing?.count ?? 0) + 1, iconUrl: existing?.iconUrl ?? c.iconUrl });
			}
			playerChars.set(pid, charMap);
		}
	}

	const enrichedRankings = rankings.map((r) => {
		const stats = playerMatchCounts.get(r.playerId);
		const player = season.players[r.playerId];
		const tier = getPlayerTier(r.points);
		const chars = playerChars.get(r.playerId);
		const topChars = chars
			? [...chars.entries()]
				.sort((a, b) => b[1].count - a[1].count)
				.slice(0, 2)
				.map(([name, { iconUrl }]) => ({ name, iconUrl }))
			: [];
		return {
			...r,
			aliases: player?.aliases ?? [],
			wins: stats?.wins ?? 0,
			losses: stats?.losses ?? 0,
			events: stats?.events.size ?? 0,
			tier: tier.name,
			tierColor: tier.color,
			characters: topChars
		};
	});

	const eventAvgs = season.events.map((evt) => {
		const attendeeIds = new Set(evt.placements.map((p) => p.playerId));
		const attendeePoints = [...attendeeIds]
			.map((id) => season.players[id]?.points ?? 5000)
			.filter((p) => p > 0);
		return attendeePoints.length > 0
			? Math.round(attendeePoints.reduce((a, b) => a + b, 0) / attendeePoints.length)
			: 5000;
	});
	const tierMap = getTournamentTiers(eventAvgs);
	const eventTiers = season.events.map((evt, i) => {
		const avg = eventAvgs[i];
		const tier = tierMap.get(avg) ?? { tier: 'D', color: '#94a3b8', avgPoints: avg };
		return {
			slug: evt.slug,
			name: evt.name,
			date: evt.date,
			eventNumber: evt.eventNumber,
			entrantCount: evt.entrantCount,
			...tier
		};
	});

	return {
		season: {
			id: season.id,
			name: season.name,
			startDate: season.startDate,
			endDate: season.endDate,
			eventCount: season.events.length
		},
		rankings: enrichedRankings,
		events: eventTiers.reverse(),
		seasonId,
		seasonParam,
		seasons
	};
};
