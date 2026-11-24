import { describe, it, expect } from 'vitest';
import { seedNumbersForStandardLayout } from './startgg-split';

describe('seed numbers that give StartGG a plain seeded layout', () => {
	const b = null;
	// StartGG's own seed positions for 26 players with 13 in winners.
	const startgg26 = [1, b, 16, 23, 8, 18, 9, 25, 4, b, 13, 20, 5, b, 12, 21, 2, b, 17, 15, 7, 26, 10, 22, 3, b, 14, 19, 6, b, 11, 24];

	it('leaves the top half alone and moves bottom-half seeds onto their plain positions', () => {
		const nums = seedNumbersForStandardLayout(startgg26, 26)!;
		expect(nums.slice(0, 13)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
		// A plain bracket seats 17 beside 16; StartGG has seed number 23 there.
		expect(nums[16]).toBe(23);
		expect([...nums].sort((x, y) => x - y)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
	});

	it('is the identity when StartGG already has a plain layout', () => {
		const plain24 = [1, b, 16, 17, 8, b, 9, 24, 4, b, 13, 20, 5, b, 12, 21, 2, b, 15, 18, 7, b, 10, 23, 3, b, 14, 19, 6, b, 11, 22];
		expect(seedNumbersForStandardLayout(plain24, 24)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
	});

	it('refuses a layout whose byes are in the wrong place', () => {
		const wrong = [1, 2, b, b];
		expect(seedNumbersForStandardLayout(wrong, 2)).toBeNull();
	});
});
