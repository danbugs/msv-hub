import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import type { TournamentState } from '$lib/types/tournament';

// ---------------------------------------------------------------------------
// Discord config
// ---------------------------------------------------------------------------

export interface DiscordConfig {
	/** start.gg event slug, e.g. "tournament/micro-132/event/ultimate-singles" */
	eventSlug: string;
	/** Max entrants before waitlist opens (32 or 64) */
	attendeeCap: 32 | 64;
	/** Scheduled announcement: day of week (mon-sun) */
	registrationDay: string;
	/** Scheduled announcement: hour in PST (0-23) */
	registrationHour: number;
	/** Scheduled announcement: minute (0-59) */
	registrationMinute: number;
	updatedAt: number;
}

const DISCORD_CONFIG_KEY = 'discord:config';

const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
	eventSlug: '',
	attendeeCap: 32,
	registrationDay: 'wed',
	registrationHour: 8,
	registrationMinute: 30,
	updatedAt: 0
};

export async function getDiscordConfig(): Promise<DiscordConfig> {
	const redis = getRedis();
	const data = await redis.get<string>(DISCORD_CONFIG_KEY);
	if (!data) return { ...DEFAULT_DISCORD_CONFIG };
	const parsed = typeof data === 'string' ? JSON.parse(data) : data;
	return { ...DEFAULT_DISCORD_CONFIG, ...parsed };
}

export async function saveDiscordConfig(config: Partial<DiscordConfig>): Promise<DiscordConfig> {
	const redis = getRedis();
	const current = await getDiscordConfig();
	const next: DiscordConfig = { ...current, ...config, updatedAt: Date.now() };
	await redis.set(DISCORD_CONFIG_KEY, JSON.stringify(next));
	return next;
}

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
