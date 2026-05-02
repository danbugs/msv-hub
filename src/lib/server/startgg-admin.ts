/**
 * StartGG Admin API — uses the internal production endpoint with session cookie auth.
 * Enables operations not available on the public API: adding/removing players from events.
 */

import { env } from '$env/dynamic/private';
import { gql, EVENT_PHASES_QUERY, fetchPhaseGroups, getUserByDiscriminator } from './startgg';
import type { TOConfig } from './store';

const PROD_GQL = 'https://www.start.gg/api/-/gql';
const LOGIN_URL = 'https://www.start.gg/api/-/rest/user/login';
const PHASE_REST_URL = 'https://www.start.gg/api/-/rest/phase';

let cachedSession: { cookie: string; expiresAt: number } | null = null;
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

/** Invalidate the cached session (call on 403 to trigger re-login). */
function invalidateSession() {
	cachedSession = null;
}

/** Fetch with session cookie, auto-retry on 403 (expired session). */
async function adminFetch(url: string, options: RequestInit = {}): Promise<Response> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const cookie = await getSessionCookie();
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Cookie': cookie,
			'Client-Version': '20',
			...(options.headers as Record<string, string> ?? {})
		};
		// Remove headers set to empty string (opt-out)
		for (const [k, v] of Object.entries(headers)) {
			if (v === '') delete headers[k];
		}
		const res = await fetch(url, {
			...options,
			headers
		});
		if (res.status === 403 && attempt === 0) {
			console.log(`[startgg-admin] 403 on ${url.split('?')[0]} — re-logging in...`);
			invalidateSession();
			continue;
		}
		return res;
	}
	// Shouldn't reach here, but just in case
	throw new Error('adminFetch exhausted retries');
}

