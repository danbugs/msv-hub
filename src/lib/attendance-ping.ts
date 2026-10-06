import type { AttendeeStatus } from '$lib/types/tournament';

export const PING_CHANNELS = [
	{ value: 'general', label: '#general', id: '1066863005591162961' },
	{ value: 'announcements', label: '#announcements', id: '1066863301885173800' },
	{ value: 'talk-to-balrog', label: '#talk-to-balrog', id: '1317322917129879562' }
] as const;

export type PingChannel = (typeof PING_CHANNELS)[number]['value'];

const SNOWFLAKE = /^\d{15,21}$/;

/**
 * Builds the "are you still coming?" ping for everyone not marked present.
 * Late players are skipped — they've already told a TO. Players without a
 * Discord ID on start.gg can't be mentioned, so they're listed by tag instead.
 */
export function buildNoShowPing(attendance: AttendeeStatus[]): {
	content: string;
	mentionIds: string[];
	unlinked: string[];
} | null {
	const missing = attendance.filter((a) => !a.present && !a.late);
	if (!missing.length) return null;
	const mentionIds = missing.map((a) => a.discordId?.trim() ?? '').filter((id) => SNOWFLAKE.test(id));
	const unlinked = missing.filter((a) => !SNOWFLAKE.test(a.discordId?.trim() ?? '')).map((a) => a.gamerTag);

	const lines: string[] = [];
	if (mentionIds.length) lines.push(`${mentionIds.map((id) => `<@${id}>`).join(', ')} ~ are you still coming?`);
	if (unlinked.length) {
		lines.push(mentionIds.length
			? `Also ${unlinked.join(', ')} ~ are you still coming?`
			: `${unlinked.join(', ')} ~ are you still coming?`);
	}
	return { content: lines.join('\n'), mentionIds, unlinked };
}
