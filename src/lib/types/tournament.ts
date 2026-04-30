export interface StartggSyncState {
	/** True once the user confirms the main/redemption split is reflected in StartGG */
	splitConfirmed: boolean;
	/** Bracket match IDs (bracketName:matchId) awaiting report once split is confirmed */
	pendingBracketMatchIds: string[];
	/** Recent StartGG errors — shown in UI, cleared on next successful report */
	errors: { matchId: string; message: string; ts: number }[];
	/**
	 * True once the round's set IDs have been pre-cached from StartGG (real IDs, not preview).
	 * False while triggerConversionAndCache is running. Undefined = no sync attempted yet.
	 */
	cacheReady?: boolean;
	/**
	 * Set when a misreport fix regenerated pairings for a round whose pool is already started
	 * on StartGG. The user must reset the phase on StartGG, then click "Phase Reset Done"
	 * to re-seed and re-convert.
	 */
	pendingPhaseReset?: { roundNumber: number; phaseGroupId: number; phaseId: number };
}

/** Core tournament state persisted in Redis */
export interface TournamentState {
	slug: string;
	name: string;
	phase: 'swiss' | 'brackets' | 'completed';
	mode?: 'default' | 'gauntlet';
	entrants: Entrant[];
	settings: TournamentSettings;
	rounds: SwissRound[];
	currentRound: number;
	finalStandings?: FinalStanding[];
	brackets?: { main: BracketState; redemption?: BracketState };
	createdAt: number;
	updatedAt: number;
	/** StartGG event ID — set when tournament is loaded from a StartGG event */
	startggEventId?: number;
	/** Original StartGG event slug (e.g. tournament/foo/event/bar) — used to pre-fill seeder */
	startggEventSlug?: string;
	/** StartGG phase ID for the Swiss phase — needed for updatePhaseSeeding */
	startggPhase1Id?: number;
	/** Phase groups for the Swiss rounds — one entry per round, indexed by round-1.
	 *  Each round may belong to a different StartGG phase (separate phases per round). */
	startggPhase1Groups?: { id: number; displayIdentifier: string; phaseId?: number; roundNumber?: number }[];
	/** StartGG phase ID for the "Final Standings" phase — used to push Swiss standings after bracket split */
	startggFinalStandingsPhaseId?: number;
	/** StartGG phase group ID inside the Final Standings phase */
	startggFinalStandingsPhaseGroupId?: number;
	/** StartGG event ID for the main bracket (separate event on StartGG) */
	startggMainBracketEventId?: number;
	/** StartGG event ID for the redemption bracket (separate event on StartGG) */
	startggRedemptionBracketEventId?: number;
	/** StartGG sync state for bracket reporting */
	startggSync?: StartggSyncState;
	/** Attendance and setup tracking — persisted for TO collaboration */
	attendance?: AttendeeStatus[];
}

export interface AttendeeStatus {
	gamerTag: string;
	/** Pledged a setup during registration */
	pledgedSetup: boolean;
	/** TO confirmed player is present at venue */
	present?: boolean;
	/** TO confirmed player has set up their station */
	setupDeployed?: boolean;
	/** Player arriving late — accounted for but not at venue yet */
	late?: boolean;
	/** Registration timestamp from StartGG */
	registeredAt?: string;
	/** Discord user ID for pinging */
	discordId?: string;
}

export interface Entrant {
	id: string;
	gamerTag: string;
	initialSeed: number;
	/** StartGG entrant ID — populated when tournament is loaded from a StartGG event */
	startggEntrantId?: number;
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
	topScore?: number;
	bottomScore?: number;
	/** True if the loser won by DQ (opponent absent) */
	isDQ?: boolean;
	station?: number;
	isStream?: boolean;
	/** StartGG set ID — cached after first successful match lookup */
	startggSetId?: string;
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
	topScore?: number;
	bottomScore?: number;
	/** True if the loser won by DQ (opponent absent) */
	isDQ?: boolean;
	topCharacters?: string[];
	bottomCharacters?: string[];
	/** Per-game winner: 'top' or 'bottom' for each game (used for accurate StartGG reporting) */
	gameWinners?: ('top' | 'bottom')[];
	/** Where winner advances to */
	winnerNextMatchId?: string;
	winnerNextSlot?: 'top' | 'bottom';
	/** Where loser drops to (DE only) */
	loserNextMatchId?: string;
	loserNextSlot?: 'top' | 'bottom';
	station?: number;
	isStream?: boolean;
	/** Timestamp (ms) when TO called this match to the station */
	calledAt?: number;
	/** StartGG set ID — cached after first successful match lookup */
	startggSetId?: string;
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
