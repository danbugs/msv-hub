/**
 * StartGG API Compatibility Tests
 *
 * Verifies that StartGG's production and internal APIs still match the
 * contracts MSV Hub depends on. Runs daily via GitHub Actions cron to
 * catch breaking changes before they hit tournament day.
 *
 * Uses the permanent test tournament: "Microspacing Vancouver Test"
 *   - Tournament ID: 895482
 *   - Swiss event ID: 1590949 (32 entrants)
 *   - Main Bracket event ID: 1590950
 *   - Redemption Bracket event ID: 1590951
 *   - Swiss Round 1 phase: 2243224, PG: 3251998
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const envPath = path.resolve(import.meta.dirname ?? '.', '../../..', '.env');
let hasEnv = false;
try { hasEnv = fs.existsSync(envPath); } catch { /* */ }
const suite = hasEnv ? describe : describe.skip;

// ── Constants ────────────────────────────────────────────────────────────────

const PUBLIC_GQL = 'https://api.start.gg/gql/alpha';
const ADMIN_GQL = 'https://www.start.gg/api/-/gql';
const LOGIN_URL = 'https://www.start.gg/api/-/rest/user/login';
const ADMIN_REST = 'https://www.start.gg/api/-/rest';

const TEST_TOURNAMENT_SLUG = 'microspacing-vancouver-test';
const TEST_TOURNAMENT_ID = 895482;
const TEST_SWISS_EVENT_ID = 1590949;
const TEST_MAIN_EVENT_ID = 1590950;
const TEST_PHASE_GROUP_ID = 3251998;
const TEST_PHASE_ID = 2243224;

const TIMEOUT = 20_000;

// ── Env ──────────────────────────────────────────────────────────────────────

let TOKEN: string;
let EMAIL: string;
let PASSWORD: string;

if (hasEnv) {
	const content = fs.readFileSync(envPath, 'utf-8');
	const vars: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 1) continue;
		vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
	}
	TOKEN = vars.STARTGG_TOKEN ?? process.env.STARTGG_TOKEN ?? '';
	EMAIL = vars.STARTGG_EMAIL ?? process.env.STARTGG_EMAIL ?? '';
	PASSWORD = vars.STARTGG_PASSWORD ?? process.env.STARTGG_PASSWORD ?? '';
} else {
	TOKEN = process.env.STARTGG_TOKEN ?? '';
	EMAIL = process.env.STARTGG_EMAIL ?? '';
	PASSWORD = process.env.STARTGG_PASSWORD ?? '';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function publicGql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(PUBLIC_GQL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
		body: JSON.stringify({ query, variables })
	});
	expect(res.ok, `Public GQL HTTP ${res.status}`).toBe(true);
	const json = await res.json();
	expect(json.errors, `GQL errors: ${JSON.stringify(json.errors)}`).toBeFalsy();
	return json.data as T;
}

async function login(): Promise<string> {
	const res = await fetch(LOGIN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Client-Version': '20' },
		body: JSON.stringify({ email: EMAIL, password: PASSWORD, rememberMe: true, validationKey: 'LOGIN_userlogin', expand: [] })
	});
	expect(res.ok, `Login HTTP ${res.status}`).toBe(true);
	const raw = res.headers.get('set-cookie') ?? '';
	const cookie = raw.match(/(gg_session=[^;]+)/)?.[1];
	expect(cookie, 'Login must return gg_session cookie').toBeTruthy();
	return cookie!;
}

async function adminGqlCall<T = unknown>(cookie: string, query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(ADMIN_GQL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Cookie': cookie,
			'Client-Version': '20',
			'X-web-source': 'gg-web-gql-client'
		},
		body: JSON.stringify({ query, variables })
	});
	expect(res.ok, `Admin GQL HTTP ${res.status}`).toBe(true);
	const json = await res.json();
	expect(json.errors, `Admin GQL errors: ${JSON.stringify(json.errors)}`).toBeFalsy();
	return json.data as T;
}

// ── Shared state ─────────────────────────────────────────────────────────────

let sessionCookie = '';

