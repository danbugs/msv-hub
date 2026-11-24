/**
 * Pushing a split-start bracket (some seeds start in losers) to StartGG.
 *
 * Results are reported to StartGG by player pair, so StartGG's bracket has to pair the
 * same players the hub does. Two things make that less direct than for a normal bracket:
 *
 *  - The players starting in losers have to be put in their own entrant group on the phase.
 *  - With that group in place StartGG does not always put seed N where a plain seeded
 *    bracket would. Where each seed number sits is readable, though, and doesn't move when
 *    seeds are reassigned, so we hand each player whichever seed number sits where the hub
 *    has them. For some sizes that leaves bottom-half players showing a different seed
 *    number on StartGG than their hub seed; the pairings are what matter.
 */

import type { BracketState, Entrant } from '$lib/types/tournament';
import { getStandardBracketOrder } from '$lib/server/swiss';
import {
	gql, fetchAllEntrants, fetchPhaseGroups, EVENT_PHASES_QUERY, UPDATE_PHASE_SEEDING_MUTATION
} from '$lib/server/startgg';
import { setLosersStart, fetchPhaseGroupLayout, type PhaseGroupLayout } from '$lib/server/startgg-admin';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * For each hub seed (1-based index into the result), the StartGG seed number to give that
 * player so they land where a plain seeded bracket puts them.
 *
 * `positions` is StartGG's seed number at each first-round slot, null for a bye.
 * Returns null if StartGG's layout can't hold a plain seeding of `playerCount` players.
 */
