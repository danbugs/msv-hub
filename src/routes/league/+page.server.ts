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
	const rankConfig = seasonId === 0 ? { ...config, attendanceBonus: 5 } : config;
	const rankings = getRankings(season, rankConfig);

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

	// Season stats
	const mainWinCounts = new Map<string, { tag: string; count: number }>();
	const redemptionWinCounts = new Map<string, { tag: string; count: number }>();
	for (const m of season.matches) {
		if (m.roundLabel !== 'Grand Final' && m.roundLabel !== 'Grand Final Reset') continue;
		const tag = m.winnerId === m.player1Id ? m.player1Tag : m.player2Tag;
		if (m.phase === 'winners') {
			const e = mainWinCounts.get(m.winnerId) ?? { tag, count: 0 };
			e.count++;
			mainWinCounts.set(m.winnerId, e);
		} else if (m.phase === 'redemption-winners') {
			const e = redemptionWinCounts.get(m.winnerId) ?? { tag, count: 0 };
			e.count++;
			redemptionWinCounts.set(m.winnerId, e);
		}
	}
	const mainWins = [...mainWinCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);
	const redemptionWins = [...redemptionWinCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

	const streaks = new Map<string, number>();
	const currentStreak = new Map<string, number>();
	for (const m of season.matches) {
		if (m.isDQ) continue;
		for (const pid of [m.player1Id, m.player2Id]) {
			if (m.winnerId === pid) {
				const cur = (currentStreak.get(pid) ?? 0) + 1;
				currentStreak.set(pid, cur);
				if (cur > (streaks.get(pid) ?? 0)) streaks.set(pid, cur);
			} else {
				currentStreak.set(pid, 0);
			}
		}
	}
	const topStreaks = [...streaks.entries()]
		.map(([pid, streak]) => ({ tag: season.players[pid]?.gamerTag ?? pid, streak }))
		.sort((a, b) => b.streak - a.streak)
		.slice(0, 5);

	const winRates = rankings
		.map((r) => {
			const stats = playerMatchCounts.get(r.playerId);
			const total = (stats?.wins ?? 0) + (stats?.losses ?? 0);
			return { tag: r.gamerTag, rate: total > 0 ? Math.round(((stats?.wins ?? 0) / total) * 100) : 0, total };
		})
		.filter((r) => r.total >= 20)
		.sort((a, b) => b.rate - a.rate)
		.slice(0, 5);

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
		stats: { mainWins, redemptionWins, topStreaks, winRates },
		seasonId,
		seasonParam,
		seasons
	};
};
