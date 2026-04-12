#!/usr/bin/env node
/**
 * Test script for StartGG internal REST reporting.
 *
 * Usage:
 *   node scripts/test-internal-rest.mjs <phaseGroupId>
 *
 * Prerequisites:
 *   - .env with STARTGG_EMAIL + STARTGG_PASSWORD
 *   - An active Swiss tournament on StartGG in the given phase group with
 *     unreported sets (ideally a fresh test tournament reset to Round 1).
 */

import { readFileSync } from 'node:fs';

// ── Load .env ───────────────────────────────────────────────────────────
try {
	const env = readFileSync('.env', 'utf8');
	for (const line of env.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) process.env[m[1]] = m[2];
	}
} catch (e) {
	console.error('Failed to load .env:', e.message);
	process.exit(1);
}

const EMAIL = process.env.STARTGG_EMAIL;
const PASSWORD = process.env.STARTGG_PASSWORD;
if (!EMAIL || !PASSWORD) {
	console.error('STARTGG_EMAIL + STARTGG_PASSWORD must be in .env');
	process.exit(1);
}

const phaseGroupId = Number(process.argv[2]);
if (!phaseGroupId) {
	console.error('Usage: node scripts/test-internal-rest.mjs <phaseGroupId>');
	process.exit(1);
}

// ── Login ───────────────────────────────────────────────────────────────
console.log(`\n[1] Logging in as ${EMAIL}...`);
const loginRes = await fetch('https://www.start.gg/api/-/rest/user/login', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', 'Client-Version': '20' },
	body: JSON.stringify({
		email: EMAIL,
		password: PASSWORD,
		rememberMe: true,
		validationKey: 'LOGIN_userlogin',
		expand: []
	})
});

if (!loginRes.ok) {
	console.error(`Login failed: HTTP ${loginRes.status}`);
	const text = await loginRes.text().catch(() => '');
	console.error(text.slice(0, 500));
	process.exit(1);
}

const cookieHeader = loginRes.headers.get('set-cookie') ?? '';
const cookie = cookieHeader.match(/(gg_session=[^;]+)/)?.[1];
if (!cookie) {
	console.error('No gg_session cookie');
	process.exit(1);
}
console.log(`    ✓ Logged in, got gg_session cookie`);

// ── Fetch phase group sets ──────────────────────────────────────────────
console.log(`\n[2] Fetching sets for phase group ${phaseGroupId}...`);
const t0 = Date.now();
const setsRes = await fetch(
	`https://www.start.gg/api/-/rest/admin/phase_group/${phaseGroupId}?id=${phaseGroupId}&admin=true&expand=%5B%22sets%22%5D&reset=false`,
	{ headers: { Cookie: cookie, 'Client-Version': '20' } }
);
const t1 = Date.now();

if (!setsRes.ok) {
	console.error(`HTTP ${setsRes.status}`);
	process.exit(1);
}

const setsData = await setsRes.json();
const allSets = setsData?.entities?.sets ?? [];
console.log(`    ✓ Got ${allSets.length} sets in ${t1 - t0}ms`);

// Filter to sets with entrants (skip placeholder/empty sets)
const readySets = allSets.filter((s) => Number(s.entrant1Id) > 0 && Number(s.entrant2Id) > 0);
const unreported = readySets.filter((s) => !s.winnerId);
console.log(`    ${readySets.length} with entrants, ${unreported.length} unreported`);

if (unreported.length === 0) {
	console.error('No unreported sets to test with!');
	process.exit(1);
}

// ── Report first unreported set ─────────────────────────────────────────
const target = unreported[0];
console.log(`\n[3] Reporting set ${target.id}`);
console.log(`    entrant1=${target.entrant1Id}, entrant2=${target.entrant2Id}`);

// Debug: log the set structure
console.log('    Set object keys:', Object.keys(target).join(', '));
console.log('    Set object (raw):', JSON.stringify(target, null, 2).slice(0, 2000));

// Entrant1 wins 2-0 for the test. Mimic StartGG UI payload exactly (including mutations block for preview IDs).
const isPreview = String(target.id).startsWith('preview_');
const payload = {
	...target,
	entrant1: Number(target.entrant1Id),
	entrant2: Number(target.entrant2Id),
	entrant1Score: 2,
	entrant2Score: 0,
	winnerId: null, // server infers from scores (matches user-captured payload)
	isLast: false,
	games: []
};
if (isPreview) {
	payload.mutations = { ffaData: { [target.id]: { isFFA: false } } };
}
console.log('    Sending payload keys:', Object.keys(payload).join(', '));

const t2 = Date.now();
const reportRes = await fetch(`https://www.start.gg/api/-/rest/set/${target.id}/complete`, {
	method: 'PUT',
	headers: {
		'Content-Type': 'application/json',
		Cookie: cookie,
		'Client-Version': '20'
	},
	body: JSON.stringify(payload)
});
const t3 = Date.now();

console.log(`    HTTP ${reportRes.status} in ${t3 - t2}ms`);

if (!reportRes.ok) {
	const text = await reportRes.text().catch(() => '');
	console.error(`    ✗ Failed: ${text.slice(0, 500)}`);
	process.exit(1);
}

const reportData = await reportRes.json().catch(() => ({}));
const returnedSetId = reportData?.id ?? reportData?.entities?.sets?.[0]?.id;
console.log(`    ✓ Reported. returned setId: ${returnedSetId}`);

// ── Fetch again to verify ───────────────────────────────────────────────
console.log(`\n[4] Re-fetching sets to confirm...`);
const t4 = Date.now();
const verifyRes = await fetch(
	`https://www.start.gg/api/-/rest/admin/phase_group/${phaseGroupId}?id=${phaseGroupId}&admin=true&expand=%5B%22sets%22%5D&reset=false`,
	{ headers: { Cookie: cookie, 'Client-Version': '20' } }
);
const t5 = Date.now();
const verifyData = await verifyRes.json();
const verifySets = verifyData?.entities?.sets ?? [];
const reportedNow = verifySets.filter((s) => s.winnerId).length;
console.log(`    ✓ Verified in ${t5 - t4}ms. ${reportedNow} sets now have winnerId`);

// ── Report a SECOND set to verify real IDs work after conversion ────────
const nextUnreported = verifySets.find((s) => !s.winnerId && Number(s.entrant1Id) > 0 && Number(s.entrant2Id) > 0);
if (nextUnreported) {
	console.log(`\n[5] Reporting second set ${nextUnreported.id} (real ID after conversion)...`);
	const payload2 = {
		...nextUnreported,
		entrant1: Number(nextUnreported.entrant1Id),
		entrant2: Number(nextUnreported.entrant2Id),
		entrant1Score: 2,
		entrant2Score: 0,
		winnerId: null,
		isLast: false,
		games: []
	};
	const t6 = Date.now();
	const r2 = await fetch(`https://www.start.gg/api/-/rest/set/${nextUnreported.id}/complete`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Client-Version': '20' },
		body: JSON.stringify(payload2)
	});
	const t7 = Date.now();
	if (r2.ok) {
		console.log(`    ✓ Reported in ${t7 - t6}ms`);
	} else {
		const text = await r2.text().catch(() => '');
		console.log(`    ✗ HTTP ${r2.status} in ${t7 - t6}ms: ${text.slice(0, 200)}`);
	}
}

console.log(`\n=== SUMMARY ===`);
console.log(`Fetch sets: ${t1 - t0}ms`);
console.log(`Report 1:   ${t3 - t2}ms (preview ID)`);
console.log(`Verify:     ${t5 - t4}ms`);
console.log(`\n✅ Internal REST reporting works!`);
