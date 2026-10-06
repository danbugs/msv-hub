import type { TournamentState } from '$lib/types/tournament';

/**
 * Keeps a TO page in sync with reports made from other TOs' devices.
 *
 * Skips while the page is busy (modal open, request in flight) so it never
 * yanks state out from under someone mid-report, and only applies strictly
 * newer state so a slow poll can't clobber what the page itself just loaded.
 */
export function pollTournament(opts: {
	current: () => TournamentState | null;
	apply: (next: TournamentState | null) => void;
	isBusy: () => boolean;
	intervalMs?: number;
}): () => void {
	let inFlight = false;

	async function tick() {
		if (inFlight || document.hidden || opts.isBusy()) return;
		inFlight = true;
		try {
			const res = await fetch('/api/tournament');
			if (!res.ok) return;
			const next = (await res.json()) as TournamentState | null;
			if (opts.isBusy()) return;
			if (isNewer(next, opts.current())) opts.apply(next);
		} catch {
			// Venue wifi drops — next tick will retry.
		} finally {
			inFlight = false;
		}
	}

	const id = setInterval(tick, opts.intervalMs ?? 10_000);
	const onVisible = () => { if (!document.hidden) tick(); };
	document.addEventListener('visibilitychange', onVisible);
	return () => {
		clearInterval(id);
		document.removeEventListener('visibilitychange', onVisible);
	};
}

export function isNewer(next: TournamentState | null, cur: TournamentState | null): boolean {
	if (!next || !cur) return next !== cur;
	if (next.slug !== cur.slug) return true;
	return next.updatedAt > cur.updatedAt;
}
