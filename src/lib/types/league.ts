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
		mostWon: { tag: string; playerId: string; count: number } | null;
		mostLost: { tag: string; playerId: string; count: number } | null;
		mostPlayed: { tag: string; playerId: string; count: number } | null;
		bestWinRate: { tag: string; playerId: string; rate: number; total: number } | null;
		worstWinRate: { tag: string; playerId: string; rate: number; total: number } | null;
	};
	characters: { name: string; iconUrl?: string; count: number }[];
	recentMatches: LeagueMatch[];
}
