import {
	gql,
	TOURNAMENT_QUERY,
	EVENT_BY_SLUG_QUERY,
	EVENT_PHASES_QUERY,
	PLAYER_RECENT_STANDINGS_QUERY,
	UPDATE_PHASE_SEEDING_MUTATION,
	fetchAllSets,
	fetchAllEntrants,
	fetchPhaseSeeds,
	extractPlayerId,
	extractGamerTag
} from './startgg';

// ── Constants ───────────────────────────────────────────────────────────

const ELO_START = 1500;
const ELO_K = 32;

// ── Types ───────────────────────────────────────────────────────────────

export interface SetResult {
	setId: number;
	tournamentSlug: string;
	eventName: string;
	winnerPlayerId: number;
	loserPlayerId: number;
	winnerName: string;
	loserName: string;
	winnerSeed: number | null;
	loserSeed: number | null;
	bracketType: string;
	displayScore: string;
	fullRoundText: string;
}

export interface TournamentData {
	slug: string;
	name: string;
	number: number;
	type: 'micro' | 'macro';
	startAt: number;
	sets: SetResult[];
}

export interface Entrant {
	entrantId: number;
	playerId: number;
	gamerTag: string;
	elo: number;
	jitteredElo: number;
	seedNum: number;
	isNewcomer: boolean;
}

export interface SeederResult {
	entrants: Entrant[];
	pairings: [Entrant, Entrant][];
	unresolvedCollisions: [Entrant, Entrant][];
	/** All previous matchup pairs to avoid (playerIdA-playerIdB keys) */
	avoidPairs: string[];
	targetSlug: string;
	logs: string[];
}

export interface SeederInput {
	mode: 'micro' | 'macro';
	targetNumber: number;
	seasonStart: number;
	microEnd?: number;
	macros?: number[];
	avoidEvents?: string[];
	jitter: number;
	seed?: number;
	apply: boolean;
}

// ── Logging helper ──────────────────────────────────────────────────────

export type LogCallback = (msg: string) => void;

function createLogger(onLog?: LogCallback) {
	const logs: string[] = [];
	return {
		log: (msg: string) => {
			logs.push(msg);
			console.log(`[seeder] ${msg}`);
			onLog?.(msg);
		},
		warn: (msg: string) => {
			logs.push(`WARN: ${msg}`);
			console.warn(`[seeder] ${msg}`);
			onLog?.(`WARN: ${msg}`);
		},
		logs
	};
}

// ── Set parsing ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSet(node: Record<string, any>, tournamentSlug: string, eventName: string): SetResult | null {
	if (!node) return null;

	const displayScore: string = node.displayScore ?? '';
	if (displayScore.toUpperCase().includes('DQ')) return null;

	const winnerId = node.winnerId;
	if (!winnerId) return null;

	const slots = node.slots ?? [];
	if (slots.length !== 2) return null;

	const bracketType: string = node.phaseGroup?.bracketType ?? '';
	const fullRoundText: string = node.fullRoundText ?? '';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const slotData = slots.map((slot: any) => {
		const entrant = slot.entrant;
		if (!entrant) return null;
		const playerId = extractPlayerId(entrant);
		if (playerId === null) return null;
		return {
			entrantId: entrant.id as number,
			playerId,
			name: extractGamerTag(entrant),
			seedNum: (slot.seed?.seedNum as number | undefined) ?? null
		};
	});

	if (slotData.some((s: unknown) => s === null)) return null;

	let winner, loser;
	if (slotData[0].entrantId === winnerId) {
		[winner, loser] = slotData;
	} else if (slotData[1].entrantId === winnerId) {
		[winner, loser] = [slotData[1], slotData[0]];
	} else {
		return null;
	}

	return {
		setId: node.id ?? 0,
		tournamentSlug,
		eventName,
		winnerPlayerId: winner.playerId,
		loserPlayerId: loser.playerId,
		winnerName: winner.name,
		loserName: loser.name,
		winnerSeed: winner.seedNum,
		loserSeed: loser.seedNum,
		bracketType,
		displayScore,
		fullRoundText
	};
}

