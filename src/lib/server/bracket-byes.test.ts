import { describe, it, expect } from 'vitest';
import { generateBracket, reportBracketMatch } from './swiss';

describe('brackets with byes play through', () => {
	// Sizes just above a power of two leave losers matches that never get a player.
	// Anyone waiting on one of those used to be stranded.
	for (const n of [5, 9, 10, 11, 17, 20, 21, 33]) {
		it(`${n} players, everyone in winners`, () => {
			const players = Array.from({ length: n }, (_, i) => ({ entrantId: `p${i + 1}`, seed: i + 1 }));
			let b = generateBracket('main', players, []);
			for (let guard = 0; guard < 500; guard++) {
				const m = b.matches.find((x) => x.topPlayerId && x.bottomPlayerId && !x.winnerId);
				if (!m) break;
				// Lower seed number always wins, so the top seed goes through undefeated.
				const top = Number(m.topPlayerId!.slice(1)), bottom = Number(m.bottomPlayerId!.slice(1));
				b = reportBracketMatch(b, m.id, top < bottom ? m.topPlayerId! : m.bottomPlayerId!);
			}
			const played = b.matches.filter((m) => m.winnerId && m.topPlayerId && m.bottomPlayerId).length;
			expect(played).toBe(2 * n - 2);
			expect(b.matches.filter((m) => !m.winnerId && (m.topPlayerId || m.bottomPlayerId))).toEqual([]);
		});
	}
});
