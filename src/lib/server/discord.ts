/**
 * Discord REST API helpers.
 *
 * We use the REST API directly rather than a library — no gateway connection
 * needed since all operations are one-shot HTTP calls from server actions.
 */

import { env } from '$env/dynamic/private';

const BASE = 'https://discord.com/api/v10';

function headers(): HeadersInit {
	const token = env.DISCORD_BOT_TOKEN;
	if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
	return {
		Authorization: `Bot ${token}`,
		'Content-Type': 'application/json'
	};
}

async function discordFetch(path: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			...headers(),
			...(init?.headers ?? {})
		}
	});
	return res;
}

// ---------------------------------------------------------------------------
// Thread / channel helpers
// ---------------------------------------------------------------------------

export interface DiscordThread {
	id: string;
	name: string;
	parent_id: string;
	locked: boolean;
	archived: boolean;
}

/** List all active threads in a guild. */
export async function listActiveThreads(guildId: string): Promise<DiscordThread[]> {
	const res = await discordFetch(`/guilds/${guildId}/threads/active`);
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to list active threads: ${res.status} ${body}`);
	}
	const data = (await res.json()) as { threads: DiscordThread[] };
	return data.threads ?? [];
}

/** Lock a single thread. */
export async function lockThread(threadId: string): Promise<void> {
	const res = await discordFetch(`/channels/${threadId}`, {
		method: 'PATCH',
		body: JSON.stringify({ locked: true, archived: true })
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to lock thread ${threadId}: ${res.status} ${body}`);
	}
}

/**
 * Lock all unlocked threads whose parent_id matches channelId.
 * Returns the count of threads locked.
 */
export async function lockThreadsInChannel(
	guildId: string,
	channelId: string
): Promise<{ locked: number; names: string[] }> {
	const threads = await listActiveThreads(guildId);
	const targets = threads.filter((t) => t.parent_id === channelId && !t.locked);

	const names: string[] = [];
	for (const t of targets) {
		await lockThread(t.id);
		names.push(t.name);
	}
	return { locked: targets.length, names };
}

/** Create a new post (thread) in a forum channel. */
export async function createForumPost(
	channelId: string,
	name: string,
	content: string
): Promise<{ id: string; name: string }> {
	const res = await discordFetch(`/channels/${channelId}/threads`, {
		method: 'POST',
		body: JSON.stringify({
			name,
			message: { content }
		})
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to create forum post in ${channelId}: ${res.status} ${body}`);
	}
	const data = (await res.json()) as { id: string; name: string };
	return data;
}

/** Send a plain message to a text channel (also works on forum threads). */
export async function sendMessage(channelId: string, content: string): Promise<void> {
	const res = await discordFetch(`/channels/${channelId}/messages`, {
		method: 'POST',
		body: JSON.stringify({ content })
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to send message to ${channelId}: ${res.status} ${body}`);
	}
}

/**
 * Find the most recent (latest) active thread in a forum channel.
 * Returns the thread ID, or null if no active threads exist.
 */
export async function getLatestForumThread(
	guildId: string,
	forumChannelId: string
): Promise<DiscordThread | null> {
	const threads = await listActiveThreads(guildId);
	const forumThreads = threads.filter((t) => t.parent_id === forumChannelId && !t.archived);
	if (forumThreads.length === 0) return null;
	// Discord returns threads in no guaranteed order; sort by snowflake ID descending (higher = newer)
	forumThreads.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
	return forumThreads[0];
}

// ---------------------------------------------------------------------------
// Announcement message builder
// ---------------------------------------------------------------------------

export function buildAnnouncementMessage(slug: string, cap: 32 | 64, template?: string): string {
	if (template && template.trim()) {
		return template
			.replace(/\{\{slug\}\}/g, slug)
			.replace(/\{\{cap\}\}/g, String(cap));
	}

	let message =
		`@everyone ~ registration for next week's event is open!\n\n` +
		`- ${cap} player cap.\n` +
		`- for venue access, see: #how-to-get-to-the-venue .\n` +
		`- **:warning: BRING YOUR NINTENDO SWITCHES (DOCK, CONSOLE, POWER CABLE, AND HDMI) WITH GAME CUBE ADAPTERS :warning:**`;

	if (cap === 32) {
		message +=
			` (running Swiss is dependent on having at least 20 setups; otherwise, we'll do normal Redemption). We've got monitors.\n`;
	} else {
		message += `\n`;
	}

	message +=
		`- if you are trying to register, but we've already reached the cap, please drop your StartGG tag ` +
		`(and say if you can bring a setup) at #add-me-to-the-waitlist once it opens. ` +
		`Are you from out-of-region? If so, you have priority in the waitlist!\n\n` +
		`PS If you can't bring a full setup, but would still like to contribute, _please bring your GCC adapter_. ` +
		`There are some people that can bring full setups but only play w/ pro cons., so it's always best to have extras.\n\n` +
		`https://start.gg/${slug}`;

	return message;
}

// ---------------------------------------------------------------------------
// Slug helpers (mirror bot logic)
// ---------------------------------------------------------------------------

/** "tournament/foo/event/bar" → "foo/bar" */
export function shortenSlug(slug: string): string {
	const parts = slug.split('/');
	if (parts.length >= 4) return `${parts[1]}/${parts[3]}`;
	return slug;
}

export function truncateTo100(s: string): string {
	return s.length < 100 ? s : s.slice(0, 96) + '...';
}

// ---------------------------------------------------------------------------
// Message fetching
// ---------------------------------------------------------------------------

export interface DiscordMessage {
	id: string;
	content: string;
	author: {
		id: string;
		username: string;
		bot?: boolean;
	};
}

/** Fetch recent messages from a text channel. */
export async function getMessages(channelId: string, limit = 100): Promise<DiscordMessage[]> {
	const res = await discordFetch(`/channels/${channelId}/messages?limit=${limit}`);
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to fetch messages from ${channelId}: ${res.status} ${body}`);
	}
	return res.json() as Promise<DiscordMessage[]>;
}