function classifyEventName(name: string): string {
	const lower = name.toLowerCase();
	if (lower.includes('swiss')) return 'swiss';
	if (lower.includes('main')) return 'main';
	if (lower.includes('redemption')) return 'redemption';
	return 'singles';
}

// ── Historical data collection ──────────────────────────────────────────

function buildTournamentSlugs(
	microStart: number,
	microEnd: number,
	macros?: number[]
): { slug: string; number: number; type: 'micro' | 'macro' }[] {
	const slugs: { slug: string; number: number; type: 'micro' | 'macro' }[] = [];
	for (let n = microStart; n <= microEnd; n++) {
		slugs.push({ slug: `microspacing-vancouver-${n}`, number: n, type: 'micro' });
	}
	if (macros) {
		for (const n of macros) {
			slugs.push({ slug: `macrospacing-vancouver-${n}`, number: n, type: 'macro' });
		}
	}
	return slugs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface TournamentQueryResult { tournament: Record<string, any> | null }

async function collectTournamentData(
	slug: string,
	num: number,
	type: 'micro' | 'macro',
	playerRegistry: Map<number, string>,
	log: (msg: string) => void,
	signal?: AbortSignal
): Promise<TournamentData | null> {
	log(`Fetching tournament: ${slug}...`);
	const data = await gql<TournamentQueryResult>(TOURNAMENT_QUERY, { slug }, signal);
	if (!data?.tournament) {
		log(`Tournament '${slug}' not found, skipping.`);
		return null;
	}

	const t = data.tournament;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const events: any[] = t.events ?? [];
	if (!events.length) {
		log(`No events for '${slug}', skipping.`);
		return null;
	}

	const allSets: SetResult[] = [];
	for (const event of events) {
		log(`  Event: ${event.name} (${event.numEntrants ?? 0} entrants)`);
		const rawSets = await fetchAllSets(event.id, signal);
		for (const raw of rawSets) {
			const parsed = parseSet(raw, slug, event.name);
			if (parsed) {
				allSets.push(parsed);
				playerRegistry.set(parsed.winnerPlayerId, parsed.winnerName);
				playerRegistry.set(parsed.loserPlayerId, parsed.loserName);
			}
		}
	}

	log(`  Collected ${allSets.length} sets`);
	return {
		slug,
		name: t.name ?? slug,
		number: num,
		type,
		startAt: t.startAt ?? 0,
		sets: allSets
	};
}

// ── Elo ─────────────────────────────────────────────────────────────────

function computeEloRatings(tournaments: TournamentData[]): Map<number, number> {
	const ratings = new Map<number, number>();
	const getRating = (id: number) => ratings.get(id) ?? ELO_START;

	for (const t of tournaments) {
		for (const s of t.sets) {
			const ra = getRating(s.winnerPlayerId);
			const rb = getRating(s.loserPlayerId);
			const ea = 1.0 / (1.0 + Math.pow(10, (rb - ra) / 400));
			const eb = 1.0 - ea;
			ratings.set(s.winnerPlayerId, ra + ELO_K * (1.0 - ea));
			ratings.set(s.loserPlayerId, rb + ELO_K * (0.0 - eb));
		}
	}

	return ratings;
}

// ── Entrant processing ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseEntrants(rawEntrants: Record<string, any>[]): Entrant[] {
	const seen = new Set<number>();
	const entrants: Entrant[] = [];

	for (const node of rawEntrants) {
		const entrantId = node.id;
		if (!entrantId) continue;
		const playerId = extractPlayerId(node);
		if (playerId === null) continue;
		if (seen.has(playerId)) continue;
		seen.add(playerId);
		entrants.push({
			entrantId,
			playerId,
			gamerTag: extractGamerTag(node),
			elo: 0,
			jitteredElo: 0,
			seedNum: 0,
			isNewcomer: false
		});
	}

	return entrants;
}

