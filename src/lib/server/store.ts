import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import type { TournamentState } from '$lib/types/tournament';

function getRedis(): Redis {
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
	return new Redis({ url, token });
}

const KEY_PREFIX = 'tournament:';
const ACTIVE_KEY = 'tournament:active';

export async function saveTournament(state: TournamentState): Promise<void> {
	const redis = getRedis();
	state.updatedAt = Date.now();
	await redis.set(`${KEY_PREFIX}${state.slug}`, JSON.stringify(state));
	await redis.set(ACTIVE_KEY, state.slug);
}

export async function getTournament(slug: string): Promise<TournamentState | null> {
	const redis = getRedis();
	const data = await redis.get<string>(`${KEY_PREFIX}${slug}`);
	if (!data) return null;
	return typeof data === 'string' ? JSON.parse(data) : data as unknown as TournamentState;
}

export async function getActiveTournament(): Promise<TournamentState | null> {
	const redis = getRedis();
	const slug = await redis.get<string>(ACTIVE_KEY);
	if (!slug) return null;
	return getTournament(slug);
}

export async function deleteTournament(slug: string): Promise<void> {
	const redis = getRedis();
	await redis.del(`${KEY_PREFIX}${slug}`);
	const active = await redis.get<string>(ACTIVE_KEY);
	if (active === slug) await redis.del(ACTIVE_KEY);
}