/** Login to StartGG and get a session cookie. Cached for 1 hour. */
async function getSessionCookie(): Promise<string> {
	if (cachedSession && Date.now() < cachedSession.expiresAt) {
		return cachedSession.cookie;
	}

	const email = env.STARTGG_EMAIL;
	const password = env.STARTGG_PASSWORD;
	if (!email || !password) throw new Error('STARTGG_EMAIL and STARTGG_PASSWORD must be set');

	const res = await fetch(LOGIN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Client-Version': '20' },
		body: JSON.stringify({
			email,
			password,
			rememberMe: true,
			validationKey: 'LOGIN_userlogin',
			expand: []
		})
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`StartGG login failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
	}

	const raw = res.headers.get('set-cookie') ?? '';
	const cookie = raw.match(/(gg_session=[^;]+)/)?.[1];
	if (!cookie) throw new Error('StartGG login succeeded but no gg_session cookie returned');

	cachedSession = { cookie, expiresAt: Date.now() + SESSION_TTL };
	return cookie;
}

const UPDATE_PARTICIPANT_REG = `
mutation UpdateParticipantRegistration($participantId: ID!, $regData: [UpdateParticipantRegData], $entrantData: UpdateParticipantEntrantData) {
  updateParticipantRegistration(participantId: $participantId, regData: $regData, entrantData: $entrantData) {
    id
    events { id name }
  }
}`;

/** Call the production GQL endpoint with session cookie. Retries once on 403 (expired session). */
async function adminGql<T = Record<string, unknown>>(
	query: string,
	variables: Record<string, unknown>
): Promise<T | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const cookie = await getSessionCookie();
		const res = await fetch(PROD_GQL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Cookie': cookie,
				'Client-Version': '20',
				'X-web-source': 'gg-web-gql-client',
				'Accept': '*/*'
			},
			body: JSON.stringify({ query, variables })
		});

		if (res.status === 403 && attempt === 0) {
			console.log('[startgg-admin] 403 — session expired, re-logging in...');
			invalidateSession();
			continue;
		}

		if (!res.ok) {
			console.error(`[startgg-admin] HTTP ${res.status}`);
			return null;
		}

		const json = await res.json();
		if (json.errors?.length) {
			for (const err of json.errors) {
				console.error(`[startgg-admin] GQL error: ${err.message}`);
			}
			return null;
		}

		return json.data as T;
	}
	return null;
}

interface ParticipantInfo {
	participantId: number;
	gamerTag: string;
	currentEventIds: number[];
}

/**
 * Get all participants in a tournament with their current event registrations.
 */
export async function getTournamentParticipants(
	tournamentSlug: string
): Promise<ParticipantInfo[]> {
	// Use the public API for reads
	type TData = { tournament: { participants: { nodes: { id: number; gamerTag: string; events: { id: number }[] }[] } } };
	const data = await gql<TData>(
		`query($slug: String!) {
			tournament(slug: $slug) {
				participants(query: { page: 1, perPage: 100 }) {
					nodes { id gamerTag events { id } }
				}
			}
		}`,
		{ slug: tournamentSlug }
	);

	return (data?.tournament?.participants?.nodes ?? []).map((p) => ({
		participantId: p.id,
		gamerTag: p.gamerTag,
		currentEventIds: p.events.map((e) => e.id)
	}));
}

/**
 * Update a participant's event registrations.
 * Pass the FULL list of event IDs the participant should be registered for.
 */
export async function updateParticipantEvents(
	participantId: number,
	eventIds: number[],
	phaseDestinations?: { eventId: number; phaseId: number }[]
): Promise<{ ok: boolean; events?: { id: number; name: string }[]; error?: string }> {
	const phaseDest = (phaseDestinations ?? []).map((d) => ({
		eventId: d.eventId,
		phaseDestId: d.phaseId
	}));
	const phaseGroupDest = (phaseDestinations ?? []).map((d) => ({
		eventId: d.eventId,
		phaseGroupDestId: null
	}));

	type Result = { updateParticipantRegistration: { id: number; events: { id: number; name: string }[] } };
	const vars = {
		participantId,
		regData: [],
		entrantData: {
			eventIds,
			paidEventIds: eventIds,
			eventPartnerIds: [],
			phaseDest,
			phaseGroupDest
		},
		validationKey: 'updateParticipantEventReg'
	};

	for (let attempt = 0; attempt < 3; attempt++) {
		const data = await adminGql<Result>(UPDATE_PARTICIPANT_REG, vars);
		if (data?.updateParticipantRegistration) {
			return { ok: true, events: data.updateParticipantRegistration.events };
		}
		if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
	}

	return { ok: false, error: 'updateParticipantRegistration returned null after 3 attempts' };
}

/**
 * Assign players to main and redemption bracket events based on final standings.
 *
 * 1. Gets all tournament participants
 * 2. For each player in main standings → add main event, remove redemption event
 * 3. For each player in redemption standings → add redemption event, remove main event
 * 4. Players not in either bracket keep only Swiss registration
 *
 * Returns counts of successful assignments.
 */
export async function assignBracketSplit(
	tournamentSlug: string,
	swissEventId: number,
	mainEventId: number,
	redemptionEventId: number,
	mainPlayerTags: string[],
	redemptionPlayerTags: string[],
	log?: (msg: string) => void
): Promise<{ mainOk: number; redemptionOk: number; failed: number; errors: string[] }> {
	const _log = log ?? console.log;
	const errors: string[] = [];

	// Get phase IDs for bracket events
	_log('Fetching bracket phase IDs...');
	const [mainPhaseData, redPhaseData] = await Promise.all([
		gql<{ event: { phases: { id: number }[] } }>(EVENT_PHASES_QUERY, { eventId: mainEventId }),
		gql<{ event: { phases: { id: number }[] } }>(EVENT_PHASES_QUERY, { eventId: redemptionEventId })
	]);
	const mainPhaseId = mainPhaseData?.event?.phases?.[0]?.id;
	const redPhaseId = redPhaseData?.event?.phases?.[0]?.id;
	if (!mainPhaseId || !redPhaseId) {
		return { mainOk: 0, redemptionOk: 0, failed: 0, errors: ['Could not resolve bracket phase IDs'] };
	}
	_log(`Main phase: ${mainPhaseId}, Redemption phase: ${redPhaseId}`);

	// Get all participants
	_log('Fetching tournament participants...');
	const participants = await getTournamentParticipants(tournamentSlug);
	_log(`Found ${participants.length} participants`);

	const mainTagSet = new Set(mainPlayerTags.map((t) => t.toLowerCase()));
	const redTagSet = new Set(redemptionPlayerTags.map((t) => t.toLowerCase()));

	let mainOk = 0;
	let redemptionOk = 0;
	let failed = 0;

	for (const p of participants) {
		const tag = p.gamerTag.toLowerCase();
		let targetEventIds: number[];
		let phaseDests: { eventId: number; phaseId: number }[] = [];

		if (mainTagSet.has(tag)) {
			targetEventIds = [swissEventId, mainEventId];
			phaseDests = [{ eventId: mainEventId, phaseId: mainPhaseId }];
		} else if (redTagSet.has(tag)) {
			targetEventIds = [swissEventId, redemptionEventId];
			phaseDests = [{ eventId: redemptionEventId, phaseId: redPhaseId }];
		} else {
			// Not in bracket split — keep only Swiss
			targetEventIds = [swissEventId];
		}

		// Skip if already correct
		const currentSet = new Set(p.currentEventIds);
		const targetSet = new Set(targetEventIds);
		if (currentSet.size === targetSet.size && [...targetSet].every((id) => currentSet.has(id))) {
			if (mainTagSet.has(tag)) mainOk++;
			else if (redTagSet.has(tag)) redemptionOk++;
			continue;
		}

		const result = await updateParticipantEvents(p.participantId, targetEventIds, phaseDests);
		if (result.ok) {
			if (mainTagSet.has(tag)) {
				mainOk++;
				_log(`  ✓ ${p.gamerTag} → Main`);
			} else if (redTagSet.has(tag)) {
				redemptionOk++;
				_log(`  ✓ ${p.gamerTag} → Redemption`);
			} else {
				_log(`  ✓ ${p.gamerTag} → Swiss only`);
			}
		} else {
			failed++;
			const msg = `Failed to update ${p.gamerTag}: ${result.error}`;
			errors.push(msg);
			_log(`  ✗ ${msg}`);
		}
	}

	_log(`Done: ${mainOk} main, ${redemptionOk} redemption, ${failed} failed`);
	return { mainOk, redemptionOk, failed, errors };
}

/**
 * Fetch real set IDs from the admin REST endpoint — available instantly after conversion.
 * Returns sets with real integer IDs even during the GQL API's conversion window.
 */
export async function fetchAdminPhaseGroupSets(
	phaseGroupId: number
): Promise<{ id: number; entrant1Id: number; entrant2Id: number; winnerId: number | null }[]> {
	const cookie = await getSessionCookie();
	const res = await fetch(
		`${PHASE_REST_URL.replace('/phase', '/admin/phase_group')}/${phaseGroupId}?id=${phaseGroupId}&admin=true&expand=%5B%22sets%22%5D&reset=false`,
		{ headers: { 'Cookie': cookie, 'Client-Version': '20' } }
	);
	if (!res.ok) return [];
	const data = await res.json();
	const sets = data?.entities?.sets;
	if (!Array.isArray(sets)) return [];
	return sets
		.map((s: Record<string, unknown>) => ({
			id: Number(s.id),
			entrant1Id: Number(s.entrant1Id),
			entrant2Id: Number(s.entrant2Id),
			winnerId: s.winnerId ? Number(s.winnerId) : null
		}))
		// Filter out sets with NaN/invalid IDs — happens when phase is still populating
		.filter((s) => !isNaN(s.id) && s.id > 0 && !isNaN(s.entrant1Id) && !isNaN(s.entrant2Id));
}

/**
 * Raw set data from admin REST — includes preview sets with "preview_..." IDs.
 * Used for internal-REST reporting which works with either preview or real IDs.
 */
export async function fetchAdminPhaseGroupSetsRaw(
	phaseGroupId: number
): Promise<Array<Record<string, unknown>>> {
	const cookie = await getSessionCookie();
	const res = await fetch(
		`${PHASE_REST_URL.replace('/phase', '/admin/phase_group')}/${phaseGroupId}?id=${phaseGroupId}&admin=true&expand=%5B%22sets%22%5D&reset=false`,
		{ headers: { 'Cookie': cookie, 'Client-Version': '20' } }
	);
	if (!res.ok) return [];
	const data = await res.json();
	const sets = data?.entities?.sets;
	return Array.isArray(sets) ? sets : [];
}

/**
 * Report a set via StartGG's INTERNAL REST API with robust concurrent-report handling.
 * VALIDATED via scripts/test-internal-rest.mjs — 12/12 concurrent reports succeed.
 *
 * Handles the three failure modes we've observed under concurrency:
 *  1. "Match data out of date" (preview ID invalidated mid-flight by another report's conversion)
 *     → re-fetch sets, find new ID for the same entrant pair, retry
 *  2. HTTP 500 "An unknown error has occurred" (StartGG serializes writes per phase group,
 *     rejects concurrent ones) → jittered backoff + retry
 *  3. Set already reported (discovered via re-fetch) → treat as success
 */
export async function completeSetViaAdminRest(
	phaseGroupId: number,
	entrant1Id: number,
	entrant2Id: number,
	winnerEntrantId: number,
	winnerScore: number,
	loserScore: number,
	isDQ: boolean
): Promise<{ ok: boolean; realSetId?: string; error?: string }> {
	const e1 = Number(entrant1Id), e2 = Number(entrant2Id);

	// Find the matching set in the phase group
	async function findSet() {
		const sets = await fetchAdminPhaseGroupSetsRaw(phaseGroupId).catch(() => []);
		return sets.find((s) =>
			(Number(s.entrant1Id) === e1 && Number(s.entrant2Id) === e2) ||
			(Number(s.entrant1Id) === e2 && Number(s.entrant2Id) === e1)
		);
	}

	let set = await findSet();
	// Retry: sets may be temporarily missing during preview→real conversion
	if (!set) {
		for (let r = 0; r < 3; r++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 2000));
			set = await findSet();
			if (set) break;
		}
	}
	if (!set) return { ok: false, error: `Set not found for entrants ${e1} vs ${e2} in phase group ${phaseGroupId}` };

	// If already reported, reset first (misreport fix)
	if (set.winnerId) {
		const { resetSet } = await import('./startgg');
		await resetSet(String(set.id)).catch(() => {});
	}

	let lastErr = '';
	for (let attempt = 0; attempt < 6; attempt++) {
		if (attempt > 0) {
			// Jittered backoff: 200ms, 500ms, 1s, 2s, 3s
			const base = [200, 500, 1000, 2000, 3000][attempt - 1] ?? 3000;
			await new Promise<void>((r) => setTimeout(r, base + Math.random() * base * 0.3));
		}

		// Build payload. Scores in entrant1/entrant2 order.
		const setWinnerIsE1 = Number(set.entrant1Id) === winnerEntrantId;
		let e1Score: number, e2Score: number;
		if (isDQ) {
			// Loser gets -1 (DQ marker), winner gets 0
			e1Score = setWinnerIsE1 ? 0 : -1;
			e2Score = setWinnerIsE1 ? -1 : 0;
		} else {
			e1Score = setWinnerIsE1 ? winnerScore : loserScore;
			e2Score = setWinnerIsE1 ? loserScore : winnerScore;
		}

		const setId = String(set.id);
		const isPreview = setId.startsWith('preview_');
		const payload: Record<string, unknown> = {
			...set,
			entrant1: Number(set.entrant1Id),
			entrant2: Number(set.entrant2Id),
			entrant1Score: e1Score,
			entrant2Score: e2Score,
			winnerId: null, // server infers from scores
			isLast: false,
			games: []
		};
		if (isPreview) {
			payload.mutations = { ffaData: { [setId]: { isFFA: false } } };
		}

		const res = await adminFetch(`https://www.start.gg/api/-/rest/set/${setId}/complete`, {
			method: 'PUT',
			body: JSON.stringify(payload)
		});

		if (res.ok) {
			const data = await res.json().catch(() => ({}));
			const realId = data?.id ?? data?.entities?.sets?.[0]?.id;
			return { ok: true, realSetId: realId ? String(realId) : setId };
		}

		const text = await res.text().catch(() => '');
		lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`;

		// "Match data out of date" → preview ID got invalidated; re-fetch
		if (res.status === 400 && text.includes('out of date')) {
			const fresh = await findSet();
			if (fresh?.winnerId) {
				// Another request already reported this set — treat as success
				return { ok: true, realSetId: String(fresh.id) };
			}
			if (fresh) { set = fresh; continue; }
		}
		// 500 = transient concurrent-write conflict — retry
		if (res.status === 500) continue;
		break;
	}

	return { ok: false, error: lastErr };
}

/**
 * Restart a phase on StartGG — resets all sets and un-starts the pool.
 * This replaces the manual "go to StartGG and reset the phase" step.
 */
export async function restartPhase(phaseId: number): Promise<{ ok: boolean; error?: string }> {
	const cookie = await getSessionCookie();
	const res = await fetch(`${PHASE_REST_URL}/${phaseId}/restart`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			'Cookie': cookie,
			'Client-Version': '20'
		},
		body: JSON.stringify({
			linkedStates: [{ entityKey: 'phase', id: phaseId, action: 'PHASE_UPDATE' }]
		})
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}
	return { ok: true };
}

/**
 * Add entrants to a Swiss phase (round) using the internal REST API.
 * This is needed because players are only added to Swiss Round 1 at registration —
 * subsequent rounds need to be populated manually (or via this API).
 */
export async function addEntrantsToPhase(
	eventId: number,
	destPhaseId: number,
	entrantIds: number[],
	/** Current number of seeds in the phase (needed for clearing). If not provided, fetched from API. */
	currentNumSeeds?: number,
	/** Bracket type ID: 4 = Swiss, 6 = Custom Schedule. Defaults to 4. */
	groupTypeId: number = 4
): Promise<{ ok: boolean; error?: string }> {
	const cookie = await getSessionCookie();
	const now = Math.floor(Date.now() / 1000);

	// When clearing (empty entrantIds), we need the actual current seed count
	let numSeeds = entrantIds.length;
	if (entrantIds.length === 0) {
		if (currentNumSeeds !== undefined) {
			numSeeds = currentNumSeeds;
		} else {
			// Fetch current seed count
			try {
				const seedData = await gql<{ phase: { seeds: { pageInfo: { total: number } } } }>(
					'query($id:ID!){phase(id:$id){seeds(query:{page:1,perPage:1}){pageInfo{total}}}}',
					{ id: destPhaseId }, { delay: 0 }
				);
				numSeeds = seedData?.phase?.seeds?.pageInfo?.total ?? 0;
			} catch { /* use 0 */ }
		}
		if (numSeeds === 0) return { ok: true }; // Already empty
	}

	const initialEntrants: Record<string, boolean> = {};
	for (const id of entrantIds) initialEntrants[String(id)] = true;

	const res = await fetch(`${PHASE_REST_URL}/${destPhaseId}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			'Cookie': cookie,
			'Client-Version': '20'
		},
		body: JSON.stringify({
			eventId,
			groupTypeId,
			isDefault: false,
			destPhaseLinks: [{
				phaseInputId: null,
				name: null,
				endSeed: null,
				phaseInputIdx: null,
				updatedAt: now,
				originPhaseId: null,
				startSeed: null,
				destPhaseId,
				seedMode: null,
				maintainMatchup: false,
				isDefault: false,
				originLosses: null,
				entrantIds,
				expand: [],
				type: 3,
				createdAt: now,
				destSeedOrder: 0,
				outputType: 1,
				numSeeds,
				destBracketSide: 1,
				originPlacement: null,
				initialEntrants
			}]
		})
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}

	return { ok: true };
}

