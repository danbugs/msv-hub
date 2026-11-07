import type { LeagueEvent } from '$lib/types/league';

export interface AllTimeTotals {
	events: number;
	attendances: number;
	players: number;
}

/**
 * Season 0 is the all-time season. Micro and macro eventNumbers overlap, so the slug is the
 * only reliable identity for an event; an attendance is one distinct player at one event.
 */
export function computeAllTimeTotals(events: LeagueEvent[]): AllTimeTotals {
	const seen = new Set<string>();
	const players = new Set<string>();
	let attendances = 0;
	for (const evt of events) {
		if (seen.has(evt.slug)) continue;
		seen.add(evt.slug);
		const attendees = new Set(evt.placements.map((p) => p.playerId));
		attendances += attendees.size;
		for (const id of attendees) players.add(id);
	}
	return { events: seen.size, attendances, players: players.size };
}
