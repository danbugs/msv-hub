import { env } from '$env/dynamic/private';

const API_URL = 'https://api.start.gg/gql/alpha';
const API_DELAY = 800;
const SETS_PER_PAGE = 50;

// StartGG character IDs for SSBU (videogame 1386) — fetched from StartGG API
// Keys match MSV Hub's character list in brackets page; aliases added for API name mismatches.
const SSBU_CHAR_IDS: Record<string, number> = {
	'Mario': 1302, 'Donkey Kong': 1280, 'Link': 1296, 'Samus': 1328, 'Dark Samus': 1408,
	'Yoshi': 1338, 'Kirby': 1295, 'Fox': 1286, 'Pikachu': 1319, 'Luigi': 1301,
	'Ness': 1313, 'Captain Falcon': 1274, 'Jigglypuff': 1293, 'Peach': 1317, 'Daisy': 1277,
	'Bowser': 1273, 'Ice Climbers': 1290, 'Sheik': 1329, 'Zelda': 1340, 'Dr. Mario': 1282,
	'Pichu': 1318, 'Falco': 1285, 'Marth': 1304, 'Lucina': 1300, 'Young Link': 1339,
	'Ganondorf': 1287, 'Mewtwo': 1310, 'Roy': 1326, 'Chrom': 1409, 'Mr. Game & Watch': 1405,
	'Meta Knight': 1307, 'Pit': 1320, 'Dark Pit': 1278, 'Zero Suit Samus': 1341, 'Wario': 1335,
	'Snake': 1331, 'Ike': 1291, 'Pokemon Trainer': 1321, 'Diddy Kong': 1279, 'Lucas': 1299,
	'Sonic': 1332, 'King Dedede': 1294, 'Olimar': 1314, 'Lucario': 1298, 'R.O.B.': 1323,
	'Toon Link': 1333, 'Wolf': 1337, 'Villager': 1334, 'Mega Man': 1305, 'Wii Fit Trainer': 1336,
	'Rosalina & Luma': 1325, 'Rosalina': 1325, 'Little Mac': 1297, 'Greninja': 1289,
	'Palutena': 1316, 'Pac-Man': 1315, 'Robin': 1324, 'Shulk': 1330, 'Bowser Jr.': 1272,
	'Duck Hunt': 1283, 'Ryu': 1327, 'Ken': 1410, 'Cloud': 1275, 'Corrin': 1276,
	'Bayonetta': 1271, 'Inkling': 1292, 'Ridley': 1322, 'Simon': 1411, 'Simon Belmont': 1411,
	'Richter': 1412, 'King K. Rool': 1407, 'Isabelle': 1413, 'Incineroar': 1406,
	'Piranha Plant': 1441, 'Joker': 1453, 'Hero': 1526, 'Banjo & Kazooie': 1530,
	'Banjo-Kazooie': 1530, 'Terry': 1532, 'Byleth': 1539, 'Min Min': 1747, 'Steve': 1766,
	'Sephiroth': 1777, 'Pyra/Mythra': 1795, 'Pyra & Mythra': 1795, 'Kazuya': 1846, 'Sora': 1897,
	'Mii Brawler': 1311, 'Mii Gunner': 1415, 'Mii Swordfighter': 1414
};

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
        identifier
        round
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
mutation ReportBracketSet($setId: ID!, $winnerId: ID!, $isDQ: Boolean, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, isDQ: $isDQ, gameData: $gameData) {
    id
    winnerId
  }
}`;

export const RESET_SET_MUTATION = `
mutation ResetSet($setId: ID!) {
  resetSet(setId: $setId) { id }
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
        entrant { id participants { player { id } } }
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
	const fetchNodes = async () => {
		const data = await gql<{ phaseGroup: { sets: { nodes: GqlRecord[] } } }>(
			PHASE_GROUP_SETS_QUERY,
			{ phaseGroupId },
			{ delay: 0 }
		);
		return data?.phaseGroup?.sets?.nodes ?? [];
	};

	let nodes = await fetchNodes();

	// If the phase group returned 0 sets, it may be mid-transition from preview sets to
	// real sets (triggered when the first preview set is reported). Retry with increasing
	// back-off — conversions can take 5-30s on StartGG's side.
	if (nodes.length === 0) {
		for (let retry = 1; retry <= 8; retry++) {
			await new Promise<void>((r) => setTimeout(r, retry <= 3 ? 2000 : 5000));
			nodes = await fetchNodes();
			if (nodes.length > 0) break;
		}
	}
	// Prefer unreported sets. If only a completed set is found, return it anyway so
	// reportSet can surface the "Cannot report completed set" error from StartGG rather
	// than silently returning "set not found".
	// Coerce to numbers — StartGG returns IDs as numbers but they may be stored as strings
	// if the tournament was loaded when the API returned a string type.
	const e1 = Number(entrantId1);
	const e2 = Number(entrantId2);
	let completedFallback: string | null = null;
	for (const set of nodes as GqlRecord[]) {
		const ids = (set.slots ?? [])
			.map((s: GqlRecord) => Number(s.entrant?.id))
			.filter((n: number) => !isNaN(n) && n > 0);
		if (ids.includes(e1) && ids.includes(e2)) {
			if (!set.winnerId) return String(set.id); // unreported — use immediately
			completedFallback ??= String(set.id);     // completed — remember as fallback
		}
	}
	return completedFallback;
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
	let sets = await fetchAllSets(eventId, undefined, 0); // delay:0 — real-time call

	// If 0 sets returned, may be mid preview→real conversion. Retry with back-off.
	if (sets.length === 0) {
		for (let retry = 1; retry <= 8; retry++) {
			await new Promise<void>((r) => setTimeout(r, retry <= 3 ? 2000 : 5000));
			sets = await fetchAllSets(eventId, undefined, 0);
			if (sets.length > 0) break;
		}
	}

	// Prefer unreported sets; fall back to completed (same reasoning as findSetInPhaseGroup).
	const e1 = Number(entrantId1);
	const e2 = Number(entrantId2);
	let completedFallback: string | null = null;
	for (const set of sets as GqlRecord[]) {
		const ids = (set.slots ?? [])
			.map((s: GqlRecord) => Number(s.entrant?.id))
			.filter((n: number) => !isNaN(n) && n > 0);
		if (ids.includes(e1) && ids.includes(e2)) {
			if (!set.winnerId) return String(set.id);
			completedFallback ??= String(set.id);
		}
	}
	return completedFallback;
}