// =============================================================================
// 1. PUBLIC GQL — Response shapes
// =============================================================================

suite('Compat: Public GQL response shapes', () => {
	it('tournament query returns events with id, name, numEntrants', async () => {
		const data = await publicGql<{
			tournament: { id: number; name: string; events: { id: number; name: string; numEntrants: number }[] }
		}>(
			`query($slug: String!) { tournament(slug: $slug) { id name events(filter: { videogameId: [1386] }) { id name numEntrants } } }`,
			{ slug: TEST_TOURNAMENT_SLUG }
		);
		expect(data.tournament).toBeTruthy();
		expect(data.tournament.id).toBe(TEST_TOURNAMENT_ID);
		expect(data.tournament.events.length).toBeGreaterThanOrEqual(3);
		const swiss = data.tournament.events.find(e => e.id === TEST_SWISS_EVENT_ID);
		expect(swiss, 'Swiss event must exist').toBeTruthy();
		expect(swiss!.numEntrants).toBeGreaterThanOrEqual(1);
	}, TIMEOUT);

	it('event phases query returns phases with id, name, numSeeds', async () => {
		const data = await publicGql<{
			event: { phases: { id: number; name: string; numSeeds: number }[] }
		}>(
			`query($eventId: ID!) { event(id: $eventId) { phases { id name numSeeds } } }`,
			{ eventId: TEST_SWISS_EVENT_ID }
		);
		expect(data.event.phases.length).toBeGreaterThanOrEqual(5);
		const r1 = data.event.phases.find(p => p.id === TEST_PHASE_ID);
		expect(r1, 'Round 1 phase must exist').toBeTruthy();
		expect(r1!.numSeeds).toBeGreaterThanOrEqual(1);
	}, TIMEOUT);

	it('phase seeds query returns seeds with seedNum and entrant.id', async () => {
		const data = await publicGql<{
			phase: { seeds: { nodes: { seedNum: number; entrant: { id: number } }[] } }
		}>(
			`query($phaseId: ID!) { phase(id: $phaseId) { seeds(query: { page: 1, perPage: 10 }) { nodes { seedNum entrant { id } } } } }`,
			{ phaseId: TEST_PHASE_ID }
		);
		expect(data.phase.seeds.nodes.length).toBeGreaterThan(0);
		const seed = data.phase.seeds.nodes[0];
		expect(typeof seed.seedNum).toBe('number');
		expect(typeof seed.entrant.id).toBe('number');
	}, TIMEOUT);

	it('phase group sets query returns sets with slots.entrant.id', async () => {
		const data = await publicGql<{
			phaseGroup: { sets: { nodes: { id: unknown; slots: { entrant: { id: number } | null }[] }[] } }
		}>(
			`query($pgId: ID!) { phaseGroup(id: $pgId) { sets(page: 1, perPage: 10) { nodes { id slots { entrant { id } } } } } }`,
			{ pgId: TEST_PHASE_GROUP_ID }
		);
		expect(data.phaseGroup.sets.nodes.length).toBeGreaterThan(0);
		const set = data.phaseGroup.sets.nodes[0];
		expect(set.slots.length).toBe(2);
	}, TIMEOUT);

	it('event entrants query returns entrant with participant.gamerTag', async () => {
		const data = await publicGql<{
			event: { entrants: { nodes: { id: number; participants: { gamerTag: string }[] }[] } }
		}>(
			`query($eventId: ID!) { event(id: $eventId) { entrants(query: { page: 1, perPage: 5 }) { nodes { id participants { gamerTag } } } } }`,
			{ eventId: TEST_SWISS_EVENT_ID }
		);
		expect(data.event.entrants.nodes.length).toBeGreaterThan(0);
		expect(typeof data.event.entrants.nodes[0].participants[0].gamerTag).toBe('string');
	}, TIMEOUT);

	it('tournament participants query returns events list', async () => {
		const data = await publicGql<{
			tournament: { participants: { nodes: { id: number; gamerTag: string; events: { id: number }[] }[] } }
		}>(
			`query($slug: String!) { tournament(slug: $slug) { participants(query: { page: 1, perPage: 5 }) { nodes { id gamerTag events { id } } } } }`,
			{ slug: TEST_TOURNAMENT_SLUG }
		);
		expect(data.tournament.participants.nodes.length).toBeGreaterThan(0);
		const p = data.tournament.participants.nodes[0];
		expect(typeof p.id).toBe('number');
		expect(typeof p.gamerTag).toBe('string');
		expect(Array.isArray(p.events)).toBe(true);
	}, TIMEOUT);
});

