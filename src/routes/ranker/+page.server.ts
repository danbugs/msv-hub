import type { PageServerLoad } from './$types';
import type { LeagueMatch } from '$lib/types/league';
import { getLeagueSeason, getRankings, getLeagueConfig, getRatingConfigForSeason } from '$lib/server/league-store';

export interface RankerPlayer {
	id: string;
	tag: string;
	rank: number;
	character?: string;
	iconUrl?: string;
}

type MainChar = { name: string; iconUrl?: string; count: number };

// Character reporting is sparse, so a couple of stray season picks shouldn't override a long-time main
const MIN_SEASON_GAMES = 5;

// Most-picked character per player; "Random" isn't a main worth showing
function mainCharacters(matches: LeagueMatch[], wanted: Set<string>): Map<string, MainChar> {
	const counts = new Map<string, Map<string, { count: number; iconUrl?: string }>>();
	for (const m of matches) {
		for (const [pid, chars] of [[m.player1Id, m.player1Characters], [m.player2Id, m.player2Characters]] as const) {
			if (!chars || !wanted.has(pid)) continue;
			let perPlayer = counts.get(pid);
			if (!perPlayer) counts.set(pid, (perPlayer = new Map()));
			for (const c of chars) {
				if (c.name === 'Random Character') continue;
				const e = perPlayer.get(c.name);
				perPlayer.set(c.name, { count: (e?.count ?? 0) + 1, iconUrl: e?.iconUrl ?? c.iconUrl });
			}
		}
	}
	const mains = new Map<string, MainChar>();
	for (const [pid, perPlayer] of counts) {
		let best: [string, { count: number; iconUrl?: string }] | undefined;
		for (const entry of perPlayer) {
			if (!best || entry[1].count > best[1].count) best = entry;
		}
		if (best) mains.set(pid, { name: best[0], ...best[1] });
	}
	return mains;
}

export const load: PageServerLoad = async () => {
	const config = await getLeagueConfig();
	const seasonId = config.defaultSeason;
	const [season, allTime] = await Promise.all([getLeagueSeason(seasonId), getLeagueSeason(0)]);
	if (!allTime) return { season: null, players: [] as RankerPlayer[] };

	// Pool is the All-Time ranking with the same rules as the league page's All-Time tab
	const rankings = getRankings(allTime, {
		...config,
		attendanceBonus: 5,
		conservativeFactor: getRatingConfigForSeason(config, 0).conservativeFactor ?? 0
	});

	// Prefer what they play now; fall back to all-time when the season sample is too thin to trust
	const wanted = new Set(rankings.map((r) => r.playerId));
	const seasonMains = season ? mainCharacters(season.matches, wanted) : new Map<string, MainChar>();
	const allTimeMains = mainCharacters(allTime.matches, wanted);

	const players: RankerPlayer[] = rankings.map((r) => {
		const seasonMain = seasonMains.get(r.playerId);
		const main = (seasonMain && seasonMain.count >= MIN_SEASON_GAMES ? seasonMain : allTimeMains.get(r.playerId)) ?? seasonMain;
		return { id: r.playerId, tag: r.gamerTag, rank: r.rank, character: main?.name, iconUrl: main?.iconUrl };
	});

	return { season: { id: allTime.id, name: 'All-Time' }, players };
};
