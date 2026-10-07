import { Redis } from '@upstash/redis';
import { env } from '$env/dynamic/private';

// Anonymous usage counts for the public pages. Per-day hashes hold counters; unique visitors go into
// HyperLogLogs, so we get distinct counts without storing a list of visitor ids.

export const TRACKED_PAGES = ['league', 'league-player', 'ranker'] as const;
export const TRACKED_EVENTS = ['view', 'export'] as const;
export type TrackedPage = (typeof TRACKED_PAGES)[number];
export type TrackedEvent = (typeof TRACKED_EVENTS)[number];

const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const countsKey = (day: string) => `stats:counts:${day}`;
const visitorsKey = (day: string, page: TrackedPage) => `stats:uv:${day}:${page}`;

function getRedis(): Redis {
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
	return new Redis({ url, token });
}

// Days roll over at local midnight, not UTC, so a Tuesday-night event isn't split across two days
export function vancouverDay(date = new Date()): string {
	return date.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
}

export function isTrackedPage(v: unknown): v is TrackedPage {
	return typeof v === 'string' && (TRACKED_PAGES as readonly string[]).includes(v);
}

export function isTrackedEvent(v: unknown): v is TrackedEvent {
	return typeof v === 'string' && (TRACKED_EVENTS as readonly string[]).includes(v);
}

export async function recordHit(page: TrackedPage, event: TrackedEvent, visitorId: string): Promise<void> {
	const day = vancouverDay();
	const p = getRedis().pipeline();
	p.hincrby(countsKey(day), `${page}:${event}`, 1);
	p.expire(countsKey(day), RETENTION_SECONDS);
	if (event === 'view') {
		p.pfadd(visitorsKey(day, page), visitorId);
		p.expire(visitorsKey(day, page), RETENTION_SECONDS);
	}
	await p.exec();
}

export interface PageUsage {
	views: number;
	visitors: number;
	exports: number;
}

export interface UsageSummary {
	days: { date: string; pages: Record<TrackedPage, PageUsage> }[];
	totals: Record<'7' | '30', Record<TrackedPage, PageUsage>>;
}

const emptyUsage = (): Record<TrackedPage, PageUsage> =>
	Object.fromEntries(TRACKED_PAGES.map((p) => [p, { views: 0, visitors: 0, exports: 0 }])) as Record<TrackedPage, PageUsage>;

export async function getUsageSummary(numDays = 30): Promise<UsageSummary> {
	const now = Date.now();
	// Oldest first; step back in 24h increments from now and label each in Vancouver time
	const dates = Array.from({ length: numDays }, (_, i) => vancouverDay(new Date(now - (numDays - 1 - i) * 86_400_000)));

	const p = getRedis().pipeline();
	for (const d of dates) p.hgetall(countsKey(d));
	for (const d of dates) for (const page of TRACKED_PAGES) p.pfcount(visitorsKey(d, page));
	// Unique visitors across a range must come from a union, not a sum of daily uniques
	for (const range of [7, 30]) {
		for (const page of TRACKED_PAGES) {
			const keys = dates.slice(-range).map((d) => visitorsKey(d, page));
			p.pfcount(keys[0], ...keys.slice(1));
		}
	}
	const res = (await p.exec()) as unknown[];

	let i = 0;
	const days = dates.map((date) => {
		const counts = (res[i++] ?? {}) as Record<string, number | string>;
		const pages = emptyUsage();
		for (const page of TRACKED_PAGES) {
			pages[page].views = Number(counts[`${page}:view`] ?? 0);
			pages[page].exports = Number(counts[`${page}:export`] ?? 0);
		}
		return { date, pages };
	});
	for (const day of days) for (const page of TRACKED_PAGES) day.pages[page].visitors = Number(res[i++] ?? 0);

	const totals = { '7': emptyUsage(), '30': emptyUsage() };
	for (const range of [7, 30] as const) {
		const t = totals[String(range) as '7' | '30'];
		for (const page of TRACKED_PAGES) {
			t[page].visitors = Number(res[i++] ?? 0);
			for (const day of days.slice(-range)) {
				t[page].views += day.pages[page].views;
				t[page].exports += day.pages[page].exports;
			}
		}
	}
	return { days, totals };
}
