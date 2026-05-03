import type { PageServerLoad } from './$types';
import { getLeagueSeason, getRankings, computeSeasonAwards } from '$lib/server/league-store';
import { getPlayerTier, getTournamentTier } from '$lib/types/league';

export const load: PageServerLoad = async ({ url }) => {
	const seasonId = parseInt(url.searchParams.get('season') ?? '10', 10);
	const season = await getLeagueSeason(seasonId);

	if (!season) return { season: null, rankings: [], seasonId };

	const rankings = getRankings(season);

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

	const enrichedRankings = rankings.map((r) => {
		const stats = playerMatchCounts.get(r.playerId);
		const player = season.players[r.playerId];
		const tier = getPlayerTier(r.points);
		return {
			...r,
			aliases: player?.aliases ?? [],
			wins: stats?.wins ?? 0,
			losses: stats?.losses ?? 0,
			events: stats?.events.size ?? 0,
			tier: tier.name,
			tierColor: tier.color
		};
	});

	const eventTiers = season.events.map((evt) => {
		const attendeeIds = new Set(evt.placements.map((p) => p.playerId));
		const attendeePoints = [...attendeeIds]
			.map((id) => season.players[id]?.points ?? 5000)
			.filter((p) => p > 0);
		const avg = attendeePoints.length > 0
			? Math.round(attendeePoints.reduce((a, b) => a + b, 0) / attendeePoints.length)
			: 5000;
		return {
			slug: evt.slug,
			name: evt.name,
			date: evt.date,
			eventNumber: evt.eventNumber,
			entrantCount: evt.entrantCount,
			...getTournamentTier(avg)
		};
	});

	const awards = computeSeasonAwards(season);

	return {
		season: {
			id: season.id,
			name: season.name,
			startDate: season.startDate,
			endDate: season.endDate,
			eventCount: season.events.length
		},
		rankings: enrichedRankings,
		events: eventTiers,
		awards,
		seasonId
	};
};
