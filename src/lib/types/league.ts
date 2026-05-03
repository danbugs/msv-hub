export interface LeagueSeason {
	id: number;
	name: string;
	startDate: string;
	endDate: string;
	events: LeagueEvent[];
	players: Record<string, LeaguePlayer>;
	matches: LeagueMatch[];
}

export interface LeagueEvent {
	slug: string;
	name: string;
	date: string;
	eventNumber: number;
	entrantCount: number;
	placements: LeaguePlacement[];
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

export function getPlayerTier(points: number): PlayerTier {
	if (points >= 7000) return { name: 'Master', color: '#e879f9' };
	if (points >= 6500) return { name: 'Diamond', color: '#38bdf8' };
	if (points >= 6000) return { name: 'Platinum', color: '#a3e635' };
	if (points >= 5500) return { name: 'Gold', color: '#fbbf24' };
	if (points >= 5000) return { name: 'Silver', color: '#94a3b8' };
	return { name: 'Bronze', color: '#d97706' };
}

export interface TournamentTier {
	tier: string;
	color: string;
	avgPoints: number;
}

export function getTournamentTier(avgPoints: number): TournamentTier {
	if (avgPoints >= 5800) return { tier: 'S', color: '#e879f9', avgPoints };
	if (avgPoints >= 5500) return { tier: 'A', color: '#f87171', avgPoints };
	if (avgPoints >= 5300) return { tier: 'B', color: '#fbbf24', avgPoints };
	if (avgPoints >= 5100) return { tier: 'C', color: '#a3e635', avgPoints };
	return { tier: 'D', color: '#94a3b8', avgPoints };
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
	phase: string;
	roundLabel: string;
	date: string;
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
	matchups: {
		nemesis: { tag: string; playerId: string; losses: number } | null;
		dominated: { tag: string; playerId: string; wins: number } | null;
		rival: { tag: string; playerId: string; wins: number; losses: number; total: number } | null;
		gatekeeper: { tag: string; playerId: string; wins: number; losses: number; closeGames: number } | null;
		biggestUpset: { tag: string; playerId: string; upsetFactor: number; eventSlug: string } | null;
	};
	characters: { name: string; iconUrl?: string; count: number }[];
	recentMatches: LeagueMatch[];
}