/**
 * Report a StartGG set result, optionally with per-game data for 2-0 vs 2-1 display.
 * Bypasses gql() so the actual GraphQL error message is surfaced on failure.
 * Uses no delay — safe for real-time calls.
 */
export async function reportSet(
	setId: string,
	winnerEntrantId: number,
	extra?: {
		loserEntrantId?: number;
		winnerScore?: number;
		loserScore?: number;
		isDQ?: boolean;
		gameCharacters?: { entrantId: number; characters: string[] }[];
		/** Per-game winners: 'top' or 'bottom' for each game. 'top' = winnerEntrantId won. */
		gameWinners?: ('top' | 'bottom')[];
		/** IDs for top/bottom mapping: top entrant ID, bottom entrant ID */
		topEntrantId?: number;
		bottomEntrantId?: number;
	}
): Promise<{ ok: boolean; reportedSetId?: string; error?: string }> {
	const token = getToken();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let gameData: Record<string, any>[] | undefined;
	if (!extra?.isDQ && extra?.loserEntrantId && extra.winnerScore !== undefined && extra.loserScore !== undefined) {
		const w = String(winnerEntrantId);
		const l = String(extra.loserEntrantId);
		const wScore = extra.winnerScore;
		const lScore = extra.loserScore;

		// Build per-game character selections lookup
		const charsByEntrant = new Map<number, string[]>();
		if (extra.gameCharacters) {
			for (const gc of extra.gameCharacters) charsByEntrant.set(gc.entrantId, gc.characters);
		}

		// Build game data. If gameWinners is provided, use exact per-game results.
		// Otherwise, use the default pattern (winner wins first, loser wins middle, winner clinches).
		gameData = [];
		const totalGames = wScore + lScore;

		if (extra.gameWinners?.length === totalGames && extra.topEntrantId && extra.bottomEntrantId) {
			// Exact per-game winners provided by the user
			for (let i = 0; i < totalGames; i++) {
				const gw = extra.gameWinners[i];
				const gameWinnerId = gw === 'top' ? String(extra.topEntrantId) : String(extra.bottomEntrantId);
				gameData.push(buildGameEntry(i + 1, gameWinnerId, extra.topEntrantId, extra.bottomEntrantId, charsByEntrant, i));
			}
		} else {
			// Default pattern: W,W,...,L,L,...,W (winner wins first batch, loser wins middle, winner clinches)
			let gameNum = 1;
			const winnerFirstBatch = lScore > 0 ? wScore - 1 : wScore;
			for (let i = 0; i < winnerFirstBatch; i++) {
				gameData.push(buildGameEntry(gameNum, w, winnerEntrantId, extra.loserEntrantId, charsByEntrant, gameNum - 1));
				gameNum++;
			}
			for (let i = 0; i < lScore; i++) {
				gameData.push(buildGameEntry(gameNum, l, winnerEntrantId, extra.loserEntrantId, charsByEntrant, gameNum - 1));
				gameNum++;
			}
			if (lScore > 0) {
				gameData.push(buildGameEntry(gameNum, w, winnerEntrantId, extra.loserEntrantId, charsByEntrant, gameNum - 1));
				gameNum++;
			}
		}
	}

	function buildGameEntry(
		gameNum: number, winnerId: string,
		entrantA: number, entrantB: number,
		charsByEntrant: Map<number, string[]>, gameIdx: number
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	): Record<string, any> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const entry: Record<string, any> = { gameNum, winnerId };
		const selections: { entrantId: string; characterId: number }[] = [];
		for (const eid of [entrantA, entrantB]) {
			const chars = charsByEntrant.get(eid);
			const charName = chars?.[gameIdx];
			if (charName) {
				const charId = SSBU_CHAR_IDS[charName];
				if (charId) selections.push({ entrantId: String(eid), characterId: charId });
			}
		}
		if (selections.length > 0) entry.selections = selections;
		return entry;
	}

	const variables: Record<string, unknown> = { setId, winnerId: String(winnerEntrantId) };
	if (extra?.isDQ) variables.isDQ = true;
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

	if (res.status === 429) {
		console.warn('StartGG rate limited on reportSet, waiting 10s...');
		await new Promise<void>((r) => setTimeout(r, 10_000));
		return reportSet(setId, winnerEntrantId, extra);
	}

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		const cleanText = text.replace(/<[^>]*>/g, '').slice(0, 100).trim() || `status ${res.status}`;
		const label = res.status === 504 ? 'StartGG timed out (try again)' : `StartGG HTTP ${res.status}: ${cleanText}`;
		return { ok: false, error: label };
	}

	const json = await res.json().catch(() => null);
	if (!json) return { ok: false, error: 'StartGG returned non-JSON response' };

	if (json.errors?.length) {
		const msg = (json.errors as { message?: string }[])
			.map((e) => e.message ?? JSON.stringify(e))
			.join('; ');
		return { ok: false, error: `StartGG: ${msg}` };
	}

	// StartGG returns null for reportBracketSet on preview sets even when the mutation
	// succeeded. Treat "no errors + data field present" as success regardless of whether
	// the reportBracketSet body is populated.
	if (!('data' in json)) {
		return { ok: false, error: `StartGG returned unexpected response shape for set ${setId}` };
	}

	// When reporting a preview set, StartGG creates a real set with a new integer ID.
	// The mutation returns that new ID in reportBracketSet.id (or null if already real).
	const reportedId = json.data?.reportBracketSet?.id;
	return { ok: true, reportedSetId: reportedId != null ? String(reportedId) : undefined };
}

