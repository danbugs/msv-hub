#!/usr/bin/env node
/**
 * Stress-test StartGG internal REST reporting with CONCURRENT reports.
 *
 * Usage:
 *   node scripts/test-internal-rest.mjs <phaseGroupId> [concurrency=16]
 *
 * Fires N concurrent PUT requests to /api/-/rest/set/{id}/complete, mimicking
 * TOs clicking "report" on multiple matches simultaneously. Tracks success/
 * failure and per-request timing.
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

const phaseGroupId = Number(process.argv[2]);
const concurrency = Number(process.argv[3]) || 16;
if (!phaseGroupId) {
	console.error('Usage: node scripts/test-internal-rest.mjs <phaseGroupId> [concurrency=16]');
	process.exit(1);
}

// ── Login ───────────────────────────────────────────────────────────────
console.log(`\n[1] Logging in...`);
const loginRes = await fetch('https://www.start.gg/api/-/rest/user/login', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', 'Client-Version': '20' },
	body: JSON.stringify({
		email: EMAIL, password: PASSWORD, rememberMe: true,
		validationKey: 'LOGIN_userlogin', expand: []
	})
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').match(/(gg_session=[^;]+)/)?.[1];
if (!cookie) { console.error('Login failed'); process.exit(1); }
console.log(`    ✓ Logged in`);

// ── Fetch sets ──────────────────────────────────────────────────────────
console.log(`\n[2] Fetching sets for phase group ${phaseGroupId}...`);
const setsRes = await fetch(
	`https://www.start.gg/api/-/rest/admin/phase_group/${phaseGroupId}?id=${phaseGroupId}&admin=true&expand=%5B%22sets%22%5D&reset=false`,
	{ headers: { Cookie: cookie, 'Client-Version': '20' } }
);
const setsData = await setsRes.json();
const allSets = setsData?.entities?.sets ?? [];
const unreported = allSets.filter((s) => !s.winnerId && Number(s.entrant1Id) > 0 && Number(s.entrant2Id) > 0);
console.log(`    ${allSets.length} total, ${unreported.length} unreported`);

if (unreported.length < concurrency) {
	console.log(`    Only ${unreported.length} unreported sets, running with that many`);
}

const targets = unreported.slice(0, concurrency);

// ── Concurrent report ───────────────────────────────────────────────────
console.log(`\n[3] Firing ${targets.length} concurrent PUT requests...`);

function buildPayload(set, winnerEntrantId, isDQ) {
	const e1 = Number(set.entrant1Id);
	const e2 = Number(set.entrant2Id);
	const winnerIsE1 = winnerEntrantId === e1;

	let e1Score, e2Score;
	if (isDQ) {
		// Loser gets -1 (DQ marker). Winner gets 0.
		e1Score = winnerIsE1 ? 0 : -1;
		e2Score = winnerIsE1 ? -1 : 0;
	} else {
		e1Score = winnerIsE1 ? 2 : 0;
		e2Score = winnerIsE1 ? 0 : 2;
	}

	const payload = {
		...set,
		entrant1: e1,
		entrant2: e2,
		entrant1Score: e1Score,
		entrant2Score: e2Score,
		winnerId: null,
		isLast: false,
		games: []
	};
	if (String(set.id).startsWith('preview_')) {
		payload.mutations = { ffaData: { [set.id]: { isFFA: false } } };
	}
	return payload;
}

async function fetchSets() {
	const r = await fetch(
		`https://www.start.gg/api/-/rest/admin/phase_group/${phaseGroupId}?id=${phaseGroupId}&admin=true&expand=%5B%22sets%22%5D&reset=false`,
		{ headers: { Cookie: cookie, 'Client-Version': '20' } }
	);
	const d = await r.json();
	return d?.entities?.sets ?? [];
}

async function putReport(set) {
	const payload = buildPayload(set, Number(set.entrant1Id), false);
	const res = await fetch(`https://www.start.gg/api/-/rest/set/${set.id}/complete`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Client-Version': '20' },
		body: JSON.stringify(payload)
	});
	return res;
}

async function reportOne(initialSet, idx) {
	const t0 = Date.now();
	let set = initialSet;
	let lastErr = null;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			if (attempt > 0) {
				// Jittered backoff: 200ms, 500ms, 1s, 2s, 3s
				const base = [200, 500, 1000, 2000, 3000][attempt - 1] ?? 3000;
				await new Promise((r) => setTimeout(r, base + Math.random() * base * 0.3));
			}
			const res = await putReport(set);
			if (res.ok) {
				const data = await res.json().catch(() => ({}));
				const realId = data?.id ?? data?.entities?.sets?.[0]?.id;
				return { idx, setId: set.id, ok: true, ms: Date.now() - t0, realId, attempts: attempt + 1 };
			}
			const text = await res.text().catch(() => '');
			lastErr = `HTTP ${res.status}: ${text.slice(0, 120)}`;
			// "Match data out of date" → re-fetch the set (post-conversion) and retry
			if (res.status === 400 && text.includes('out of date')) {
				const fresh = await fetchSets();
				const updated = fresh.find((s) =>
					!s.winnerId &&
					((Number(s.entrant1Id) === Number(initialSet.entrant1Id) && Number(s.entrant2Id) === Number(initialSet.entrant2Id)) ||
					 (Number(s.entrant1Id) === Number(initialSet.entrant2Id) && Number(s.entrant2Id) === Number(initialSet.entrant1Id)))
				);
				if (updated) { set = updated; continue; }
				// No updated set found — set might already be reported
				const reported = fresh.find((s) =>
					s.winnerId &&
					((Number(s.entrant1Id) === Number(initialSet.entrant1Id) && Number(s.entrant2Id) === Number(initialSet.entrant2Id)) ||
					 (Number(s.entrant1Id) === Number(initialSet.entrant2Id) && Number(s.entrant2Id) === Number(initialSet.entrant1Id)))
				);
				if (reported) {
					return { idx, setId: set.id, ok: true, ms: Date.now() - t0, realId: reported.id, attempts: attempt + 1, note: 'already-reported' };
				}
			}
			// 500 errors are transient concurrent-write conflicts — retry
			if (res.status === 500) continue;
			break;
		} catch (e) {
			lastErr = String(e).slice(0, 150);
		}
	}
	return { idx, setId: initialSet.id, ok: false, ms: Date.now() - t0, error: lastErr };
}

const startAll = Date.now();
const results = await Promise.all(targets.map((s, i) => reportOne(s, i)));
const totalMs = Date.now() - startAll;

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n=== RESULTS (concurrency=${targets.length}, total=${totalMs}ms) ===`);
results.sort((a, b) => a.idx - b.idx);
for (const r of results) {
	const status = r.ok ? '✓' : '✗';
	const detail = r.ok ? `→ ${r.realId} (${r.attempts} att)` : `${r.error}`;
	console.log(`  [${String(r.idx).padStart(2, ' ')}] ${status} ${String(r.setId).padEnd(25, ' ')} ${String(r.ms).padStart(4, ' ')}ms  ${detail}`);
}

const ok = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
const maxMs = Math.max(...results.map((r) => r.ms));
const minMs = Math.min(...results.map((r) => r.ms));

console.log(`\n  Success: ${ok}/${results.length}`);
console.log(`  Failed:  ${fail}`);
console.log(`  Timing:  min=${minMs}ms avg=${avgMs}ms max=${maxMs}ms`);
console.log(`  Wall:    ${totalMs}ms (all ran in parallel)`);

if (fail > 0) {
	console.log(`\n⚠️  ${fail} request(s) failed — concurrent reporting hit a race condition`);
	process.exit(1);
} else {
	console.log(`\n✅ All concurrent reports succeeded`);
}