/**
 * Open (or close) tournament registration by publishing each event's registration.
 * Must be done per-event (profileType 'event', featureId 3).
 */
export async function setRegistrationPublished(
	tournamentId: number,
	published: boolean
): Promise<{ ok: boolean; error?: string }> {
	const state = published ? 'PUBLISHED' : 'UNPUBLISHED';
	const mutation = `mutation($profileType: String!, $profileId: ID!, $featureId: ID!, $publishState: PublishState!) {
		updateProfilePublishing(profileType: $profileType, profileId: $profileId, featureId: $featureId, publishState: $publishState) {
			id publishState
		}
	}`;

	// Tournament-level registration toggle — controls isRegistrationOpen
	const tournamentPub = await adminGql(mutation, {
		profileType: 'tournament', profileId: tournamentId, featureId: 3, publishState: state
	});
	if (!tournamentPub) return { ok: false, error: 'Failed to publish registration at tournament level' };

	type EventsData = { tournament: { events: { id: number }[] } };
	const eventsData = await adminGql<EventsData>(
		`query($id: ID!) { tournament(id: $id) { events { id } } }`,
		{ id: tournamentId }
	);
	const events = eventsData?.tournament?.events ?? [];
	if (events.length === 0) return { ok: false, error: 'No events found' };

	for (const event of events) {
		const data = await adminGql(mutation, {
			profileType: 'event', profileId: event.id, featureId: 3, publishState: state
		});
		if (!data) return { ok: false, error: `Failed to publish registration for event ${event.id}` };
	}
	return { ok: true };
}

