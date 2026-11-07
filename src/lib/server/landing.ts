import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import { LANDING_TOTALS_KEY } from '$lib/server/league-store';
import type { AllTimeTotals } from '$lib/league-totals';
import { getEventConfig } from '$lib/server/store';
import { gql, TOURNAMENT_QUERY } from '$lib/server/startgg';

// Data for the public landing page at `/`.

export type { AllTimeTotals };

export interface NextEvent {
	name: string;
	/** Unix seconds */
	startAt: number;
	url: string;
}

/**
 * Totals are precomputed whenever the all-time season is saved, so a landing page view reads a
 * few bytes instead of the whole season (which once burned through the Redis bandwidth quota).
 */
export async function getAllTimeTotals(): Promise<AllTimeTotals | null> {
	return getRedis().get<AllTimeTotals>(LANDING_TOTALS_KEY);
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
