import type { TournamentMode } from '$lib/types/tournament';

/** Modes where every entrant plays in the main bracket and redemption is built from its early exits. */
export function isAllToMainMode(mode: TournamentMode | undefined): boolean {
	return mode === 'gauntlet' || mode === 'experimental1' || mode === 'experimental2';
}

/** Modes that play a fixed three Swiss rounds before the bracket. */
export function isShortSwissMode(mode: TournamentMode | undefined): boolean {
	return mode === 'experimental1' || mode === 'experimental2';
}

/** Modes where the bottom half of the Swiss standings starts the main bracket in losers. */
export function isSplitStartMode(mode: TournamentMode | undefined): boolean {
	return mode === 'experimental2';
}

export function modeLabel(mode: TournamentMode | undefined): string {
	if (mode === 'gauntlet') return 'Macro Default';
	if (mode === 'experimental1') return 'Experimental #1';
	if (mode === 'experimental2') return 'Experimental #2';
	return 'Default';
}