/**
 * Publish all events in a tournament (makes them visible on the tournament page).
 * Must be done per-event (profileType 'event', featureId 1).
 */
export async function publishEvents(
	tournamentId: number
): Promise<{ ok: boolean; error?: string }> {
	const mutation = `mutation($profileType: String!, $profileId: ID!, $featureId: ID!, $publishState: PublishState!) {
		updateProfilePublishing(profileType: $profileType, profileId: $profileId, featureId: $featureId, publishState: $publishState) {
			id publishState
		}
	}`;

	type EventsData = { tournament: { events: { id: number }[] } };
	const eventsData = await adminGql<EventsData>(
		`query($id: ID!) { tournament(id: $id) { events { id } } }`,
		{ id: tournamentId }
	);
	const events = eventsData?.tournament?.events ?? [];
	if (events.length === 0) return { ok: false, error: 'No events found' };

	for (const event of events) {
		const data = await adminGql(mutation, {
			profileType: 'event', profileId: event.id, featureId: 1, publishState: 'PUBLISHED'
		});
		if (!data) return { ok: false, error: `Failed to publish event ${event.id}` };
	}
	return { ok: true };
}

/** Proper CSV row parser that handles quoted fields containing commas and escaped quotes. */
function parseCSVRow(line: string): string[] {
	const result: string[] = [];
	let current = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"' && line[i + 1] === '"') {
				current += '"';
				i++; // skip escaped quote
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				current += ch;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
			} else if (ch === ',') {
				result.push(current.trim());
				current = '';
			} else {
				current += ch;
			}
		}
	}
	result.push(current.trim());
	return result;
}

