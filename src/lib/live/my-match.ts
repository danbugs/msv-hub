import type { TournamentState, BracketMatch, BracketState } from '$lib/types/tournament';

export type MyMatchStatus =
	| { kind: 'swiss-playing'; round: number; opponentId: string; station?: number; isStream?: boolean }
	| { kind: 'swiss-reported'; round: number; won: boolean; lastRound: boolean }
	| { kind: 'swiss-bye'; round: number }
	| { kind: 'swiss-waiting' }
	| {
			kind: 'bracket-ready';
			bracket: 'main' | 'redemption';
			match: BracketMatch;
			opponentId: string;
			station?: number;
			isStream?: boolean;
			calledAt?: number;
	  }
	| { kind: 'bracket-waiting'; bracket: 'main' | 'redemption'; match: BracketMatch; feederIds: [string?, string?] }
	| { kind: 'done'; rank?: number; bracket?: 'main' | 'redemption' }
	| { kind: 'unknown' };

/** Works out what a player should be doing right now, for the live page's "Your match" card. */
export function myMatchStatus(t: TournamentState, entrantId: string): MyMatchStatus {
	if (t.phase === 'swiss') {
		const round = t.rounds[t.currentRound - 1];
		if (!round || round.status === 'pending') return { kind: 'swiss-waiting' };
		if (round.byePlayerId === entrantId) return { kind: 'swiss-bye', round: round.number };
		const m = round.matches.find((x) => x.topPlayerId === entrantId || x.bottomPlayerId === entrantId);
		if (!m) return { kind: 'swiss-waiting' };
		if (m.winnerId) {
			return {
				kind: 'swiss-reported',
				round: round.number,
				won: m.winnerId === entrantId,
				lastRound: round.number >= t.settings.numRounds
			};
		}
		return {
			kind: 'swiss-playing',
			round: round.number,
			opponentId: m.topPlayerId === entrantId ? m.bottomPlayerId : m.topPlayerId,
			station: m.station,
			isStream: m.isStream
		};
	}

	for (const name of ['main', 'redemption'] as const) {
		const bracket = t.brackets?.[name];
		if (!bracket) continue;
		const pending = bracket.matches.find(
			(m) => !m.winnerId && (m.topPlayerId === entrantId || m.bottomPlayerId === entrantId)
		);
		if (!pending) continue;
		const isTop = pending.topPlayerId === entrantId;
		const opponentId = isTop ? pending.bottomPlayerId : pending.topPlayerId;
		if (opponentId) {
			return {
				kind: 'bracket-ready',
				bracket: name,
				match: pending,
				opponentId,
				station: pending.station,
				isStream: pending.isStream,
				calledAt: pending.calledAt
			};
		}
		const feeder = feederFor(bracket, pending.id, isTop ? 'bottom' : 'top');
		return {
			kind: 'bracket-waiting',
			bracket: name,
			match: pending,
			feederIds: [feeder?.topPlayerId, feeder?.bottomPlayerId]
		};
	}

	const standing = t.finalStandings?.find((s) => s.entrantId === entrantId);
	if (t.brackets || t.phase === 'completed') {
		return { kind: 'done', rank: t.phase === 'completed' ? standing?.rank : undefined, bracket: standing?.bracket };
	}
	return { kind: 'unknown' };
}

/** The unfinished match whose winner or loser will fill `slot` of `matchId`. */
function feederFor(bracket: BracketState, matchId: string, slot: 'top' | 'bottom'): BracketMatch | undefined {
	return bracket.matches.find(
		(m) =>
			!m.winnerId &&
			((m.winnerNextMatchId === matchId && m.winnerNextSlot === slot) ||
				(m.loserNextMatchId === matchId && m.loserNextSlot === slot))
	);
}
