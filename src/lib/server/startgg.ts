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
	signal?: AbortSignal
): Promise<T | null> {
	await sleep(API_DELAY, signal);
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

export const UPDATE_PHASE_SEEDING_MUTATION = `
mutation UpdatePhaseSeeding($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
  updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) { id }
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