/**
 * Export attendees CSV from StartGG. Returns parsed rows with key fields.
 */
export async function exportAttendees(
	tournamentId: number
): Promise<{ gamerTag: string; registeredAt: string; bringingSetup: string; discordId: string; events: string[] }[]> {
	const url = `https://www.start.gg/api-proxy/tournament/${tournamentId}/export_attendees`;
	console.log(`[startgg-admin] Exporting attendees for tournament ${tournamentId}...`);
	let res: Response;
	try {
		// Don't send Content-Type: application/json for CSV download
		res = await adminFetch(url, {
			method: 'GET',
			headers: { 'Accept': 'text/csv, */*', 'Content-Type': '' }
		});
	} catch (e) {
		console.error(`[startgg-admin] Export fetch error: ${e}`);
		return [];
	}
	console.log(`[startgg-admin] Export response: ${res.status} ${res.statusText}, content-type: ${res.headers.get('content-type')}`);
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		console.error(`[startgg-admin] Export failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
		return [];
	}
	const text = await res.text();
	console.log(`[startgg-admin] Export body length: ${text.length}, first 300 chars: ${text.slice(0, 300)}`);

	// Handle \r\n line endings
	const lines = text.split(/\r?\n/).filter(Boolean);
	console.log(`[startgg-admin] CSV lines: ${lines.length}, header: ${lines[0]?.slice(0, 200)}`);
	if (lines.length < 2) return [];

	// Parse CSV header — handle quoted headers with commas inside
	const header = parseCSVRow(lines[0]);
	console.log(`[startgg-admin] Parsed header columns (${header.length}): ${header.join(' | ')}`);
	const setupIdx = header.findIndex((h) => h.toLowerCase().includes('bring a setup'));
	const regDateIdx = header.indexOf('Registered At Date');
	const regTimeIdx = header.indexOf('Registered At Time');
	const tagIdx = header.indexOf('GamerTag');
	const discordIdx = header.indexOf('Discord ID');
	console.log(`[startgg-admin] Column indices — tag:${tagIdx} setup:${setupIdx} regDate:${regDateIdx} regTime:${regTimeIdx} discord:${discordIdx}`);

	const results: { gamerTag: string; registeredAt: string; bringingSetup: string; discordId: string; events: string[] }[] = [];

	for (let i = 1; i < lines.length; i++) {
		const row = parseCSVRow(lines[i]);
		const tag = tagIdx >= 0 ? row[tagIdx] ?? '' : '';
		const regDate = regDateIdx >= 0 ? row[regDateIdx] ?? '' : '';
		const regTime = regTimeIdx >= 0 ? row[regTimeIdx] ?? '' : '';
		const setup = setupIdx >= 0 ? row[setupIdx] ?? '' : '';
		const discord = discordIdx >= 0 ? row[discordIdx] ?? '' : '';
		if (tag) {
			results.push({
				gamerTag: tag,
				registeredAt: `${regDate} ${regTime}`.trim(),
				bringingSetup: setup,
				discordId: discord,
				events: []
			});
		}
	}

	return results;
}

/**
 * Finalize placements for a phase group (e.g., Final Standings).
 * Uses the internal REST endpoint to set exact placement order.
 */
export async function finalizePlacements(
	phaseGroupId: number,
	standings: { entrantId: number; placement: number }[]
): Promise<{ ok: boolean; error?: string }> {
	const cookie = await getSessionCookie();
	const res = await fetch(`https://www.start.gg/api/-/rest/phase_group/${phaseGroupId}/finalize`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Cookie': cookie,
			'Client-Version': '20'
		},
		body: JSON.stringify({
			validationKey: 'finalize-placements',
			standings
		})
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Automated event creation — clone, publish, register TOs, update slug
// ---------------------------------------------------------------------------

const CLONE_URL = 'https://www.start.gg/api/-/rest/tournament/cloneTournamentPublic';
const RECAPTCHA_SITE_KEY = '6Lfatx8rAAAAALaeXwBklgUKHTOjap_RCoueh7kd';
const RECAPTCHA_PAGE_URL = 'https://www.start.gg/tournament/create';

async function solveCaptcha(): Promise<string> {
	const apiKey = env.CAPTCHA_API_KEY;
	if (!apiKey) throw new Error('CAPTCHA_API_KEY not configured');

	for (let attempt = 0; attempt < 3; attempt++) {
		const submitRes = await fetch(
			`https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${RECAPTCHA_SITE_KEY}&pageurl=${encodeURIComponent(RECAPTCHA_PAGE_URL)}&json=1`
		);
		const submitData = await submitRes.json() as { status: number; request: string };
		if (submitData.status !== 1) throw new Error(`2captcha submit failed: ${submitData.request}`);

		const taskId = submitData.request;

		for (let i = 0; i < 24; i++) {
			await new Promise<void>((r) => setTimeout(r, 5000));
			const pollRes = await fetch(
				`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`
			);
			const pollData = await pollRes.json() as { status: number; request: string };
			if (pollData.status === 1) return pollData.request;
			if (pollData.request === 'ERROR_CAPTCHA_UNSOLVABLE') break;
			if (pollData.request !== 'CAPCHA_NOT_READY') {
				throw new Error(`2captcha solve failed: ${pollData.request}`);
			}
		}
	}
	throw new Error('2captcha failed after 3 attempts');
}

export interface CloneResult {
	ok: boolean;
	tournamentId?: number;
	tournamentSlug?: string;
	error?: string;
}

export async function cloneTournament(opts: {
	name: string;
	startAt: number;
	endAt: number;
	srcTournamentId: number;
	hubIds: string[];
	discordLink: string;
}): Promise<CloneResult> {
	const captchaToken = await solveCaptcha();

	const payload = {
		name: opts.name,
		primaryContactType: 'discord',
		primaryContact: opts.discordLink,
		startAt: opts.startAt,
		endAt: opts.endAt,
		hubIds: opts.hubIds,
		srcTournamentId: opts.srcTournamentId,
		cloningOptions: {
			details: true,
			permissions: true,
			events: true,
			registrationOptions: true,
			attendeeRequirements: true,
			payments: true,
			bracketSetup: true,
			schedule: true,
			stationsAndStreams: true,
			blockList: true
		},
		captcha: captchaToken,
		validationKey: 'create-new-tournament'
	};

	const res = await adminFetch(CLONE_URL, {
		method: 'POST',
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return { ok: false, error: `Clone failed HTTP ${res.status}: ${text.slice(0, 500)}` };
	}

	const data = await res.json().catch(() => null);
	if (!data) return { ok: false, error: 'Clone returned unparseable response' };

	const tournament = Array.isArray(data.entities?.tournament)
		? data.entities.tournament[0]
		: data.entities?.tournament ?? data;
	const id = tournament?.id;
	let slug = tournament?.slug ?? '';
	if (slug.startsWith('tournament/')) slug = slug.slice('tournament/'.length);
	if (!id) return { ok: false, error: 'Clone response missing tournament ID' };

	return { ok: true, tournamentId: Number(id), tournamentSlug: slug || undefined };
}

/**
 * Make a tournament's homepage public (visible via link).
 * featureId 1 = homepage visibility.
 */
export async function publishHomepage(
	tournamentId: number
): Promise<{ ok: boolean; error?: string }> {
	const data = await adminGql<{ updateProfilePublishing: { publishState: string } }>(
		`mutation UpdatePublishing($profileType: String!, $profileId: ID!, $featureId: ID!, $publishState: PublishState!) {
			updateProfilePublishing(profileType: $profileType, profileId: $profileId, featureId: $featureId, publishState: $publishState) {
				id publishState __typename
			}
		}`,
		{ profileType: 'tournament', profileId: tournamentId, featureId: 1, publishState: 'PUBLISHED' }
	);
	if (!data) return { ok: false, error: 'publishHomepage mutation failed' };
	return { ok: true };
}

/**
 * Make bracket and seeding public for all events in a tournament.
 * featureId 5 = bracket/seeding visibility.
 */
export async function publishBracketSeeding(
	tournamentId: number
): Promise<{ ok: boolean; error?: string }> {
	const data = await adminGql<{ bulkUpdateEventPublishing: { id: number }[] }>(
		`mutation UpdatePhasePublishing($tournamentId: ID!, $featureId: ID!, $publishState: PublishState!, $eventId: ID) {
			bulkUpdateEventPublishing(tournamentId: $tournamentId, featureId: $featureId, publishState: $publishState, eventId: $eventId) {
				id __typename
			}
		}`,
		{ tournamentId, featureId: 5, publishState: 'PUBLISHED' }
	);
	if (!data) return { ok: false, error: 'publishBracketSeeding mutation failed' };
	return { ok: true };
}

/**
 * Update tournament basic details — name, short slug, times, address, contact.
 */
export async function updateTournamentBasicDetails(
	tournamentId: number,
	fields: {
		name: string;
		shortSlug: string;
		startAt: number;
		endAt: number;
		discordLink: string;
	}
): Promise<{ ok: boolean; error?: string }> {
	const data = await adminGql(
		`mutation UpdateBasicDetailsTournament($tournamentId: ID!, $fields: UpdateBasicFieldsTournament!) {
			updateBasicFieldsTournament(tournamentId: $tournamentId, fields: $fields) {
				id name slug shortSlug __typename
			}
		}`,
		{
			tournamentId,
			fields: {
				name: fields.name,
				shortSlug: fields.shortSlug,
				startAt: fields.startAt,
				endAt: fields.endAt,
				address: {
					fullAddress: '725 Granville St Suite 700, Vancouver, BC V7Y 1G5, Canada',
					placeId: 'ChIJMwJi79BxhlQR0iVeqmzGrY8',
					city: 'Vancouver',
					state: 'BC',
					postalCode: 'V7Y 1G5',
					countryCode: 'CA',
					lat: 49.2820597,
					lng: -123.1196942
				},
				primaryContactType: 'discord',
				primaryContact: fields.discordLink
			},
			validationKey: 'updateTournament'
		}
	);
	if (!data) return { ok: false, error: 'updateTournamentBasicDetails mutation failed' };
	return { ok: true };
}

export interface TournamentRegistrationInfo {
	eventId: number;
	phaseId: number;
	passTypeId: number;
	registrationOptionValueIds: number[];
}

/**
 * Discover registration configuration for a tournament.
 *
 * Uses the internal GQL endpoint to query registrationOptions with their
 * value IDs. The "Venue Fee" option's value ID serves as the passTypeId.
 * Custom registration question value IDs are extracted by matching
 * known field patterns: "bring a setup" → first value (= "Yes"),
 * "past Wednesday" → second value (= "No"), "livestream" → checkbox value.
 */
export async function getTournamentRegistrationInfo(
	tournamentSlug: string
): Promise<TournamentRegistrationInfo | null> {
	// Get events and phases via public GQL
	type TData = {
		tournament: {
			id: number;
			events: { id: number; name: string; phases: { id: number }[] }[];
		};
	};
	const evData = await gql<TData>(
		`query($slug: String!) {
			tournament(slug: $slug) {
				id
				events { id name phases { id } }
			}
		}`,
		{ slug: tournamentSlug },
		{ delay: 0 }
	);

	if (!evData?.tournament?.events?.length) return null;

	const swissEvent = evData.tournament.events[0];
	const phaseId = swissEvent.phases?.[0]?.id;
	if (!phaseId) return null;

	const tournamentId = evData.tournament.id;

	// Get registration options via admin GQL
	type RegOpt = {
		id: number;
		name: string;
		optionType: string;
		fieldType: string;
		values: { id: number }[];
	};
	type RegData = {
		tournament: { registrationOptions: RegOpt[] };
	};
	const regData = await adminGql<RegData>(
		`query($id: ID!) {
			tournament(id: $id) {
				registrationOptions {
					id name optionType fieldType
					values { id }
				}
			}
		}`,
		{ id: tournamentId }
	);

	const opts = regData?.tournament?.registrationOptions ?? [];

	// passTypeId = value ID of the "Venue Fee" option (type=tournament)
	const venueFee = opts.find((o) => o.optionType === 'tournament');
	const passTypeId = venueFee?.values?.[0]?.id ?? 0;

	// Registration option value IDs for TO registration:
	//  1. "bring a setup" → first value (Yes)
	//  2. "past Wednesday" → second value (No)
	//  3. "livestream" → checkbox value (checked=true)
	const regOptionValueIds: number[] = [];

	const setupOpt = opts.find((o) => o.name?.toLowerCase().includes('bring a setup'));
	if (setupOpt?.values?.length) {
		regOptionValueIds.push(Number(setupOpt.values[0].id));
	}

	const wednesdayOpt = opts.find((o) => o.name?.toLowerCase().includes('past wednesday'));
	if (wednesdayOpt?.values?.length && wednesdayOpt.values.length >= 2) {
		regOptionValueIds.push(Number(wednesdayOpt.values[1].id));
	}

	const livestreamOpt = opts.find((o) => o.name?.toLowerCase().includes('livestream'));
	if (livestreamOpt?.values?.length) {
		regOptionValueIds.push(Number(livestreamOpt.values[0].id));
	}

	return {
		eventId: swissEvent.id,
		phaseId,
		passTypeId,
		registrationOptionValueIds: regOptionValueIds
	};
}

/**
 * Register a player (TO) for a tournament via the internal GQL endpoint.
 * Resolves the player ID from their discriminator if not already known.
 */
export async function registerTOForTournament(
	tournamentId: number,
	to: TOConfig,
	regInfo: TournamentRegistrationInfo
): Promise<{ ok: boolean; playerId?: number; error?: string }> {
	let playerId = to.playerId;
	let prefix = to.prefix;
	let gamerTag = to.name;

	if (!playerId) {
		const user = await getUserByDiscriminator(to.discriminator);
		if (!user) return { ok: false, error: `Could not find player for discriminator ${to.discriminator}` };
		playerId = user.playerId;
		gamerTag = user.gamerTag;
		prefix = user.prefix || to.prefix;
	}

	const registrationOptions: Record<string, unknown>[] = [];
	if (regInfo.registrationOptionValueIds.length >= 1) {
		registrationOptions.push({ paid: false, valueId: regInfo.registrationOptionValueIds[0] });
	}
	if (regInfo.registrationOptionValueIds.length >= 2) {
		registrationOptions.push({ paid: false, valueId: regInfo.registrationOptionValueIds[1] });
	}
	if (regInfo.registrationOptionValueIds.length >= 3) {
		registrationOptions.push({
			paid: false,
			valueId: regInfo.registrationOptionValueIds[2],
			selection: { checked: true }
		});
	}

	const variables = {
		tournamentId,
		fields: {
			passTypeId: regInfo.passTypeId,
			venueFeePaid: true,
			events: [{
				eventId: regInfo.eventId,
				paid: true,
				phaseId: regInfo.phaseId,
				phaseGroupId: -1
			}],
			player: { id: playerId, prefix, gamerTag },
			registrationOptions
		}
	};

	const data = await adminGql<{ registerPlayer: { id: number } | null }>(
		`mutation RegisterPlayer($tournamentId: ID!, $fields: RegisterPlayerData!) {
			registerPlayer(tournamentId: $tournamentId, fields: $fields) {
				id __typename
			}
		}`,
		variables
	);

	if (data === null) {
		return { ok: false, error: 'RegisterPlayer mutation failed (GQL error)' };
	}

	return { ok: true, playerId };
}

/**
 * Remove (unregister) a participant from a tournament.
 */
export async function unregisterParticipant(
	_tournamentId: number,
	participantId: number
): Promise<{ ok: boolean; error?: string }> {
	const data = await adminGql<{ deleteParticipant: unknown[] }>(
		`mutation($participantId: ID!) { deleteParticipant(participantId: $participantId) }`,
		{ participantId }
	);
	if (data === null) return { ok: false, error: 'deleteParticipant mutation failed' };
	return { ok: true };
}
