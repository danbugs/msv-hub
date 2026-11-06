import type { PageServerLoad } from './$types';
import { getLiveTournamentSummary } from '$lib/server/store';
import { getAllTimeTotals, getNextEvent, type AllTimeTotals } from '$lib/server/landing';

// Last known totals, so the page still says something true if Redis is unreachable
const FALLBACK_TOTALS: AllTimeTotals = { events: 166, attendances: 5445, players: 378 };

export const load: PageServerLoad = async () => {
	// Every piece is optional: the landing page must render even if Redis or StartGG is down.
	const [totals, nextEvent, live] = await Promise.all([
		getAllTimeTotals().catch(() => null),
		getNextEvent().catch(() => null),
		getLiveTournamentSummary().catch(() => null)
	]);
	return { totals: totals ?? FALLBACK_TOTALS, nextEvent, live };
};