async function estimateNewcomerElo(playerId: number, signal?: AbortSignal): Promise<number> {
	const data = await gql<{ player: { recentStandings: { placement: number; entrant: { event: { numEntrants: number } } }[] } }>(
		PLAYER_RECENT_STANDINGS_QUERY,
		{ playerId },
		signal
	);
	if (!data?.player?.recentStandings?.length) return ELO_START;

	const percentiles: number[] = [];
	for (const standing of data.player.recentStandings) {
		const placement = standing.placement;
		const numEntrants = standing.entrant?.event?.numEntrants ?? 0;
		if (placement && numEntrants > 0) {
			percentiles.push((numEntrants - placement + 1) / numEntrants);
		}
	}

	if (!percentiles.length) return ELO_START;
	const avg = percentiles.reduce((a, b) => a + b, 0) / percentiles.length;
	return ELO_START + (avg - 0.5) * 400;
}

async function assignEloRatings(
	entrants: Entrant[],
	eloRatings: Map<number, number>,
	log: (msg: string) => void,
	signal?: AbortSignal
): Promise<void> {
	for (const e of entrants) {
		const known = eloRatings.get(e.playerId);
		if (known !== undefined) {
			e.elo = known;
		} else {
			log(`  Estimating Elo for newcomer: ${e.gamerTag}...`);
			e.elo = await estimateNewcomerElo(e.playerId, signal);
			e.isNewcomer = true;
		}
	}
}

// ── Seeded Random (mulberry32) ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function applyJitter(entrants: Entrant[], jitterMax: number, seed?: number): void {
	const rng = seed !== undefined ? mulberry32(seed) : Math.random;
	for (const e of entrants) {
		e.jitteredElo = e.elo + (rng() * 2 - 1) * jitterMax;
	}
}

function computeSeedOrder(entrants: Entrant[]): void {
	entrants.sort((a, b) => b.jitteredElo - a.jitteredElo);
	for (let i = 0; i < entrants.length; i++) {
		entrants[i].seedNum = i + 1;
	}
}

// ── Swiss R1 pairing & matchup avoidance ────────────────────────────────

function predictSwissR1Pairings(entrants: Entrant[]): [Entrant, Entrant][] {
	const half = Math.floor(entrants.length / 2);
	const pairings: [Entrant, Entrant][] = [];
	for (let i = 0; i < half; i++) {
		pairings.push([entrants[i], entrants[i + half]]);
	}
	return pairings;
}

async function fetchPreviousMatchups(prevSlug: string, signal?: AbortSignal): Promise<Set<string>> {
	const data = await gql<TournamentQueryResult>(TOURNAMENT_QUERY, { slug: prevSlug }, signal);
	if (!data?.tournament) return new Set();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const events: any[] = data.tournament.events ?? [];
	const pairings = new Set<string>();

	for (const event of events) {
		if (classifyEventName(event.name ?? '') !== 'swiss') continue;
		const rawSets = await fetchAllSets(event.id, signal);
		for (const raw of rawSets) {
			const frt = (raw.fullRoundText ?? '').toLowerCase();
			if (!frt.includes('round 1')) continue;
			const parsed = parseSet(raw, prevSlug, event.name ?? '');
			if (parsed) {
				pairings.add(pairKey(parsed.winnerPlayerId, parsed.loserPlayerId));
			}
		}
	}

	return pairings;
}

async function fetchAvoidanceFromEventSlugs(slugs: string[], signal?: AbortSignal): Promise<Set<string>> {
	const pairings = new Set<string>();
	for (const slug of slugs) {
		const data = await gql<{ event: { id: number; name: string } }>(EVENT_BY_SLUG_QUERY, { slug }, signal);
		if (!data?.event) continue;
		const rawSets = await fetchAllSets(data.event.id, signal);
		for (const raw of rawSets) {
			const parsed = parseSet(raw, slug, data.event.name ?? '');
			if (parsed) {
				pairings.add(pairKey(parsed.winnerPlayerId, parsed.loserPlayerId));
			}
		}
	}
	return pairings;
}

function pairKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function avoidMatchups(entrants: Entrant[], toAvoid: Set<string>): void {
	const n = entrants.length;
	const half = Math.floor(n / 2);

	for (let i = 0; i < half; i++) {
		const topPid = entrants[i].playerId;
		const botIdx = i + half;
		const botPid = entrants[botIdx].playerId;

		if (!toAvoid.has(pairKey(topPid, botPid))) continue;

		let resolved = false;

		if (botIdx + 1 < n) {
			const candPid = entrants[botIdx + 1].playerId;
			const otherTopIdx = botIdx + 1 - half;
			if (otherTopIdx < half) {
				const displacedPair = pairKey(entrants[otherTopIdx].playerId, botPid);
				if (!toAvoid.has(pairKey(topPid, candPid)) && !toAvoid.has(displacedPair)) {
					[entrants[botIdx], entrants[botIdx + 1]] = [entrants[botIdx + 1], entrants[botIdx]];
					resolved = true;
				}
			} else if (!toAvoid.has(pairKey(topPid, candPid))) {
				[entrants[botIdx], entrants[botIdx + 1]] = [entrants[botIdx + 1], entrants[botIdx]];
				resolved = true;
			}
		}

		if (!resolved && botIdx - 1 >= half) {
			const candPid = entrants[botIdx - 1].playerId;
			const otherTopIdx = botIdx - 1 - half;
			if (otherTopIdx < half) {
				const displacedPair = pairKey(entrants[otherTopIdx].playerId, botPid);
				if (!toAvoid.has(pairKey(topPid, candPid)) && !toAvoid.has(displacedPair)) {
					[entrants[botIdx], entrants[botIdx - 1]] = [entrants[botIdx - 1], entrants[botIdx]];
					resolved = true;
				}
			}
		}

		if (!resolved) {
			console.warn(`Could not avoid R1 collision: ${entrants[i].gamerTag} vs ${entrants[botIdx].gamerTag}`);
		}
	}

	for (let i = 0; i < entrants.length; i++) {
		entrants[i].seedNum = i + 1;
	}
}

// ── Apply seeding to StartGG ────────────────────────────────────────────

