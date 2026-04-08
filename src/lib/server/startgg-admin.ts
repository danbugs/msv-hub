/**
 * StartGG Admin API — uses the internal production endpoint with session cookie auth.
 * Enables operations not available on the public API: adding/removing players from events.
 */

import { env } from '$env/dynamic/private';
import { gql, EVENT_PHASES_QUERY, fetchPhaseGroups } from './startgg';

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
		const res = await fetch(url, {
			...options,
			headers: {
				'Content-Type': 'application/json',
				'Cookie': cookie,
				'Client-Version': '20',
				...(options.headers ?? {})
			}
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
	const data = await adminGql<Result>(UPDATE_PARTICIPANT_REG, {
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
	});

	if (!data?.updateParticipantRegistration) {
		return { ok: false, error: 'updateParticipantRegistration returned null' };
	}

	return { ok: true, events: data.updateParticipantRegistration.events };
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
	return sets.map((s: Record<string, unknown>) => ({
		id: Number(s.id),
		entrant1Id: Number(s.entrant1Id),
		entrant2Id: Number(s.entrant2Id),
		winnerId: s.winnerId ? Number(s.winnerId) : null
	}));
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
 * Open (or close) tournament registration by toggling the publish state.
 * featureId 3 = registration visibility.
 */
export async function setRegistrationPublished(
	tournamentId: number,
	published: boolean
): Promise<{ ok: boolean; error?: string }> {
	const data = await adminGql<{ updateProfilePublishing: { publishState: string } }>(
		`mutation UpdatePublishing($profileType: String!, $profileId: ID!, $featureId: ID!, $publishState: PublishState!) {
			updateProfilePublishing(profileType: $profileType, profileId: $profileId, featureId: $featureId, publishState: $publishState) {
				id publishState
			}
		}`,
		{
			profileType: 'tournament',
			profileId: tournamentId,
			featureId: 3,
			publishState: published ? 'PUBLISHED' : 'ADMIN_ONLY'
		}
	);
	if (!data) return { ok: false, error: 'UpdatePublishing mutation failed' };
	return { ok: true };
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
		res = await adminFetch(url, { method: 'GET' });
	} catch (e) {
		console.error(`[startgg-admin] Export fetch error: ${e}`);
		return [];
	}
	console.log(`[startgg-admin] Export response: ${res.status} ${res.statusText}`);
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		console.error(`[startgg-admin] Export failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
		return [];
	}
	const text = await res.text();
	const lines = text.split('\n').filter(Boolean);
	if (lines.length < 2) return [];

	// Parse CSV header
	const header = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
	const setupIdx = header.findIndex((h) => h.toLowerCase().includes('bring a setup'));
	const regDateIdx = header.indexOf('Registered At Date');
	const regTimeIdx = header.indexOf('Registered At Time');
	const tagIdx = header.indexOf('GamerTag');
	const discordIdx = header.indexOf('Discord ID');

	const results: { gamerTag: string; registeredAt: string; bringingSetup: string; discordId: string; events: string[] }[] = [];

	for (let i = 1; i < lines.length; i++) {
		// Simple CSV parse (handles quoted fields)
		const row = lines[i].match(/("([^"]*)"|[^,]*)/g)?.map((v) => v.replace(/^"|"$/g, '').trim()) ?? [];
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
				events: [] // Could parse event columns if needed
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
