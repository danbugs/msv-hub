/** Core tournament state persisted in Redis */
export interface TournamentState {
	slug: string;
	name: string;
	phase: 'swiss' | 'brackets' | 'completed';
	entrants: Entrant[];
	settings: TournamentSettings;
	rounds: SwissRound[];
	currentRound: number;
	finalStandings?: FinalStanding[];
	brackets?: { main: BracketState; redemption: BracketState };
	createdAt: number;
	updatedAt: number;
}

export interface Entrant {
	id: string;
	gamerTag: string;
	initialSeed: number;
}

export interface TournamentSettings {
	numRounds: number;
	numStations: number;
	streamStation: number; // which station number is stream (usually 1)
}

export interface SwissMatch {
	id: string;
	topPlayerId: string;
	bottomPlayerId: string;
	winnerId?: string;
	station?: number;
	isStream?: boolean;
}

export interface SwissRound {
	number: number;
	status: 'pending' | 'active' | 'completed';
	matches: SwissMatch[];
	byePlayerId?: string;
}

export interface FinalStanding {
	rank: number;
	entrantId: string;
	gamerTag: string;
	wins: number;
	losses: number;
	initialSeed: number;
	totalScore: number;
	basePoints: number;
	winPoints: number;
	lossPoints: number;
	cinderellaBonus: number;
	expectedWins: number;
	winsAboveExpected: number;
	bracket: 'main' | 'redemption';
}

export interface BracketMatch {
	id: string;
	round: number; // positive = winners, negative = losers
	matchIndex: number;
	topPlayerId?: string;
	bottomPlayerId?: string;
	winnerId?: string;
	loserId?: string;
	topCharacter?: string;
	bottomCharacter?: string;
	/** Where winner advances to */
	winnerNextMatchId?: string;
	winnerNextSlot?: 'top' | 'bottom';
	/** Where loser drops to (DE only) */
	loserNextMatchId?: string;
	loserNextSlot?: 'top' | 'bottom';
	station?: number;
}

export interface BracketState {
	name: string;
	type: 'double_elimination';
	players: { entrantId: string; seed: number }[];
	matches: BracketMatch[];
	currentRound: number;
}

/** Standings used during Swiss pairing */
export interface PlayerStanding {
	gamerTag: string;
	entrantId: string;
	seed: number;
	wins: number;
	losses: number;
	opponents: string[]; // entrant IDs
	opponentWins: number;
	byes: number;
}

/** Stream recommendation */
export interface StreamRecommendation {
	matchId: string;
	topPlayer: string;
	bottomPlayer: string;
	hypeScore: number;
	reasons: string[];
}
