import { describe, it, expect } from 'vitest';
import { isNewer } from './tournament-poll';
import type { TournamentState } from '$lib/types/tournament';

const t = (slug: string, updatedAt: number) => ({ slug, updatedAt }) as TournamentState;

describe('isNewer', () => {
	it('applies strictly newer state', () => expect(isNewer(t('a', 2), t('a', 1))).toBe(true));
	it('ignores equal or stale state', () => {
		expect(isNewer(t('a', 1), t('a', 1))).toBe(false);
		expect(isNewer(t('a', 1), t('a', 2))).toBe(false);
	});
	it('applies a different tournament', () => expect(isNewer(t('b', 1), t('a', 2))).toBe(true));
	it('applies deletion and creation', () => {
		expect(isNewer(null, t('a', 1))).toBe(true);
		expect(isNewer(t('a', 1), null)).toBe(true);
		expect(isNewer(null, null)).toBe(false);
	});
});