// =============================================================================
// 2. SESSION AUTH
// =============================================================================

suite('Compat: Session authentication', () => {
	it('login returns a gg_session cookie', async () => {
		sessionCookie = await login();
		expect(sessionCookie).toMatch(/^gg_session=.+/);
	}, TIMEOUT);

	it('admin GQL accepts session cookie and returns data', async () => {
		if (!sessionCookie) sessionCookie = await login();
		const data = await adminGqlCall<{ tournament: { id: number; name: string } }>(
			sessionCookie,
			`query($id: ID!) { tournament(id: $id) { id name } }`,
			{ id: TEST_TOURNAMENT_ID }
		);
		expect(data.tournament.id).toBe(TEST_TOURNAMENT_ID);
	}, TIMEOUT);
});

// =============================================================================
// 3. ADMIN REST — Endpoint existence and response shapes
// =============================================================================

suite('Compat: Admin REST endpoints', () => {
	beforeAll(async () => {
		if (!sessionCookie) sessionCookie = await login();
	});

	it('GET /admin/phase_group/{id} returns sets array', async () => {
		const url = `${ADMIN_REST}/admin/phase_group/${TEST_PHASE_GROUP_ID}?id=${TEST_PHASE_GROUP_ID}&admin=true&expand=%5B%22sets%22%5D&reset=false`;
		const res = await fetch(url, {
			headers: { 'Cookie': sessionCookie, 'Client-Version': '20' }
		});
		expect(res.ok, `GET admin PG HTTP ${res.status}`).toBe(true);
		const data = await res.json();
		expect(data.entities).toBeTruthy();
		expect(Array.isArray(data.entities.sets)).toBe(true);
		if (data.entities.sets.length > 0) {
			const set = data.entities.sets[0];
			expect('id' in set).toBe(true);
			expect('entrant1Id' in set).toBe(true);
			expect('entrant2Id' in set).toBe(true);
		}
	}, TIMEOUT);

	it('PUT /phase/{id}/restart returns 200 with phase entity', async () => {
		const res = await fetch(`${ADMIN_REST}/phase/${TEST_PHASE_ID}/restart`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie, 'Client-Version': '20' },
			body: JSON.stringify({
				linkedStates: [{ entityKey: 'phase', id: TEST_PHASE_ID, action: 'PHASE_UPDATE' }]
			})
		});
		expect(res.ok, `PUT restart HTTP ${res.status}`).toBe(true);
		const data = await res.json();
		expect(data.entities?.phase).toBeTruthy();
		expect(data.entities.phase.id).toBe(TEST_PHASE_ID);
		expect(typeof data.entities.phase.state).toBe('number');
	}, TIMEOUT);

	it('GET /api-proxy/tournament/{id}/export_attendees returns CSV', async () => {
		const url = `https://www.start.gg/api-proxy/tournament/${TEST_TOURNAMENT_ID}/export_attendees`;
		const res = await fetch(url, {
			headers: { 'Cookie': sessionCookie, 'Accept': 'text/csv, */*' }
		});
		expect(res.ok, `GET export HTTP ${res.status}`).toBe(true);
		const text = await res.text();
		expect(text.length).toBeGreaterThan(0);
		expect(text).toContain('GamerTag');
	}, TIMEOUT);
});

// =============================================================================
// 4. ADMIN GQL — Mutation shapes
// =============================================================================