export function seedNumbersForStandardLayout(
	positions: (number | null)[],
	playerCount: number
): number[] | null {
	const size = positions.length;
	if (size < playerCount || (size & (size - 1)) !== 0) return null;
	const order = getStandardBracketOrder(size);
	const seedNumForRank: number[] = [];
	for (let i = 0; i < size; i++) {
		const rank = order[i] + 1;
		const seedNum = positions[i];
		if (rank > playerCount) {
			if (seedNum !== null) return null; // StartGG has a player where we expect a bye
			continue;
		}
		if (seedNum === null) return null;
		seedNumForRank[rank - 1] = seedNum;
	}
	return seedNumForRank;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Players the hub has ready to play, as pairs of bracket entrant IDs. */
function hubOpenPairs(bracket: BracketState, bracketEntrantId: Map<string, number>): Set<string> {
	const pairs = new Set<string>();
	for (const m of bracket.matches) {
		if (m.winnerId || !m.topPlayerId || !m.bottomPlayerId) continue;
		const a = bracketEntrantId.get(m.topPlayerId), b = bracketEntrantId.get(m.bottomPlayerId);
		if (a && b) pairs.add(pairKey(a, b));
	}
	return pairs;
}

export interface SplitSyncResult {
	ok: boolean;
	/** True when StartGG's ready-to-play sets were compared with the hub's and matched. */
	verified?: boolean;
	error?: string;
}

/**
 * Lay a split-start bracket out on StartGG to match the hub: sides, then seeding, then a
 * check that both agree on who plays whom first. Safe to re-run; it changes nothing that
 * is already in place.
 */
export async function syncSplitBracket(
	eventId: number,
	bracket: BracketState,
	entrants: Entrant[],
	log: (msg: string) => void
): Promise<SplitSyncResult> {
	const winnersCount = bracket.winnersCount;
	if (!winnersCount) return { ok: false, error: 'Bracket is not a split start' };
	const label = bracket.name;

	const phaseData = await gql<{ event: { phases: { id: number }[] } }>(EVENT_PHASES_QUERY, { eventId });
	const phaseId = phaseData?.event?.phases?.[0]?.id;
	if (!phaseId) return { ok: false, error: `No phase found for the ${label} bracket event` };
	const phaseGroupId = (await fetchPhaseGroups(phaseId).catch(() => []))[0]?.id;
	if (!phaseGroupId) return { ok: false, error: `No phase group found for the ${label} bracket` };

	// The bracket event has its own entrant IDs; match them to hub players by tag.
	const hubTag = new Map(entrants.map((e) => [e.id, e.gamerTag.toLowerCase()]));
	const ranked = [...bracket.players].sort((a, b) => a.seed - b.seed);
	const bracketEntrantId = new Map<string, number>();
	for (let attempt = 0; attempt < 5 && bracketEntrantId.size < ranked.length; attempt++) {
		if (attempt > 0) await sleep(2000); // registrations take a moment to show up
		const eventEntrants = await fetchAllEntrants(eventId, undefined).catch(() => []);
		const byTag = new Map<string, number>();
		for (const e of eventEntrants) {
			const tag = e.participants?.[0]?.player?.gamerTag;
			if (tag && e.id) byTag.set(String(tag).toLowerCase(), Number(e.id));
		}
		for (const p of ranked) {
			const id = byTag.get(hubTag.get(p.entrantId) ?? '');
			if (id) bracketEntrantId.set(p.entrantId, id);
		}
	}
	const missing = ranked.filter((p) => !bracketEntrantId.has(p.entrantId));
	if (missing.length) {
		const names = missing.map((p) => hubTag.get(p.entrantId) ?? p.entrantId).join(', ');
		return { ok: false, error: `Not in the ${label} bracket event on StartGG: ${names}` };
	}
	const rankedIds = ranked.map((p) => bracketEntrantId.get(p.entrantId)!);

	const sides = await setLosersStart(
		eventId, phaseId, phaseGroupId, rankedIds.slice(0, winnersCount), rankedIds.slice(winnersCount)
	);
	if (!sides.ok) return { ok: false, error: sides.error };
	log(sides.changed
		? `${label}: ${winnersCount} start in winners, ${rankedIds.length - winnersCount} in losers`
		: `${label}: sides already set on StartGG`);

	// Wait for StartGG to finish seating everyone before reading where the seeds sit.
	let layout: PhaseGroupLayout | null = null;
	for (let attempt = 0; attempt < 6; attempt++) {
		if (attempt > 0 || sides.changed) await sleep(1500);
		layout = await fetchPhaseGroupLayout(phaseGroupId);
		const seated = layout?.positions.filter((p) => p !== null).length ?? 0;
		if (layout && layout.seeds.length === rankedIds.length && seated === rankedIds.length) break;
		layout = null;
	}
	if (!layout) return { ok: false, error: `StartGG has not seated all ${rankedIds.length} players in the ${label} bracket` };

	const seedNumForRank = seedNumbersForStandardLayout(layout.positions, rankedIds.length);
	if (!seedNumForRank) return { ok: false, error: `StartGG's ${label} bracket layout is not one the hub can match` };

	const seedOfEntrant = new Map(layout.seeds.map((s) => [s.entrantId, s]));
	const seedMapping = rankedIds.map((entrantId, i) => ({
		seedId: seedOfEntrant.get(entrantId)!.seedId,
		phaseGroupId: String(phaseGroupId),
		seedNum: seedNumForRank[i]
	}));
	const alreadySeeded = rankedIds.every((entrantId, i) => seedOfEntrant.get(entrantId)!.seedNum === seedNumForRank[i]);
	if (!alreadySeeded) {
		const data = await gql(
			UPDATE_PHASE_SEEDING_MUTATION,
			{ phaseId: String(phaseId), seedMapping: [...seedMapping].sort((a, b) => a.seedNum - b.seedNum) },
			{ delay: 0 }
		).catch(() => null);
		if (!data) return { ok: false, error: `Pushing ${label} bracket seeding failed` };
		log(`Pushed ${label} bracket seeding`);
	}

	// Once results are in, the two sides only agree after every report has gone through,
	// so the comparison is only meaningful on an untouched bracket.
	const started = bracket.matches.some((m) => m.winnerId && m.topPlayerId && m.bottomPlayerId);
	if (started) return { ok: true };

	const ours = hubOpenPairs(bracket, bracketEntrantId);
	for (let attempt = 0; attempt < 4; attempt++) {
		await sleep(1500);
		const now = await fetchPhaseGroupLayout(phaseGroupId);
		if (!now) continue;
		const theirs = new Set(now.openPairs.map(([a, b]) => pairKey(a, b)));
		if (theirs.size === ours.size && [...ours].every((k) => theirs.has(k))) {
			log(`${label}: StartGG's first matches agree with the hub (${ours.size} sets)`);
			return { ok: true, verified: true };
		}
	}
	return { ok: false, error: `StartGG's ${label} bracket does not pair the same players as the hub` };
}
