import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';
import type { TournamentState } from '$lib/types/tournament';
import { DEFAULT_MOTIVATIONAL_MESSAGES, DEFAULT_GIF_URLS } from '$lib/defaults';

export { DEFAULT_MOTIVATIONAL_MESSAGES, DEFAULT_GIF_URLS };

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
	/** Custom announcement message template. Empty string = use hardcoded default. */
	announcementTemplate: string;
	/** When true, cron and attendee-check endpoints skip all Discord actions. */
	paused: boolean;
	/** Set to true once the waitlist thread has been created for the current event. */
	waitlistCreated: boolean;
	updatedAt: number;
}

const DISCORD_CONFIG_KEY = 'discord:config';

const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
	eventSlug: '',
	attendeeCap: 32,
	registrationDay: 'wed',
	registrationHour: 8,
	registrationMinute: 30,
	announcementTemplate: '',
	paused: false,
	waitlistCreated: false,
	updatedAt: 0
};

// ---------------------------------------------------------------------------
// Community config (motivational messages list)
// ---------------------------------------------------------------------------

export interface CommunityConfig {
	motivationalMessages: string[];
	gifUrls: string[];
	updatedAt: number;
}

const COMMUNITY_CONFIG_KEY = 'discord:community';

const DEFAULT_COMMUNITY_CONFIG: CommunityConfig = {
	motivationalMessages: DEFAULT_MOTIVATIONAL_MESSAGES,
	gifUrls: DEFAULT_GIF_URLS,
	updatedAt: 0
};

export async function getCommunityConfig(): Promise<CommunityConfig> {
	const redis = getRedis();
	const data = await redis.get<string>(COMMUNITY_CONFIG_KEY);
	if (!data) return { ...DEFAULT_COMMUNITY_CONFIG };
	const parsed = typeof data === 'string' ? JSON.parse(data) : data;
	return { ...DEFAULT_COMMUNITY_CONFIG, ...parsed };
}

export async function saveCommunityConfig(config: Partial<CommunityConfig>): Promise<CommunityConfig> {
	const redis = getRedis();
	const current = await getCommunityConfig();
	const next: CommunityConfig = { ...current, ...config, updatedAt: Date.now() };
	await redis.set(COMMUNITY_CONFIG_KEY, JSON.stringify(next));
	return next;
}

// ---------------------------------------------------------------------------
// Last motivational timestamp
// ---------------------------------------------------------------------------

const LAST_MOTIVATIONAL_KEY = 'discord:last_motivational';

export async function getLastMotivationalTs(): Promise<number> {
	const redis = getRedis();
	const val = await redis.get<string>(LAST_MOTIVATIONAL_KEY);
	if (!val) return 0;
	return parseInt(typeof val === 'string' ? val : String(val), 10);
}

export async function setLastMotivationalTs(ts: number): Promise<void> {
	const redis = getRedis();
	await redis.set(LAST_MOTIVATIONAL_KEY, String(ts));
}

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
