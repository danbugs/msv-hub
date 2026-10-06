import { describe, it, expect } from 'vitest';
import { myMatchStatus } from './my-match';
import type { TournamentState, BracketMatch } from '$lib/types/tournament';

function base(over: Partial<TournamentState>): TournamentState {
	return {
		slug: 's', name: 'n', phase: 'swiss',
		entrants: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, gamerTag: id.toUpperCase(), initialSeed: i + 1 })),
		settings: { numRounds: 3, numStations: 8, streamStation: 1 },
		rounds: [], currentRound: 0, createdAt: 0, updatedAt: 0,
		...over
	};
}

describe('myMatchStatus — swiss', () => {
	const t = base({
		currentRound: 1,
		rounds: [{
			number: 1, status: 'active', byePlayerId: 'e',
			matches: [
				{ id: 'm1', topPlayerId: 'a', bottomPlayerId: 'b', station: 3 },
				{ id: 'm2', topPlayerId: 'c', bottomPlayerId: 'd', winnerId: 'd', isStream: true }
			]
		}]
	});

	it('shows station and opponent for an unplayed match', () => {
		expect(myMatchStatus(t, 'b')).toEqual({ kind: 'swiss-playing', round: 1, opponentId: 'a', station: 3, isStream: undefined });
	});
	it('reports result once the match is in', () => {
		expect(myMatchStatus(t, 'c')).toEqual({ kind: 'swiss-reported', round: 1, won: false, lastRound: false });
	});
	it('handles byes', () => {
		expect(myMatchStatus(t, 'e')).toEqual({ kind: 'swiss-bye', round: 1 });
	});
	it('waits before round 1 starts', () => {
		expect(myMatchStatus(base({}), 'a').kind).toBe('swiss-waiting');
	});
});

describe('myMatchStatus — brackets', () => {
	const matches: BracketMatch[] = [
		{ id: 'W1-0', round: 1, matchIndex: 0, topPlayerId: 'a', bottomPlayerId: 'b', winnerId: 'a', winnerNextMatchId: 'W2-0', winnerNextSlot: 'top' },
		{ id: 'W1-1', round: 1, matchIndex: 1, topPlayerId: 'c', bottomPlayerId: 'd', station: 5, calledAt: 123, winnerNextMatchId: 'W2-0', winnerNextSlot: 'bottom' },
		{ id: 'W2-0', round: 2, matchIndex: 0, topPlayerId: 'a' }
	];
	const t = base({
		phase: 'brackets',
		brackets: { main: { name: 'main', type: 'double_elimination', players: [], matches, currentRound: 1 } }
	});

	it('shows called match with station', () => {
		const s = myMatchStatus(t, 'd');
		expect(s.kind).toBe('bracket-ready');
		if (s.kind === 'bracket-ready') {
			expect(s.opponentId).toBe('c');
			expect(s.station).toBe(5);
			expect(s.calledAt).toBe(123);
		}
	});
	it('names the feeder match when opponent is TBD', () => {
		const s = myMatchStatus(t, 'a');
		expect(s.kind).toBe('bracket-waiting');
		if (s.kind === 'bracket-waiting') expect(s.feederIds).toEqual(['c', 'd']);
	});
	it('is done when no unfinished match remains', () => {
		expect(myMatchStatus(t, 'b').kind).toBe('done');
	});
});