suite('Compat: Admin GQL mutations', () => {
	beforeAll(async () => {
		if (!sessionCookie) sessionCookie = await login();
	});

	it('updateProfilePublishing toggles registration (open then close)', async () => {
		const mutation = `mutation($profileType: String!, $profileId: ID!, $featureId: ID!, $publishState: PublishState!) {
			updateProfilePublishing(profileType: $profileType, profileId: $profileId, featureId: $featureId, publishState: $publishState) {
				id publishState
			}
		}`;

		// Open registration at tournament level
		const openData = await adminGqlCall<{ updateProfilePublishing: { id: number; publishState: string } }>(
			sessionCookie, mutation,
			{ profileType: 'tournament', profileId: TEST_TOURNAMENT_ID, featureId: 3, publishState: 'PUBLISHED' }
		);
		expect(openData.updateProfilePublishing).toBeTruthy();
		expect(openData.updateProfilePublishing.publishState).toBe('PUBLISHED');

		// Close it back
		const closeData = await adminGqlCall<{ updateProfilePublishing: { id: number; publishState: string } }>(
			sessionCookie, mutation,
			{ profileType: 'tournament', profileId: TEST_TOURNAMENT_ID, featureId: 3, publishState: 'UNPUBLISHED' }
		);
		expect(closeData.updateProfilePublishing.publishState).toBe('UNPUBLISHED');
	}, TIMEOUT);

	it('updateProfilePublishing works for event-level registration', async () => {
		const mutation = `mutation($profileType: String!, $profileId: ID!, $featureId: ID!, $publishState: PublishState!) {
			updateProfilePublishing(profileType: $profileType, profileId: $profileId, featureId: $featureId, publishState: $publishState) {
				id publishState
			}
		}`;

		// Open event registration
		const openData = await adminGqlCall<{ updateProfilePublishing: { id: number; publishState: string } }>(
			sessionCookie, mutation,
			{ profileType: 'event', profileId: TEST_SWISS_EVENT_ID, featureId: 3, publishState: 'PUBLISHED' }
		);
		expect(openData.updateProfilePublishing).toBeTruthy();

		// Close it back
		await adminGqlCall(sessionCookie, mutation,
			{ profileType: 'event', profileId: TEST_SWISS_EVENT_ID, featureId: 3, publishState: 'UNPUBLISHED' }
		);
	}, TIMEOUT);

	it('tournament registration options query returns registrationOptions', async () => {
		const data = await adminGqlCall<{
			tournament: { registrationOptions: { id: number; name: string; optionType: string }[] }
		}>(
			sessionCookie,
			`query($id: ID!) { tournament(id: $id) { registrationOptions { id name optionType fieldType values { id } } } }`,
			{ id: TEST_TOURNAMENT_ID }
		);
		expect(data.tournament).toBeTruthy();
		expect(Array.isArray(data.tournament.registrationOptions)).toBe(true);
	}, TIMEOUT);

	it('bulkUpdateEventPublishing accepts tournamentId + featureId + publishState', async () => {
		const data = await adminGqlCall<{ bulkUpdateEventPublishing: { id: number }[] }>(
			sessionCookie,
			`mutation($tournamentId: ID!, $featureId: ID!, $publishState: PublishState!, $eventId: ID) {
				bulkUpdateEventPublishing(tournamentId: $tournamentId, featureId: $featureId, publishState: $publishState, eventId: $eventId) { id }
			}`,
			{ tournamentId: TEST_TOURNAMENT_ID, featureId: 5, publishState: 'PUBLISHED' }
		);
		expect(data).toBeTruthy();
	}, TIMEOUT);
});

// =============================================================================
// 5. PUBLIC GQL — Mutation shapes (report + reset cycle)
// =============================================================================

