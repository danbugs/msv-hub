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

/** Send a plain message to a text channel. */
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
