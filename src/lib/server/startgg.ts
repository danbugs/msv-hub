import { env } from '$env/dynamic/private';

const API_URL = 'https://api.start.gg/gql/alpha';
const API_DELAY = 800;
const SETS_PER_PAGE = 50;

function getToken(): string {
	const token = env.STARTGG_TOKEN;
	if (!token) throw new Error('STARTGG_TOKEN must be set');
	return token;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(new DOMException('Aborted', 'AbortError'));
		}, { once: true });
	});
}

export async function gql<T = Record<string, unknown>>(
	query: string,
	variables: Record<string, unknown>,
	signalOrOptions?: AbortSignal | { signal?: AbortSignal; delay?: number }
): Promise<T | null> {
	let signal: AbortSignal | undefined;
	let delay = API_DELAY;
	if (signalOrOptions instanceof AbortSignal) {
		signal = signalOrOptions;
	} else if (signalOrOptions) {
		signal = signalOrOptions.signal;
		delay = signalOrOptions.delay ?? API_DELAY;
	}
	await sleep(delay, signal);
	const token = getToken();
	const res = await fetch(API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({ query, variables }),
		signal
	});

	if (res.status === 429) {
		console.warn('StartGG rate limited, waiting 10s...');
		await sleep(10_000, signal);
		return gql(query, variables, signal);
	}

	if (!res.ok) {
		console.error(`StartGG HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
		return null;
	}

	const json = await res.json();
	if (json.errors) {
		for (const err of json.errors) {
			console.error(`StartGG GraphQL error: ${err.message ?? JSON.stringify(err)}`);
		}
		return null;
	}

	return json.data as T;
}

// ── Queries ──────────────────────────────────────────────────────────────

export const TOURNAMENT_QUERY = `
query TournamentEvents($slug: String!) {
  tournament(slug: $slug) {
    id
    name
    startAt
    events(filter: { videogameId: [1386] }) {
      id
      name
      numEntrants
    }
  }
}`;

export const EVENT_SETS_QUERY = `
query EventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    name
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { totalPages }
      nodes {
        id
        displayScore
        winnerId
        fullRoundText
        phaseGroup { bracketType }
        slots {
          seed { seedNum }
          entrant {
            id
            name
            participants {
              player { id gamerTag }
            }
          }
        }
      }
    }
  }
}`;

export const EVENT_ENTRANTS_QUERY = `
query EventEntrants($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    name
    entrants(query: { page: $page, perPage: $perPage }) {
      pageInfo { totalPages }
      nodes {
        id
        participants {
          player { id gamerTag }
        }
      }
    }
  }
}`;

export const EVENT_PHASES_QUERY = `
query EventPhases($eventId: ID!) {
  event(id: $eventId) {
    id
    name
    phases { id name numSeeds }
  }
}`;

export const PHASE_SEEDS_QUERY = `
query PhaseSeeds($phaseId: ID!, $page: Int!, $perPage: Int!) {
  phase(id: $phaseId) {
    id
    seeds(query: { page: $page, perPage: $perPage }) {
      pageInfo { totalPages }
      nodes {
        id
        seedNum
        entrant {
          id
          participants { player { id } }
        }
      }
    }
  }
}`;

export const PLAYER_RECENT_STANDINGS_QUERY = `
query PlayerRecentStandings($playerId: ID!) {
  player(id: $playerId) {
    id
    gamerTag
    recentStandings(videogameId: 1386, limit: 20) {
      placement
      entrant {
        event {
          numEntrants
          tournament { name }
        }
      }
    }
  }
}`;

export const EVENT_BY_SLUG_QUERY = `
query EventBySlug($slug: String!) {
  event(slug: $slug) { id name }
}`;

export const PHASE_SEEDS_WITH_TAGS_QUERY = `
query PhaseSeedsWithTags($phaseId: ID!, $page: Int!, $perPage: Int!) {
  phase(id: $phaseId) {
    seeds(query: { page: $page, perPage: $perPage }) {
      pageInfo { totalPages }
      nodes {
        seedNum
        entrant {
          name
          participants { player { gamerTag } }
        }
      }
    }
  }
}`;

export const UPDATE_PHASE_SEEDING_MUTATION = `
mutation UpdatePhaseSeeding($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
  updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) { id }
}`;

export const REPORT_BRACKET_SET_MUTATION = `
mutation ReportBracketSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
    id
    winnerId
  }
}`;

export const EVENT_PHASE_GROUPS_QUERY = `
query EventPhaseGroups($phaseId: ID!) {
  phase(id: $phaseId) {
    phaseGroups(query: { page: 1, perPage: 64 }) {
      nodes { id displayIdentifier }
    }
  }
}`;

export const PHASE_GROUP_SETS_QUERY = `
query PhaseGroupSets($phaseGroupId: ID!) {
  phaseGroup(id: $phaseGroupId) {
    sets(page: 1, perPage: 64, sortType: STANDARD) {
      nodes {
        id
        winnerId
        slots { entrant { id } }
      }
    }
  }
}`;

export const PHASE_GROUP_SEEDS_QUERY = `
query PhaseGroupSeeds($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
  phaseGroup(id: $phaseGroupId) {
    seeds(query: { page: $page, perPage: $perPage }) {
      pageInfo { totalPages }
      nodes {
        id
        entrant { id }
      }
    }
  }
}`;

// ── Paginated fetchers ──────────────────────────────────────────────────

interface PagedResult<T> {
	pageInfo: { totalPages: number };
	nodes: T[];
}

async function fetchAllPages<T>(
	query: string,
	variables: Record<string, unknown>,
	pathToData: (data: Record<string, unknown>) => PagedResult<T> | null,
	signal?: AbortSignal,
	delay?: number
): Promise<T[]> {
	const all: T[] = [];
	let page = 1;
	while (true) {
		const opts = delay !== undefined ? { signal, delay } : signal;
		const data = await gql(query, { ...variables, page, perPage: SETS_PER_PAGE }, opts);
		if (!data) break;
		const paged = pathToData(data as Record<string, unknown>);
		if (!paged) break;
		all.push(...paged.nodes);
		if (page >= paged.pageInfo.totalPages) break;
		page++;
	}
	return all;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GqlRecord = Record<string, any>;

export async function fetchAllSets(eventId: number, signal?: AbortSignal, delay?: number): Promise<GqlRecord[]> {
	return fetchAllPages(EVENT_SETS_QUERY, { eventId }, (d) => {
		const event = d.event as GqlRecord | undefined;
		return event?.sets ?? null;
	}, signal, delay);
}

export async function fetchAllEntrants(eventId: number, signal?: AbortSignal): Promise<GqlRecord[]> {
	return fetchAllPages(EVENT_ENTRANTS_QUERY, { eventId }, (d) => {
		const event = d.event as GqlRecord | undefined;
		return event?.entrants ?? null;
	}, signal);
}

export async function fetchPhaseSeeds(phaseId: number, signal?: AbortSignal): Promise<GqlRecord[]> {
	return fetchAllPages(PHASE_SEEDS_QUERY, { phaseId }, (d) => {
		const phase = d.phase as GqlRecord | undefined;
		return phase?.seeds ?? null;
	}, signal);
}

export async function fetchPhaseSeedsWithTags(phaseId: number, signal?: AbortSignal): Promise<{ seedNum: number; gamerTag: string }[]> {
	const nodes = await fetchAllPages(PHASE_SEEDS_WITH_TAGS_QUERY, { phaseId }, (d) => {
		const phase = d.phase as GqlRecord | undefined;
		return phase?.seeds ?? null;
	}, signal);
	return (nodes as GqlRecord[]).map((n) => ({
		seedNum: n.seedNum as number,
		gamerTag: (n.entrant?.participants?.[0]?.player?.gamerTag ?? n.entrant?.name ?? 'Unknown') as string
	})).sort((a, b) => a.seedNum - b.seedNum);
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function extractPlayerId(entrant: GqlRecord): number | null {
	const participants = entrant.participants ?? [];
	for (const p of participants) {
		if (p.player?.id) return p.player.id;
	}
	return null;
}

export function extractGamerTag(entrant: GqlRecord): string {
	const participants = entrant.participants ?? [];
	for (const p of participants) {
		if (p.player?.gamerTag) return p.player.gamerTag;
	}
	return entrant.name ?? 'Unknown';
}

export async function fetchPhaseGroups(
	phaseId: number
): Promise<{ id: number; displayIdentifier: string }[]> {
	const data = await gql<{ phase: { phaseGroups: { nodes: GqlRecord[] } } }>(
		EVENT_PHASE_GROUPS_QUERY,
		{ phaseId }
	);
	const nodes = data?.phase?.phaseGroups?.nodes ?? [];
	return (nodes as GqlRecord[])
		.map((n) => ({ id: n.id as number, displayIdentifier: String(n.displayIdentifier ?? '') }))
		.sort((a, b) => a.displayIdentifier.localeCompare(b.displayIdentifier));
}

/**
 * Find the StartGG set ID for two entrants within a specific phase group.
 * Returns null if no unreported set is found.
 * Uses delay:0 — suitable for real-time per-match calls.
 */
export async function findSetInPhaseGroup(
	phaseGroupId: number,
	entrantId1: number,
	entrantId2: number
): Promise<string | null> {
	const data = await gql<{ phaseGroup: { sets: { nodes: GqlRecord[] } } }>(
		PHASE_GROUP_SETS_QUERY,
		{ phaseGroupId },
		{ delay: 0 }
	);
	const nodes = data?.phaseGroup?.sets?.nodes ?? [];
	// Only return unreported sets. Completed sets (from previous test runs or prior phases)
	// would result in "Cannot report completed set via API". Re-reports use the cached
	// match.startggSetId directly and never go through this lookup.
	for (const set of nodes as GqlRecord[]) {
		if (set.winnerId) continue;
		const ids: number[] = (set.slots ?? [])
			.map((s: GqlRecord) => s.entrant?.id as number | undefined)
			.filter((id: number | undefined): id is number => id !== undefined);
		if (ids.includes(entrantId1) && ids.includes(entrantId2)) {
			return String(set.id);
		}
	}
	return null;
}

/**
 * Find the StartGG set ID by scanning all event sets.
 * Fallback when no phase group ID is known.
 * Uses delay:0 for real-time use.
 */
export async function findSetByEntrants(
	eventId: number,
	entrantId1: number,
	entrantId2: number
): Promise<string | null> {
	const sets = await fetchAllSets(eventId, undefined, 0); // delay:0 — real-time call
	// Only return unreported sets (same reasoning as findSetInPhaseGroup above).
	for (const set of sets as GqlRecord[]) {
		if (set.winnerId) continue;
		const ids: number[] = (set.slots ?? [])
			.map((s: GqlRecord) => s.entrant?.id as number | undefined)
			.filter((id: number | undefined): id is number => id !== undefined);
		if (ids.includes(entrantId1) && ids.includes(entrantId2)) {
			return String(set.id);
		}
	}
	return null;
}

/**
 * Report a StartGG set result, optionally with per-game data for 2-0 vs 2-1 display.
 * Bypasses gql() so the actual GraphQL error message is surfaced on failure.
 * Uses no delay — safe for real-time calls.
 */
export async function reportSet(
	setId: string,
	winnerEntrantId: number,
	extra?: { loserEntrantId?: number; winnerScore?: number; loserScore?: number }
): Promise<{ ok: boolean; error?: string }> {
	const token = getToken();

	let gameData: { winnerId: string; gameNum: number }[] | undefined;
	if (extra?.loserEntrantId && extra.winnerScore !== undefined && extra.loserScore !== undefined) {
		const w = String(winnerEntrantId);
		const l = String(extra.loserEntrantId);
		if (extra.loserScore === 0) {
			// 2-0
			gameData = [
				{ gameNum: 1, winnerId: w },
				{ gameNum: 2, winnerId: w }
			];
		} else {
			// 2-1: winner takes games 1 & 3, loser takes game 2
			gameData = [
				{ gameNum: 1, winnerId: w },
				{ gameNum: 2, winnerId: l },
				{ gameNum: 3, winnerId: w }
			];
		}
	}

	const variables: Record<string, unknown> = { setId, winnerId: String(winnerEntrantId) };
	if (gameData) variables.gameData = gameData;

	let res: Response;
	try {
		res = await fetch(API_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ query: REPORT_BRACKET_SET_MUTATION, variables })
		});
	} catch (e) {
		return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
	}

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, error: `StartGG HTTP ${res.status}: ${text.slice(0, 200)}` };
	}

	const json = await res.json().catch(() => null);
	if (!json) return { ok: false, error: 'StartGG returned non-JSON response' };

	if (json.errors?.length) {
		const msg = (json.errors as { message?: string }[])
			.map((e) => e.message ?? JSON.stringify(e))
			.join('; ');
		return { ok: false, error: `StartGG: ${msg}` };
	}

	if (!json.data?.reportBracketSet) {
		return { ok: false, error: 'StartGG mutation returned empty result — set may already be reported or locked' };
	}

	return { ok: true };
}

/**
 * Re-seed a StartGG phase group to match MSV Hub pairings.
 * Assigns seedNums 1,2 / 3,4 / ... to each pair so StartGG creates matching sets.
 * Best-effort — errors are returned but should never block MSV Hub.
 */
export async function pushPairingsToPhaseGroup(
	phaseId: number,
	phaseGroupId: number,
	pairings: [number, number][]  // [startggEntrantId1, startggEntrantId2][]
): Promise<{ ok: boolean; error?: string }> {
	// Fetch seeds in this phase group to get seedId per entrant (delay:0 — real-time call)
	const seeds = await fetchAllPages(PHASE_GROUP_SEEDS_QUERY, { phaseGroupId }, (d) => {
		const pg = d.phaseGroup as GqlRecord | undefined;
		return pg?.seeds ?? null;
	}, undefined, 0).catch(() => [] as GqlRecord[]);

	if (!(seeds as GqlRecord[]).length) {
		return { ok: false, error: 'Phase group has no seeds — add players first' };
	}

	const entrantToSeedId = new Map<number, string>();
	for (const seed of seeds as GqlRecord[]) {
		const entrantId = (seed.entrant as { id?: number } | undefined)?.id;
		if (entrantId && seed.id) entrantToSeedId.set(entrantId, String(seed.id));
	}

	const seedMapping: { seedId: string; phaseGroupId: string; seedNum: number }[] = [];
	pairings.forEach(([e1, e2], i) => {
		const s1 = entrantToSeedId.get(e1);
		const s2 = entrantToSeedId.get(e2);
		if (s1) seedMapping.push({ seedId: s1, phaseGroupId: String(phaseGroupId), seedNum: 2 * i + 1 });
		if (s2) seedMapping.push({ seedId: s2, phaseGroupId: String(phaseGroupId), seedNum: 2 * i + 2 });
	});

	if (!seedMapping.length) return { ok: false, error: 'No matching seeds found for pairings' };

	const data = await gql(
		UPDATE_PHASE_SEEDING_MUTATION,
		{ phaseId: String(phaseId), seedMapping },
		{ delay: 0 }
	).catch(() => null);
	if (!data) return { ok: false, error: 'updatePhaseSeeding mutation failed' };
	return { ok: true };
}