suite('Compat: Public GQL mutations (reportBracketSet + resetSet)', () => {
	let testSetId: string | null = null;
	let testWinnerId: number | null = null;

	it('finds an unreported set in the test phase group', async () => {
		const data = await publicGql<{
			phaseGroup: { sets: { nodes: { id: unknown; winnerId: unknown; slots: { entrant: { id: number } | null }[] }[] } }
		}>(
			`query($pgId: ID!) { phaseGroup(id: $pgId) { sets(page: 1, perPage: 64) { nodes { id winnerId slots { entrant { id } } } } } }`,
			{ pgId: TEST_PHASE_GROUP_ID }
		);
		const unreported = data.phaseGroup.sets.nodes.find(
			s => !s.winnerId && s.slots.length === 2 && s.slots[0]?.entrant?.id && s.slots[1]?.entrant?.id
		);
		if (unreported) {
			testSetId = String(unreported.id);
			testWinnerId = unreported.slots[0]!.entrant!.id;
		}
	}, TIMEOUT);

	it('reportBracketSet mutation accepts setId + winnerId and returns set.id', async () => {
		if (!testSetId || !testWinnerId) {
			console.log('No unreported set found — restarting phase to create one');
			if (!sessionCookie) sessionCookie = await login();
			await fetch(`${ADMIN_REST}/phase/${TEST_PHASE_ID}/restart`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie, 'Client-Version': '20' },
				body: JSON.stringify({ linkedStates: [{ entityKey: 'phase', id: TEST_PHASE_ID, action: 'PHASE_UPDATE' }] })
			});
			await new Promise(r => setTimeout(r, 2000));

			const data = await publicGql<{
				phaseGroup: { sets: { nodes: { id: unknown; winnerId: unknown; slots: { entrant: { id: number } | null }[] }[] } }
			}>(
				`query($pgId: ID!) { phaseGroup(id: $pgId) { sets(page: 1, perPage: 64) { nodes { id winnerId slots { entrant { id } } } } } }`,
				{ pgId: TEST_PHASE_GROUP_ID }
			);
			const unreported = data.phaseGroup.sets.nodes.find(
				s => !s.winnerId && s.slots.length === 2 && s.slots[0]?.entrant?.id && s.slots[1]?.entrant?.id
			);
			if (!unreported) return; // phase may have preview IDs, skip gracefully
			testSetId = String(unreported.id);
			testWinnerId = unreported.slots[0]!.entrant!.id;
		}

		if (String(testSetId).startsWith('preview_')) {
			console.log('Set has preview ID — skipping report mutation test (preview IDs need admin REST)');
			return;
		}

		const res = await fetch(PUBLIC_GQL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
			body: JSON.stringify({
				query: `mutation ReportSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
					reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) { id state }
				}`,
				variables: { setId: testSetId, winnerId: testWinnerId, gameData: [] }
			})
		});
		expect(res.ok, `reportBracketSet HTTP ${res.status}`).toBe(true);
		const json = await res.json();
		if (json.errors?.length) {
			expect(json.errors[0].message).toMatch(/Cannot report|already|completed/i);
		} else {
			expect(json.data.reportBracketSet).toBeTruthy();
			expect(json.data.reportBracketSet.id).toBeTruthy();
		}
	}, TIMEOUT);

	it('resetSet mutation accepts setId', async () => {
		if (!testSetId || String(testSetId).startsWith('preview_')) return;

		const res = await fetch(PUBLIC_GQL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
			body: JSON.stringify({
				query: `mutation ResetSet($setId: ID!) { resetSet(setId: $setId) { id state } }`,
				variables: { setId: testSetId }
			})
		});
		expect(res.ok, `resetSet HTTP ${res.status}`).toBe(true);
		const json = await res.json();
		if (json.errors?.length) {
			expect(json.errors[0].message).toMatch(/Cannot reset|not reported|already/i);
		} else {
			expect(json.data.resetSet).toBeTruthy();
		}
	}, TIMEOUT);
});

// =============================================================================
// 6. ADMIN REST — Set completion shape
// =============================================================================