/**
 * Reset a StartGG set back to unreported state.
 * Used after the fake-report that triggers preview→real ID conversion.
 */
export async function resetSet(setId: string): Promise<{ ok: boolean; error?: string }> {
	const token = getToken();
	try {
		const res = await fetch(API_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ query: RESET_SET_MUTATION, variables: { setId } })
		});
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		const json = await res.json().catch(() => null);
		if (!json || json.errors?.length) {
			const msg = (json?.errors as { message?: string }[] | undefined)
				?.map((e) => e.message ?? JSON.stringify(e)).join('; ') ?? 'Reset failed';
			return { ok: false, error: msg };
		}
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Re-seed a StartGG phase group to match MSV Hub pairings.
 *
 * StartGG Swiss uses a fold pattern: seed i vs seed K+i (where K = number of pairings).
 * For example, with 32 entrants (K=16): seed 1 vs seed 17, seed 2 vs seed 18, etc.
 * We assign seedNums so that each pair lands on opposite halves of the fold:
 *   pair[0] → seeds 1, K+1   pair[1] → seeds 2, K+2   etc.
 *
 * Best-effort — errors are returned but should never block MSV Hub.
 */
export async function pushPairingsToPhaseGroup(
	phaseId: number,
	phaseGroupId: number,
	pairings: [number, number][],  // [startggEntrantId1, startggEntrantId2][]
	byeEntrantId?: number
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

	// Fold pattern: pair i's players go to seeds (i+1) and (K+i+1)
	const K = pairings.length;
	const seedMapping: { seedId: string; phaseGroupId: string; seedNum: number }[] = [];
	pairings.forEach(([e1, e2], i) => {
		const s1 = entrantToSeedId.get(e1);
		const s2 = entrantToSeedId.get(e2);
		if (s1) seedMapping.push({ seedId: s1, phaseGroupId: String(phaseGroupId), seedNum: i + 1 });
		if (s2) seedMapping.push({ seedId: s2, phaseGroupId: String(phaseGroupId), seedNum: K + i + 1 });
	});

	// Bye player goes to the last seed so they don't interfere with fold pairings
	if (byeEntrantId) {
		const s = entrantToSeedId.get(byeEntrantId);
		if (s) seedMapping.push({ seedId: s, phaseGroupId: String(phaseGroupId), seedNum: 2 * K + 1 });
	}

	if (!seedMapping.length) return { ok: false, error: 'No matching seeds found for pairings' };

	// StartGG requires seedMapping sorted by seedNum in increasing order
	seedMapping.sort((a, b) => a.seedNum - b.seedNum);

	const data = await gql(
		UPDATE_PHASE_SEEDING_MUTATION,
		{ phaseId: String(phaseId), seedMapping },
		{ delay: 0 }
	).catch(() => null);
	if (!data) return { ok: false, error: 'updatePhaseSeeding mutation failed' };
	return { ok: true };
}

