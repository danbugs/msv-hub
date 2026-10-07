// Client side of the anonymous usage counts (see $lib/server/analytics).
type Page = 'league' | 'league-player' | 'ranker';
type Event = 'view' | 'export';

const VID_KEY = 'msv-vid';

// A random per-browser id, only used to count unique visitors; never tied to anything else
function visitorId(): string {
	const fresh = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
	try {
		let id = localStorage.getItem(VID_KEY);
		if (!id) localStorage.setItem(VID_KEY, (id = fresh()));
		return id;
	} catch {
		return fresh();
	}
}

export function track(page: Page, event: Event = 'view'): void {
	try {
		const body = JSON.stringify({ page, event, vid: visitorId() });
		// sendBeacon survives the tab closing right after an export
		if (!navigator.sendBeacon?.('/api/analytics/hit', new Blob([body], { type: 'application/json' }))) {
			fetch('/api/analytics/hit', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
		}
	} catch {
		// Analytics must never break the page
	}
}
