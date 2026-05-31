import { describe, it, expect } from 'vitest';
import { fetchRecentMatchups } from './bracket-predict';
import { gql, TOURNAMENT_QUERY, fetchAllSets } from './startgg';

describe('bracket collision detection', () => {
	it('finds recent matchups from MSV events', async () => {
		// Get player IDs from Macrospacing Vancouver 7
		const tData = await gql<{ tournament: { name: string; startAt: number; events: { id: number; name: string; numEntrants: number }[] } }>(
			TOURNAMENT_QUERY, { slug: 'macrospacing-vancouver-7' }
		);
		expect(tData?.tournament).toBeTruthy();
		console.log(`Tournament: ${tData!.tournament.name}`);
		console.log(`Events: ${tData!.tournament.events.map(e => `${e.name} (${e.numEntrants})`).join(', ')}`);

		const mainEvent = tData!.tournament.events.find(e => /main/i.test(e.name)) ?? tData!.tournament.events[0];
		const sets = await fetchAllSets(mainEvent.id);
		console.log(`Sets in ${mainEvent.name}: ${sets.length}`);

		// Collect all entrants with seed numbers
		const entrantMap = new Map<number, { seedNum: number; gamerTag: string; playerId: number }>();
		let seedCounter = 1;
		for (const s of sets) {
			for (const slot of (s.slots ?? [])) {
				const pid = slot.entrant?.participants?.[0]?.player?.id;
				const tag = slot.entrant?.participants?.[0]?.player?.gamerTag ?? 'Unknown';
				if (pid && !entrantMap.has(pid)) {
					entrantMap.set(pid, { seedNum: seedCounter++, gamerTag: tag, playerId: pid });
				}
			}
		}
		const entrants = [...entrantMap.values()];
		const playerIds = new Set(entrants.map(e => e.playerId));
		console.log(`Player IDs found: ${playerIds.size}`);

		// Find Ticolol matches in this event for reference
		for (const s of sets) {
			const slots = s.slots ?? [];
			if (slots.length !== 2) continue;
			const tags = slots.map((sl: any) => sl.entrant?.participants?.[0]?.player?.gamerTag ?? '???');
			const ids = slots.map((sl: any) => sl.entrant?.participants?.[0]?.player?.id ?? null);
			if (tags.some((t: string) => /ticolol/i.test(t))) {
				console.log(`  Macro7 Ticolol match: ${tags[0]} (${ids[0]}) vs ${tags[1]} (${ids[1]}) — ${s.fullRoundText}`);
			}
		}

		// Run the actual lookup
		console.log('\nRunning fetchRecentMatchups...');
		const matches = await fetchRecentMatchups(entrants);
		console.log(`Found ${matches.size} recent matchup pairs`);

		// Show Ticolol matches
		let ticololCount = 0;
		for (const [, m] of matches) {
			if (/ticolol/i.test(m.tag1) || /ticolol/i.test(m.tag2)) {
				console.log(`  ${m.tag1} vs ${m.tag2} @ ${m.event}`);
				ticololCount++;
			}
		}
		console.log(`Ticolol matchup pairs: ${ticololCount}`);

		expect(matches.size).toBeGreaterThan(0);
	}, 120000);
});