/**
 * Push final Swiss standings to the "Final Standings" phase on StartGG.
 *
 * This re-seeds the phase group so that seed 1 = 1st place, seed 2 = 2nd place, etc.
 * The TO then just needs to finalize placements on StartGG.
 *
 * @param rankedEntrantIds - StartGG entrant IDs in final standing order (index 0 = 1st place)
 */
export async function pushFinalStandingsSeeding(
	phaseId: number,
	phaseGroupId: number,
	rankedEntrantIds: number[]
): Promise<{ ok: boolean; error?: string }> {
	// Fetch seeds in this phase group to get seedId per entrant
	const seeds = await fetchAllPages(PHASE_GROUP_SEEDS_QUERY, { phaseGroupId }, (d) => {
		const pg = d.phaseGroup as GqlRecord | undefined;
		return pg?.seeds ?? null;
	}, undefined, 0).catch(() => [] as GqlRecord[]);

	if (!(seeds as GqlRecord[]).length) {
		return { ok: false, error: 'Final Standings phase group has no seeds' };
	}

	const entrantToSeedId = new Map<number, string>();
	for (const seed of seeds as GqlRecord[]) {
		const entrantId = (seed.entrant as { id?: number } | undefined)?.id;
		if (entrantId && seed.id) entrantToSeedId.set(entrantId, String(seed.id));
	}

	const seedMapping: { seedId: string; phaseGroupId: string; seedNum: number }[] = [];
	rankedEntrantIds.forEach((entrantId, i) => {
		const seedId = entrantToSeedId.get(entrantId);
		if (seedId) {
			seedMapping.push({ seedId, phaseGroupId: String(phaseGroupId), seedNum: i + 1 });
		}
	});

	if (!seedMapping.length) return { ok: false, error: 'No matching seeds found for final standings' };

	seedMapping.sort((a, b) => a.seedNum - b.seedNum);

	const data = await gql(
		UPDATE_PHASE_SEEDING_MUTATION,
		{ phaseId: String(phaseId), seedMapping },
		{ delay: 0 }
	).catch(() => null);
	if (!data) return { ok: false, error: 'updatePhaseSeeding for Final Standings failed' };
	return { ok: true };
}

