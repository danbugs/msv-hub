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
mutation ReportBracketSet($setId: ID!, $winnerId: ID!) {
  reportBracketSet(setId: $setId, winnerId: $winnerId) {
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

// ── Paginated fetchers ──────────────────────────────────────────────────

interface PagedResult<T> {
	pageInfo: { totalPages: number };
	nodes: T[];
}

async function fetchAllPages<T>(
	query: string,
	variables: Record<string, unknown>,
	pathToData: (data: Record<string, unknown>) => PagedResult<T> | null,
	signal?: AbortSignal
): Promise<T[]> {
	const all: T[] = [];
	let page = 1;
	while (true) {
		const data = await gql(query, { ...variables, page, perPage: SETS_PER_PAGE }, signal);
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

export async function fetchAllSets(eventId: number, signal?: AbortSignal): Promise<GqlRecord[]> {
	return fetchAllPages(EVENT_SETS_QUERY, { eventId }, (d) => {
		const event = d.event as GqlRecord | undefined;
		return event?.sets ?? null;
	}, signal);
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
	for (const set of nodes as GqlRecord[]) {
		const ids: number[] = (set.slots ?? [])
			.map((s: GqlRecord) => s.entrant?.id as number | undefined)
			.filter((id: number | undefined): id is number => id !== undefined);
		if (ids.includes(entrantId1) && ids.includes(entrantId2) && !set.winnerId) {
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
	const sets = await fetchAllSets(eventId, undefined);
	for (const set of sets as GqlRecord[]) {
		const ids: number[] = (set.slots ?? [])
			.map((s: GqlRecord) => s.entrant?.id as number | undefined)
			.filter((id: number | undefined): id is number => id !== undefined);
		if (ids.includes(entrantId1) && ids.includes(entrantId2) && !set.winnerId) {
			return String(set.id);
		}
	}
	return null;
}

/**
 * Report a StartGG set result.
 * winnerEntrantId must be the StartGG entrant ID (not the MSV Hub internal ID).
 * Uses delay:0 — safe for real-time calls.
 */
export async function reportSet(
	setId: string,
	winnerEntrantId: number
): Promise<{ ok: boolean; error?: string }> {
	const data = await gql(
		REPORT_BRACKET_SET_MUTATION,
		{ setId, winnerId: String(winnerEntrantId) },
		{ delay: 0 }
	);
	if (!data) return { ok: false, error: 'StartGG mutation returned null — check token/permissions' };
	return { ok: true };
}