async function applySeeding(
	targetSlug: string,
	entrants: Entrant[],
	log: (msg: string) => void,
	signal?: AbortSignal
): Promise<void> {
	const data = await gql<TournamentQueryResult>(TOURNAMENT_QUERY, { slug: targetSlug }, signal);
	if (!data?.tournament) {
		log('Error: Could not fetch target tournament for apply.');
		return;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const events: any[] = data.tournament.events ?? [];
	const pidToSeed = new Map(entrants.map((e) => [e.playerId, e.seedNum]));

	for (const event of events) {
		log(`Applying seeding to: ${event.name}`);

		const phaseData = await gql<{ event: { phases: { id: number; name: string }[] } }>(
			EVENT_PHASES_QUERY,
			{ eventId: event.id },
			signal
		);
		if (!phaseData?.event?.phases) continue;

		for (const phase of phaseData.event.phases) {
			log(`  Phase: ${phase.name} (ID: ${phase.id})`);

			const rawSeeds = await fetchPhaseSeeds(phase.id, signal);
			if (!rawSeeds.length) {
				log(`  No seeds found for phase ${phase.name}`);
				continue;
			}

			const seedMapping: { seedId: number; seedNum: number }[] = [];
			for (const seedNode of rawSeeds) {
				const playerId = extractPlayerId(seedNode.entrant ?? {});
				if (playerId === null) continue;
				const desired = pidToSeed.get(playerId);
				if (desired === undefined) continue;
				seedMapping.push({ seedId: seedNode.id, seedNum: desired });
			}

			if (!seedMapping.length) {
				log(`  Empty seed mapping for ${phase.name}`);
				continue;
			}

			seedMapping.sort((a, b) => a.seedNum - b.seedNum);

			const result = await gql(UPDATE_PHASE_SEEDING_MUTATION, {
				phaseId: phase.id,
				seedMapping
			}, signal);

			log(result ? `  Applied ${seedMapping.length} seeds` : `  ERROR: Mutation failed for ${phase.name}`);
		}
	}
}

// ── Main seeder function ────────────────────────────────────────────────

export async function runSeeder(input: SeederInput, onLog?: LogCallback, signal?: AbortSignal): Promise<SeederResult> {
	const { log, warn, logs } = createLogger(onLog);

	const isMicro = input.mode === 'micro';
	const targetSlug = isMicro
		? `microspacing-vancouver-${input.targetNumber}`
		: `macrospacing-vancouver-${input.targetNumber}`;

	const microEnd = input.microEnd ?? (isMicro ? input.targetNumber - 1 : input.targetNumber);

	// Step 1: Compute Elo from history
	log('Step 1: Computing Elo ratings from historical tournaments...');
	let eloRatings = new Map<number, number>();
	if (microEnd >= input.seasonStart) {
		const historySlugs = buildTournamentSlugs(input.seasonStart, microEnd, input.macros);
		log(`Processing ${historySlugs.length} historical tournaments...`);
		const playerRegistry = new Map<number, string>();
		const tournaments: TournamentData[] = [];
		for (const { slug, number: num, type } of historySlugs) {
			const td = await collectTournamentData(slug, num, type, playerRegistry, log, signal);
			if (td) tournaments.push(td);
		}
		tournaments.sort((a, b) => a.startAt - b.startAt);
		eloRatings = computeEloRatings(tournaments);
		log(`${eloRatings.size} players with Elo ratings computed.`);
	} else {
		log('No history range. All entrants treated as newcomers.');
	}

	// Step 2: Fetch target entrants
	log(`Step 2: Fetching entrants for ${targetSlug}...`);
	const tData = await gql<TournamentQueryResult>(TOURNAMENT_QUERY, { slug: targetSlug }, signal);
	if (!tData?.tournament) throw new Error(`Tournament '${targetSlug}' not found.`);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const events: any[] = tData.tournament.events ?? [];
	if (!events.length) throw new Error(`No events in '${targetSlug}'.`);

	const firstEvent = events[0];
	log(`Using event: ${firstEvent.name}`);
	const rawEntrants = await fetchAllEntrants(firstEvent.id, signal);
	const entrants = parseEntrants(rawEntrants);
	log(`Found ${entrants.length} entrants.`);

	if (!entrants.length) throw new Error('No entrants found. Is registration open?');

	// Step 3: Assign Elo
	log('Step 3: Assigning Elo ratings...');
	await assignEloRatings(entrants, eloRatings, log, signal);
	const newcomers = entrants.filter((e) => e.isNewcomer).length;
	log(`${entrants.length - newcomers} with MSV Elo, ${newcomers} newcomers estimated.`);

	// Step 4: Jitter
	log(`Step 4: Applying jitter (max +/- ${input.jitter.toFixed(1)})...`);
	applyJitter(entrants, input.jitter, input.seed);

	// Step 5: Compute seed order
	log('Step 5: Computing seed order...');
	computeSeedOrder(entrants);

	// Step 6: Matchup avoidance
	let toAvoid = new Set<string>();
	if (isMicro && microEnd >= input.seasonStart) {
		const prevSlug = `microspacing-vancouver-${input.targetNumber - 1}`;
		log(`Step 6: Fetching R1 pairings from ${prevSlug} for avoidance...`);
		toAvoid = await fetchPreviousMatchups(prevSlug, signal);
		log(`Found ${toAvoid.size} R1 pairings to avoid.`);
	} else if (!isMicro && input.avoidEvents?.length) {
		log(`Step 6: Fetching pairings from ${input.avoidEvents.length} event(s) for avoidance...`);
		toAvoid = await fetchAvoidanceFromEventSlugs(input.avoidEvents, signal);
		log(`Found ${toAvoid.size} pairings to avoid.`);
	} else {
		log('Step 6: No matchup avoidance configured.');
	}

	if (toAvoid.size > 0) {
		avoidMatchups(entrants, toAvoid);
	}

	// Step 7: Predict pairings
	const pairings = predictSwissR1Pairings(entrants);
	const unresolvedCollisions: [Entrant, Entrant][] = [];
	for (const [top, bottom] of pairings) {
		if (toAvoid.has(pairKey(top.playerId, bottom.playerId))) {
			unresolvedCollisions.push([top, bottom]);
		}
	}

	// Step 8: Apply if requested
	if (input.apply) {
		log('Step 8: Applying seeding to StartGG...');
		await applySeeding(targetSlug, entrants, log, signal);
		log('Seeding applied to all events/phases.');
	} else {
		log('Dry run complete. Use Apply to push seeding to StartGG.');
	}

	return { entrants, pairings, unresolvedCollisions, avoidPairs: [...toAvoid], targetSlug, logs };
}
