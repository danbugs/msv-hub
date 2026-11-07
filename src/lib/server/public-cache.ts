// Public pages read multi-MB league blobs from Redis, and Upstash bills by bandwidth.
// Letting Vercel's CDN serve them means crawlers and repeat visitors never reach Redis.
// League data only changes when an organizer imports an event, so an hour is plenty fresh.
const PUBLIC_CACHE = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

export function cachePublicPage(
	setHeaders: (headers: Record<string, string>) => void,
	locals: App.Locals
): void {
	// The layout renders the organizer's email, so a signed-in response must never be shared
	if (locals.user) return;
	setHeaders({ 'cache-control': PUBLIC_CACHE });
}
