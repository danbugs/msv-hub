import { describe, it, expect } from 'vitest';
import { unplayedSwissRoundPhases } from './startgg-admin';

describe('unplayedSwissRoundPhases', () => {
	// The phase list StartGG returned for a three-round night on the five-round template
	const phases = [
		{ id: 1, name: 'Swiss Round 1', numSeeds: 32 },
		{ id: 5, name: 'Swiss Round 5', numSeeds: 0 },
		{ id: 3, name: 'Swiss Round 3', numSeeds: 32 },
		{ id: 2, name: 'Swiss Round 2', numSeeds: 32 },
		{ id: 4, name: 'Swiss Round 4', numSeeds: 0 },
		{ id: 6, name: 'Final Standings', numSeeds: 32 }
	];

	it('picks only the empty rounds past the ones played', () => {
		expect(unplayedSwissRoundPhases(phases, 3).map((p) => p.name)).toEqual(['Swiss Round 5', 'Swiss Round 4']);
	});

	it('never picks a round that has players, even past the count', () => {
		const seeded = phases.map((p) => (p.id === 4 ? { ...p, numSeeds: 12 } : p));
		expect(unplayedSwissRoundPhases(seeded, 3).map((p) => p.id)).toEqual([5]);
	});

	it('picks nothing on a full five-round night', () => {
		expect(unplayedSwissRoundPhases(phases, 5)).toEqual([]);
	});
});