/**
 * Push bracket seeding by matching players across events via player ID.
 *
 * StartGG entrant IDs differ between events — the same person has different entrant IDs
 * in the Swiss event vs the bracket event. This function matches by player ID (which is
 * consistent across events) to build the correct seed mapping.
 *
 * @param swissEntrantIds - Swiss event entrant IDs in desired seed order (index 0 = seed 1)
 * @param swissPhaseGroupId - Swiss event phase group (to look up player IDs)
 */
export async function pushBracketSeeding(
	bracketPhaseId: number,
	bracketPhaseGroupId: number,
	swissEntrantIds: number[],
	swissPhaseGroupId: number
): Promise<{ ok: boolean; error?: string }> {
	// Fetch seeds from BOTH phase groups to get player IDs
	const [swissSeeds, bracketSeeds] = await Promise.all([
		fetchAllPages(PHASE_GROUP_SEEDS_QUERY, { phaseGroupId: swissPhaseGroupId }, (d) => {
			const pg = d.phaseGroup as GqlRecord | undefined;
			return pg?.seeds ?? null;
		}, undefined, 0).catch(() => [] as GqlRecord[]),
		fetchAllPages(PHASE_GROUP_SEEDS_QUERY, { phaseGroupId: bracketPhaseGroupId }, (d) => {
			const pg = d.phaseGroup as GqlRecord | undefined;
			return pg?.seeds ?? null;
		}, undefined, 0).catch(() => [] as GqlRecord[])
	]);

	if (!(bracketSeeds as GqlRecord[]).length) {
		return { ok: false, error: 'Bracket phase group has no seeds' };
	}

	// Build Swiss entrantId → playerId map
	const swissEntrantToPlayer = new Map<number, number>();
	for (const seed of swissSeeds as GqlRecord[]) {
		const entrantId = seed.entrant?.id;
		const playerId = seed.entrant?.participants?.[0]?.player?.id;
		if (entrantId && playerId) swissEntrantToPlayer.set(Number(entrantId), Number(playerId));
	}

	// Build bracket playerId → seedId map
	const bracketPlayerToSeedId = new Map<number, string>();
	for (const seed of bracketSeeds as GqlRecord[]) {
		const playerId = seed.entrant?.participants?.[0]?.player?.id;
		if (playerId && seed.id) bracketPlayerToSeedId.set(Number(playerId), String(seed.id));
	}

	// Build seed mapping: Swiss entrant order → bracket seedId assignment
	const seedMapping: { seedId: string; phaseGroupId: string; seedNum: number }[] = [];
	let matched = 0;
	swissEntrantIds.forEach((swissEntrantId, i) => {
		const playerId = swissEntrantToPlayer.get(swissEntrantId);
		if (!playerId) return;
		const bracketSeedId = bracketPlayerToSeedId.get(playerId);
		if (!bracketSeedId) return;
		seedMapping.push({ seedId: bracketSeedId, phaseGroupId: String(bracketPhaseGroupId), seedNum: i + 1 });
		matched++;
	});

	if (!seedMapping.length) {
		return { ok: false, error: `No player matches found between Swiss and bracket (${swissEntrantToPlayer.size} Swiss players, ${bracketPlayerToSeedId.size} bracket players)` };
	}

	console.log(`[StartGG] pushBracketSeeding: matched ${matched}/${swissEntrantIds.length} players`);
	seedMapping.sort((a, b) => a.seedNum - b.seedNum);

	const data = await gql(
		UPDATE_PHASE_SEEDING_MUTATION,
		{ phaseId: String(bracketPhaseId), seedMapping },
		{ delay: 0 }
	).catch(() => null);
	if (!data) return { ok: false, error: 'updatePhaseSeeding for bracket failed' };
	return { ok: true };
}
