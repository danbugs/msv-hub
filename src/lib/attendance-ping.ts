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
	/** Same message with mentions shown as @tag, for the TO's confirm dialog. */
	display: string;
	mentionIds: string[];
	unlinked: string[];
} | null {
	const missing = attendance.filter((a) => !a.present && !a.late);
	if (!missing.length) return null;
	const linked = missing.filter((a) => SNOWFLAKE.test(a.discordId?.trim() ?? ''));
	const mentionIds = linked.map((a) => a.discordId!.trim());
	const unlinked = missing.filter((a) => !SNOWFLAKE.test(a.discordId?.trim() ?? '')).map((a) => a.gamerTag);

	const render = (mentions: string[]) => {
		const lines: string[] = [];
		if (mentions.length) lines.push(`${mentions.join(', ')} ~ are you still coming?`);
		if (unlinked.length) {
			lines.push(mentions.length
				? `Also ${unlinked.join(', ')} ~ are you still coming?`
				: `${unlinked.join(', ')} ~ are you still coming?`);
		}
		return lines.join('\n');
	};
	return {
		content: render(mentionIds.map((id) => `<@${id}>`)),
		display: render(linked.map((a) => `@${a.gamerTag}`)),
		mentionIds,
		unlinked
	};
}
