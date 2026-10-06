import { describe, it, expect } from 'vitest';
import { buildNoShowPing } from './attendance-ping';

const a = (gamerTag: string, o: Record<string, unknown> = {}) => ({ gamerTag, pledgedSetup: false, ...o });

describe('buildNoShowPing', () => {
	it('mentions linked absentees and lists unlinked ones by tag', () => {
		const r = buildNoShowPing([
			a('Here', { present: true, discordId: '111111111111111111' }),
			a('Late', { late: true, discordId: '222222222222222222' }),
			a('Gone', { discordId: '333333333333333333' }),
			a('NoDiscord', { discordId: '' })
		]);
		expect(r).toEqual({
			content: '<@333333333333333333> ~ are you still coming?\nAlso NoDiscord ~ are you still coming?',
			mentionIds: ['333333333333333333'],
			unlinked: ['NoDiscord']
		});
	});
	it('treats non-snowflake IDs (e.g. usernames) as unlinked', () => {
		expect(buildNoShowPing([a('X', { discordId: 'someuser#1234' })])?.content).toBe('X ~ are you still coming?');
	});
	it('returns null when everyone is accounted for', () => {
		expect(buildNoShowPing([a('A', { present: true }), a('B', { late: true })])).toBeNull();
	});
});