suite('Compat: Admin REST set completion', () => {
	beforeAll(async () => {
		if (!sessionCookie) sessionCookie = await login();
	});

	it('PUT /set/{id}/complete accepts entrant winner and returns 200', async () => {
		// Get a set from the admin endpoint — may have preview IDs after a phase restart
		const url = `${ADMIN_REST}/admin/phase_group/${TEST_PHASE_GROUP_ID}?id=${TEST_PHASE_GROUP_ID}&admin=true&expand=%5B%22sets%22%5D&reset=false`;
		const pgRes = await fetch(url, {
			headers: { 'Cookie': sessionCookie, 'Client-Version': '20' }
		});
		const pgData = await pgRes.json();
		const sets = pgData?.entities?.sets ?? [];
		const unreported = sets.find((s: Record<string, unknown>) =>
			!s.winnerId && s.entrant1Id && s.entrant2Id &&
			Number(s.entrant1Id) > 0 && Number(s.entrant2Id) > 0
		);
		if (!unreported) {
			console.log('No unreported set with valid entrant IDs — skipping');
			return;
		}

		const setId = unreported.id;
		const winnerId = unreported.entrant1Id;
		const loserId = unreported.entrant2Id;

		// Report — preview IDs may return 400 ("Match data out of date"), that's expected
		const reportRes = await fetch(`${ADMIN_REST}/set/${setId}/complete`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie, 'Client-Version': '20' },
			body: JSON.stringify({
				winnerId,
				isDQ: false,
				gameData: [
					{ winnerId, loserId, gameNum: 1 },
					{ winnerId, loserId, gameNum: 2 }
				]
			})
		});
		// 200 = success, 400 = preview ID / stale data (expected after restart)
		expect([200, 400].includes(reportRes.status), `PUT complete HTTP ${reportRes.status} — must be 200 or 400`).toBe(true);
		if (reportRes.ok) {
			const reportData = await reportRes.json();
			expect(reportData.entities).toBeTruthy();

			// Reset via public GQL to clean up
			await new Promise(r => setTimeout(r, 1000));
			await fetch(PUBLIC_GQL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
				body: JSON.stringify({
					query: `mutation($setId: ID!) { resetSet(setId: $setId) { id } }`,
					variables: { setId: String(setId) }
				})
			});
		}
	}, TIMEOUT * 2);
});

// =============================================================================
// 7. ADMIN REST — Phase entrant management shape
// =============================================================================

