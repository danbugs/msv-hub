export interface LeagueSeason {
	id: number;
	name: string;
	startDate: string;
	endDate: string;
	events: LeagueEvent[];
	players: Record<string, LeaguePlayer>;
	matches: LeagueMatch[];
	plannedSlugs?: string[];
}

export interface LeagueEvent {
	slug: string;
	name: string;
	date: string;
	eventNumber: number;
	entrantCount: number;
	placements: LeaguePlacement[];
	weight?: number;
}

export interface LeaguePlacement {
	playerId: string;
	gamerTag: string;
	placement: number;
}

export interface LeaguePlayer {
	id: string;
	gamerTag: string;
	aliases: string[];
	mu: number;
	sigma: number;
	points: number;
	rankHistory: LeagueRankSnapshot[];
}

export interface LeagueRankSnapshot {
	eventSlug: string;
	eventNumber: number;
	rank: number;
	points: number;
	mu: number;
	sigma: number;
}

export interface PlayerTier {
	name: string;
	color: string;
}

export const PLAYER_TIERS: { name: string; color: string; minPoints: number }[] = [
	{ name: 'Master', color: '#ef4444', minPoints: 7000 },
	{ name: 'Diamond', color: '#38bdf8', minPoints: 6500 },
	{ name: 'Platinum', color: '#a3e635', minPoints: 6000 },
	{ name: 'Gold', color: '#fbbf24', minPoints: 5500 },
	{ name: 'Silver', color: '#94a3b8', minPoints: 5000 },
	{ name: 'Bronze', color: '#d97706', minPoints: 4500 },
	{ name: 'Copper', color: '#b87333', minPoints: 4000 },
	{ name: 'Iron', color: '#78716c', minPoints: 0 },
];

export function getPlayerTier(points: number): PlayerTier {
	for (const t of PLAYER_TIERS) {
		if (points >= t.minPoints) return { name: t.name, color: t.color };
	}
	return { name: 'Iron', color: '#78716c' };
}

export interface TournamentTier {
	tier: string;
	color: string;
	avgPoints: number;
}

export function getTournamentTiers(eventAvgPoints: number[]): Map<number, TournamentTier> {
	if (eventAvgPoints.length === 0) return new Map();
	const sorted = [...eventAvgPoints].sort((a, b) => a - b);
	const p = (pct: number) => sorted[Math.min(Math.floor(pct * sorted.length), sorted.length - 1)];
	const thresholds: [number, string, string][] = [
		[p(0.8), 'S', '#ef4444'],
		[p(0.6), 'A', '#f87171'],
		[p(0.4), 'B', '#fbbf24'],
		[p(0.2), 'C', '#a3e635'],
	];
	const result = new Map<number, TournamentTier>();
	for (const avg of eventAvgPoints) {
		let tier: TournamentTier = { tier: 'D', color: '#94a3b8', avgPoints: avg };
		for (const [threshold, name, color] of thresholds) {
			if (avg >= threshold) { tier = { tier: name, color, avgPoints: avg }; break; }
		}
		result.set(avg, tier);
	}
	return result;
}

export interface CharacterSelection {
	name: string;
	iconUrl?: string;
}

export interface LeagueMatch {
	eventSlug: string;
	eventNumber: number;
	player1Id: string;
	player1Tag: string;
	player2Id: string;
	player2Tag: string;
	winnerId: string;
	player1Score: number;
	player2Score: number;
	player1Characters?: CharacterSelection[];
	player2Characters?: CharacterSelection[];
	isDQ?: boolean;
	phase: string;
	roundLabel: string;
	date: string;
	p1Delta?: number;
	p2Delta?: number;
	weight?: number;
}

export interface AwardCandidate {
	playerId: string;
	playerTag: string;
	value: string;
}

export interface SeasonAward {
	title: string;
	description: string;
	playerId?: string;
	playerTag?: string;
	secondPlayerId?: string;
	secondPlayerTag?: string;
	value: string;
	candidates?: AwardCandidate[];
}

export interface LeaguePlayerStats {
	player: LeaguePlayer;
	rank: number;
	totalPlayers: number;
	matchesPlayed: number;
	matchesWon: number;
	matchesLost: number;
	winRate: number;
	scoreFor: number;
	scoreAgainst: number;
	scoreDiff: number;
	tournamentsPlayed: number;
	tournamentStats: {
		top1: number;
		top3: number;
		top8: number;
		top16: number;
		top32: number;
	};
	redemptionCount: number;
	matchups: {
		nemesis: { tag: string; playerId: string; losses: number } | null;
		dominated: { tag: string; playerId: string; wins: number } | null;
		rival: { tag: string; playerId: string; wins: number; losses: number; total: number } | null;
		gatekeeper: { tag: string; playerId: string; wins: number; losses: number; closeGames: number } | null;
		biggestUpset: { tag: string; playerId: string; upsetFactor: number; eventSlug: string } | null;
	};
	characters: { name: string; iconUrl?: string; count: number }[];
	recentMatches: LeagueMatch[];
	matchesByEvent: {
		slug: string;
		name: string;
		date: string;
		eventNumber: number;
		placement?: number;
		matches: LeagueMatch[];
	}[];
	bestWins: {
		oppTag: string;
		oppId: string;
		oppPoints: number;
		oppRank: number;
		eventSlug: string;
		date: string;
		score: string;
	}[];
}
