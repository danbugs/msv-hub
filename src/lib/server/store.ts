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
	/** Set to true once the fastest registrant has been posted for the current event. */
	fastestRegPosted: boolean;
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
	fastestRegPosted: false,
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
// Fastest registrant leaderboard
// ---------------------------------------------------------------------------

export interface FastestRegEntry {
	/** e.g. "MSV#135" */
	eventLabel: string;
	/** Winner's gamer tag */
	winnerTag: string;
	/** Winner's Discord ID (for <@id> mentions) */
	winnerDiscordId: string;
	/** Top 3 runners-up: { tag, discordId } */
	runnersUp: { tag: string; discordId: string }[];
}

export interface FastestRegLeaderboard {
	/** Per-event winners in chronological order */
	entries: FastestRegEntry[];
	/** Discord thread ID for the leaderboard post */
	threadId: string;
	/** Discord message ID of the leaderboard body (first message, for editing) */
	leaderboardMessageId: string;
	updatedAt: number;
}

/**
 * Parse existing leaderboard text (from a human-maintained Discord message)
 * into FastestRegEntry[]. Looks for lines like "MSV#125) @Dom" or "MSV#125) <@123>"
 */
export function parseLeaderboardEntries(text: string): FastestRegEntry[] {
	const entries: FastestRegEntry[] = [];
	// Match lines like: MSV#125) @Dom  or  MSV#125) <@123456789>  or  MSV#125) Dom
	const lineRegex = /(?:MSV|MaSV)#(\d+)\)\s*(.+)/gi;
	let match;
	while ((match = lineRegex.exec(text)) !== null) {
		const eventLabel = `MSV#${match[1]}`;
		let winnerRaw = match[2].trim();
		let winnerTag = winnerRaw;
		let winnerDiscordId = '';

		// Extract Discord mention: <@123456789>
		const mentionMatch = winnerRaw.match(/^<@(\d{17,20})>/);
		if (mentionMatch) {
			winnerDiscordId = mentionMatch[1];
			winnerTag = winnerRaw.replace(/<@\d+>/, '').trim() || `User${mentionMatch[1].slice(-4)}`;
		}
		// Strip leading @ from plain text
		if (winnerTag.startsWith('@')) winnerTag = winnerTag.slice(1);

		entries.push({ eventLabel, winnerTag, winnerDiscordId, runnersUp: [] });
	}
	return entries;
}

const FASTEST_REG_KEY = 'discord:fastest_reg_leaderboard';

export async function getFastestRegLeaderboard(): Promise<FastestRegLeaderboard | null> {
	const redis = getRedis();
	const data = await redis.get<string>(FASTEST_REG_KEY);
	if (!data) return null;
	return typeof data === 'string' ? JSON.parse(data) : data as unknown as FastestRegLeaderboard;
}

export async function saveFastestRegLeaderboard(lb: FastestRegLeaderboard): Promise<void> {
	const redis = getRedis();
	lb.updatedAt = Date.now();
	await redis.set(FASTEST_REG_KEY, JSON.stringify(lb));
}

/**
 * Build the leaderboard text from entries.
 * Format matches the Discord forum post style.
 */
export function buildLeaderboardText(entries: FastestRegEntry[]): string {
	if (entries.length === 0) return 'No fastest registrant data yet.';

	// Count wins per player (by discordId, fallback to tag)
	const wins = new Map<string, { tag: string; discordId: string; count: number }>();
	for (const e of entries) {
		const key = e.winnerDiscordId || e.winnerTag.toLowerCase();
		const existing = wins.get(key);
		if (existing) {
			existing.count++;
		} else {
			wins.set(key, { tag: e.winnerTag, discordId: e.winnerDiscordId, count: 1 });
		}
	}

	// Sort by win count descending
	const sorted = [...wins.values()].sort((a, b) => b.count - a.count);

	// Group by rank
	const lines: string[] = [];
	const medals = ['🥇', '🥈', '🥉'];
	let prevCount = -1;
	let rank = 0;
	for (const player of sorted) {
		if (player.count !== prevCount) {
			rank++;
			prevCount = player.count;
		}
		if (rank > 3) break;
		const medal = medals[rank - 1] ?? '';
		const mention = player.discordId && /^\d{17,20}$/.test(player.discordId) ? `<@${player.discordId}>` : player.tag;
		const winLabel = player.count === 1 ? '1 win' : `${player.count} wins`;

		// Find others at same rank
		const sameRank = sorted.filter((p) => p.count === player.count);
		if (sameRank.length > 1 && sameRank[0] === player) {
			// Print all at this rank on one line
			const mentions = sameRank.map((p) => p.discordId ? `<@${p.discordId}>` : p.tag).join(' / ');
			lines.push(`${medal} ${mentions} (${winLabel})`);
			// Skip the rest at this rank
			continue;
		} else if (sameRank.length > 1) {
			continue; // Already printed
		}
		lines.push(`${medal} ${mention} (${winLabel})`);
	}

	lines.push('');

	// Per-event history
	for (const e of entries) {
		const mention = e.winnerDiscordId && /^\d{17,20}$/.test(e.winnerDiscordId) ? `<@${e.winnerDiscordId}>` : e.winnerTag;
		lines.push(`${e.eventLabel}) ${mention}`);
	}

	return lines.join('\n');
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

// ---------------------------------------------------------------------------
// Distributed lock (SET NX with TTL) — serializes concurrent reports during
// the preview→real conversion window.
// ---------------------------------------------------------------------------

/** Acquire a lock atomically. Returns true if acquired. TTL in seconds. */
export async function acquireLock(key: string, ttlSec = 15): Promise<boolean> {
	const redis = getRedis();
	// Upstash SET with NX + EX options
	const res = await redis.set(key, '1', { nx: true, ex: ttlSec });
	return res === 'OK';
}

/** Wait for a lock to be released (polling). Returns true if released in time. */
export async function waitForLock(key: string, timeoutMs = 8000, pollMs = 200): Promise<boolean> {
	const redis = getRedis();
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const exists = await redis.exists(key);
		if (!exists) return true;
		await new Promise<void>((r) => setTimeout(r, pollMs));
	}
	return false;
}

export async function releaseLock(key: string): Promise<void> {
	const redis = getRedis();
	await redis.del(key);
}
