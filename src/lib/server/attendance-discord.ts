import type { AttendeeStatus, TournamentState } from '$lib/types/tournament';
import { fetchEventDiscordIds, normalizeTag } from './startgg';

const SNOWFLAKE = /^\d{15,21}$/;

/**
 * Fills in Discord IDs the attendee CSV export left blank, from StartGG's
 * GraphQL user authorizations. Best-effort: on any API failure the stored IDs
 * are returned unchanged.
 */
export async function withDiscordIds(state: TournamentState, attendance: AttendeeStatus[]): Promise<AttendeeStatus[]> {
	if (!state.startggEventId || attendance.every((a) => SNOWFLAKE.test(a.discordId ?? ''))) return attendance;
	try {
		const ids = await fetchEventDiscordIds(state.startggEventId);
		return attendance.map((a) => {
			if (SNOWFLAKE.test(a.discordId ?? '')) return a;
			const id = ids.get(normalizeTag(a.gamerTag));
			return id ? { ...a, discordId: id } : a;
		});
	} catch (e) {
		console.error('[attendance] Discord ID lookup failed:', e);
		return attendance;
	}
}
