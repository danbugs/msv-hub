import { describe, it, expect } from 'vitest';
import { computeAllTimeTotals } from '$lib/league-totals';
import type { LeagueEvent } from '$lib/types/league';

function evt(slug: string, eventNumber: number, playerIds: string[]): LeagueEvent {
	return {
		slug,
		name: slug,
		date: '2026-01-01',
		eventNumber,
		entrantCount: playerIds.length,
		placements: playerIds.map((playerId, i) => ({ playerId, gamerTag: playerId, placement: i + 1 }))
	};
}

describe('computeAllTimeTotals', () => {
	it('dedupes events by slug, not eventNumber', () => {
		const totals = computeAllTimeTotals([
			evt('microspacing-vancouver-5', 5, ['a', 'b']),
			// Macro shares eventNumber 5 with a micro but is a separate event
			evt('macrospacing-5', 5, ['a', 'c']),
			// Same slug listed twice must only count once
			evt('microspacing-vancouver-5', 5, ['a', 'b'])
		]);
		expect(totals).toEqual({ events: 2, attendances: 4, players: 3 });
	});

	it('counts a player once per event even with duplicate placements', () => {
		expect(computeAllTimeTotals([evt('e', 1, ['a', 'a', 'b'])])).toEqual({ events: 1, attendances: 2, players: 2 });
	});

	it('handles no events', () => {
		expect(computeAllTimeTotals([])).toEqual({ events: 0, attendances: 0, players: 0 });
	});
});
