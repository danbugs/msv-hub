import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import type { LeagueEvent } from '$lib/types/league';
import { getSeasonEvents } from '$lib/server/league-store';
import { getEventConfig } from '$lib/server/store';
import { gql, TOURNAMENT_QUERY } from '$lib/server/startgg';

// Data for the public landing page at `/`.

export interface AllTimeTotals {
	events: number;
	attendances: number;
	players: number;
}

export interface NextEvent {
	name: string;
	/** Unix seconds */
	startAt: number;
	url: string;
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

export async function getAllTimeTotals(): Promise<AllTimeTotals | null> {
	const events = await getSeasonEvents(0);
	return events.length ? computeAllTimeTotals(events) : null;
}

const NEXT_EVENT_CACHE_PREFIX = 'landing:next-event:';
// Public traffic shouldn't turn into StartGG traffic; the tournament rarely changes once created.
const NEXT_EVENT_CACHE_TTL = 15 * 60;
// Keep showing the event through the evening it runs
const STALE_AFTER_SECONDS = 12 * 60 * 60;

function getRedis(): Redis {
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
	return new Redis({ url, token });
}

async function fetchTournament(slug: string): Promise<NextEvent | null> {
	const data = await gql<{ tournament: { name: string; startAt: number | null } | null }>(
		TOURNAMENT_QUERY,
		{ slug },
		// gql retries forever on 429; a landing page render must not wait on that
		{ signal: AbortSignal.timeout(3000), delay: 0 }
	);
	const t = data?.tournament;
	if (!t?.startAt) return null;
	return { name: t.name, startAt: t.startAt, url: `https://www.start.gg/tournament/${slug}` };
}

/**
 * The most recent tournament the Tuesday cron created, if it hasn't happened yet. Returns null
 * whenever anything is missing or failing, so the page falls back to the hub link.
 */
export async function getNextEvent(now = Date.now()): Promise<NextEvent | null> {
	const config = await getEventConfig();
	const slug = config.lastCreatedTournamentSlug;
	if (!slug) return null;

	const redis = getRedis();
	const key = `${NEXT_EVENT_CACHE_PREFIX}${slug}`;
	const cached = await redis.get<NextEvent | { none: true }>(key);
	let event: NextEvent | null;
	if (cached) {
		event = 'none' in cached ? null : cached;
	} else {
		event = await fetchTournament(slug).catch(() => null);
		// Cache misses too, so a deleted or private tournament doesn't hit StartGG on every view
		await redis.set(key, event ?? { none: true }, { ex: NEXT_EVENT_CACHE_TTL }).catch(() => {});
	}

	if (!event || event.startAt + STALE_AFTER_SECONDS < now / 1000) return null;
	return event;
}