suite('Compat: Admin REST phase entrant management', () => {
	const TEST_ROUND2_PHASE = 2243225;

	beforeAll(async () => {
		if (!sessionCookie) sessionCookie = await login();
	});

	it('PUT /phase/{id} accepts entrant seeding payload', async () => {
		// Get current seed count
		const seedsData = await publicGql<{
			phase: { seeds: { nodes: { seedNum: number; entrant: { id: number } }[] } }
		}>(
			`query($phaseId: ID!) { phase(id: $phaseId) { seeds(query: { page: 1, perPage: 5 }) { nodes { seedNum entrant { id } } } } }`,
			{ phaseId: TEST_ROUND2_PHASE }
		);
		const currentSeeds = seedsData.phase.seeds.nodes.length;

		// Try adding entrants (empty array = clear, which is a valid operation)
		const now = Math.floor(Date.now() / 1000);
		const res = await fetch(`${ADMIN_REST}/phase/${TEST_ROUND2_PHASE}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie, 'Client-Version': '20' },
			body: JSON.stringify({
				entrantIds: [],
				groupTypeId: 4,
				numSeeds: currentSeeds || 0,
				phaseOrder: 2,
				updatedAt: now,
				linkedStates: [{ entityKey: 'phase', id: TEST_ROUND2_PHASE, action: 'PHASE_UPDATE' }]
			})
		});
		// Accept 200 or common error codes — the key check is that the endpoint exists
		expect([200, 400, 409].includes(res.status), `PUT phase HTTP ${res.status} — endpoint must exist`).toBe(true);
		if (res.ok) {
			const data = await res.json();
			expect(data.entities).toBeTruthy();
		}
	}, TIMEOUT);
});

// =============================================================================
// 8. ADMIN GQL — updateBasicFieldsTournament shape
// =============================================================================

suite('Compat: Admin GQL updateBasicFieldsTournament', () => {
	beforeAll(async () => {
		if (!sessionCookie) sessionCookie = await login();
	});

	it('mutation accepts tournamentId + fields and returns tournament', async () => {
		// Read current values first
		const current = await adminGqlCall<{ tournament: { name: string; startAt: number; endAt: number } }>(
			sessionCookie,
			`query($id: ID!) { tournament(id: $id) { name startAt endAt } }`,
			{ id: TEST_TOURNAMENT_ID }
		);

		// Update with same values (no-op but validates the mutation shape)
		const data = await adminGqlCall<{
			updateBasicFieldsTournament: { id: number; name: string }
		}>(
			sessionCookie,
			`mutation($tournamentId: ID!, $fields: UpdateBasicFieldsTournament!) {
				updateBasicFieldsTournament(tournamentId: $tournamentId, fields: $fields) { id name }
			}`,
			{
				tournamentId: TEST_TOURNAMENT_ID,
				fields: {
					name: current.tournament.name,
					startAt: current.tournament.startAt,
					endAt: current.tournament.endAt
				}
			}
		);
		expect(data.updateBasicFieldsTournament).toBeTruthy();
		expect(data.updateBasicFieldsTournament.id).toBe(TEST_TOURNAMENT_ID);
	}, TIMEOUT);
});

// =============================================================================
// 9. Public GQL — updatePhaseSeeding mutation shape
// =============================================================================

suite('Compat: Public GQL updatePhaseSeeding', () => {
	it('accepts phaseId and seedMapping array', async () => {
		// Get current seeds
		const seedsData = await publicGql<{
			phase: { seeds: { nodes: { seedNum: number; entrant: { id: number } }[] } }
		}>(
			`query($phaseId: ID!) { phase(id: $phaseId) { seeds(query: { page: 1, perPage: 64 }) { nodes { seedNum entrant { id } } } } }`,
			{ phaseId: TEST_PHASE_ID }
		);
		const seeds = seedsData.phase.seeds.nodes;
		if (seeds.length === 0) return;

		// Re-apply same seeding (no-op)
		const seedMapping = seeds.map(s => ({ seedId: s.entrant.id, seedNum: s.seedNum }));

		const res = await fetch(PUBLIC_GQL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
			body: JSON.stringify({
				query: `mutation($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
					updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) { id }
				}`,
				variables: { phaseId: TEST_PHASE_ID, seedMapping }
			})
		});
		expect(res.ok, `updatePhaseSeeding HTTP ${res.status}`).toBe(true);
		const json = await res.json();
		// May error with "Cannot modify seeds in started pools" — that's fine, it means the mutation exists
		if (json.errors?.length) {
			expect(json.errors[0].message).toBeDefined();
		} else {
			expect(json.data.updatePhaseSeeding).toBeTruthy();
		}
	}, TIMEOUT);
});

// =============================================================================
// 10. ADMIN REST — Clone tournament endpoint exists
// =============================================================================

suite('Compat: Admin REST clone endpoint', () => {
	beforeAll(async () => {
		if (!sessionCookie) sessionCookie = await login();
	});

	it('POST /tournament/cloneTournamentPublic rejects missing captcha (validates endpoint exists)', async () => {
		const res = await fetch('https://www.start.gg/api/-/rest/tournament/cloneTournamentPublic', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie, 'Client-Version': '20' },
			body: JSON.stringify({
				tournamentId: TEST_TOURNAMENT_ID,
				recaptcha: 'invalid-token'
			})
		});
		// We expect a 4xx (bad captcha) — NOT a 404. This proves the endpoint still exists.
		expect(res.status).not.toBe(404);
		expect(res.status).not.toBe(405);
	}, TIMEOUT);
});

// =============================================================================
// 11. ADMIN REST — Finalize placements endpoint exists
// =============================================================================

suite('Compat: Admin REST finalize placements', () => {
	const FINAL_STANDINGS_PG = 3252003; // Final Standings phase group

	beforeAll(async () => {
		if (!sessionCookie) sessionCookie = await login();
	});

	it('POST /phase_group/{id}/finalize accepts standings payload', async () => {
		const res = await fetch(`${ADMIN_REST}/phase_group/${FINAL_STANDINGS_PG}/finalize`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie, 'Client-Version': '20' },
			body: JSON.stringify({
				validationKey: 'finalize-placements',
				standings: []
			})
		});
		// Empty standings may 400 — that's fine, the endpoint exists
		expect(res.status).not.toBe(404);
		expect(res.status).not.toBe(405);
	}, TIMEOUT);
});
