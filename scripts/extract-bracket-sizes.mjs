#!/usr/bin/env node
/**
 * Extract StartGG bracket topology at multiple player counts.
 *
 * Workflow for each target size:
 *   1. Get current players in main bracket event
 *   2. Remove/add players to reach target count
 *   3. Reset the bracket phase so StartGG regenerates it
 *   4. Wait for propagation
 *   5. Extract the bracket topology via GQL
 *   6. Save fixture JSON
 *   7. Restore to next target size
 *
 * Usage: node scripts/extract-bracket-sizes.mjs [sizes...]
 *   e.g. node scripts/extract-bracket-sizes.mjs 16 31 32
 *   Default: 8 14 15 16 29 30 31 32
 */
import { readFileSync, writeFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TOKEN = env.STARTGG_TOKEN;
const EMAIL = env.STARTGG_EMAIL;
const PASSWORD = env.STARTGG_PASSWORD;
const GQL_URL = 'https://api.start.gg/gql/alpha';
const LOGIN_URL = 'https://www.start.gg/api/-/rest/user/login';
const PHASE_REST = 'https://www.start.gg/api/-/rest/phase';

const TOURNAMENT_SLUG = 'microspacing-vancouver-test';
const MAIN_EVENT_ID = 1590950;
const SWISS_EVENT_ID = 1590949;
const MAIN_PHASE_ID = 2313187;

const DEFAULT_SIZES = [8, 14, 15, 16, 29, 30, 31, 32];
const targetSizes = (process.argv.slice(2).length > 0
  ? process.argv.slice(2).map(Number).filter(n => n > 0)
  : DEFAULT_SIZES
).sort((a, b) => b - a); // descending so we remove players progressively

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables) {
  await sleep(700);
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) console.error('GQL errors:', JSON.stringify(json.errors, null, 2));
  return json.data;
}

// Login for admin REST calls
console.log('Logging in...');
const loginRes = await fetch(LOGIN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Client-Version': '20' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, rememberMe: true, validationKey: 'LOGIN_userlogin', expand: [] })
});
const raw = loginRes.headers.get('set-cookie') ?? '';
const cookie = raw.match(/(gg_session=[^;]+)/)?.[1];
if (!cookie) { console.error('Login failed'); process.exit(1); }
console.log('  ✓ Logged in\n');

// Get all participants and their event memberships
async function getParticipants() {
  const data = await gql(
    `query($slug: String!) { tournament(slug: $slug) { participants(query: { page: 1, perPage: 200 }) { nodes { id gamerTag player { gamerTag } events { id } } } } }`,
    { slug: TOURNAMENT_SLUG }
  );
  return (data?.tournament?.participants?.nodes ?? []).map(p => ({
    participantId: p.id,
    gamerTag: p.gamerTag,
    playerGamerTag: p.player?.gamerTag,
    currentEventIds: (p.events ?? []).map(e => e.id),
  }));
}

// Update participant events (add/remove from main bracket)
async function updateParticipantEvents(participantId, eventIds) {
  await sleep(500);
  const mainPhaseData = await gql(`query($eventId: ID!) { event(id: $eventId) { phases { id } } }`, { eventId: MAIN_EVENT_ID });
  const mainPhaseId = mainPhaseData?.event?.phases?.[0]?.id;
  const phaseDest = eventIds.includes(MAIN_EVENT_ID) && mainPhaseId
    ? [{ eventId: MAIN_EVENT_ID, phaseDestId: mainPhaseId }]
    : [];
  const phaseGroupDest = eventIds.includes(MAIN_EVENT_ID)
    ? [{ eventId: MAIN_EVENT_ID, phaseGroupDestId: null }]
    : [];

  const mutation = `mutation UpdateParticipantRegistration($participantId: ID!, $regData: [UpdateParticipantRegData], $entrantData: UpdateParticipantEntrantData) {
    updateParticipantRegistration(participantId: $participantId, regData: $regData, entrantData: $entrantData) { id events { id name } }
  }`;

  await sleep(500);
  const res = await fetch('https://www.start.gg/api/-/gql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'Client-Version': '20', 'X-web-source': 'gg-web-gql-client', 'Accept': '*/*' },
    body: JSON.stringify({
      query: mutation,
      variables: {
        participantId: String(participantId),
        regData: [],
        entrantData: { eventIds, paidEventIds: eventIds, eventPartnerIds: [], phaseDest, phaseGroupDest },
      }
    })
  });
  const json = await res.json();
  if (json.errors) console.error('  updateParticipantEvents errors:', JSON.stringify(json.errors, null, 2));
  return { ok: !json.errors, events: json.data?.updateParticipantRegistration?.events };
}

// Reset bracket phase
async function resetPhase() {
  const res = await fetch(`${PHASE_REST}/${MAIN_PHASE_ID}/restart`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'Client-Version': '20' },
    body: JSON.stringify({ linkedStates: [{ entityKey: 'phase', id: MAIN_PHASE_ID, action: 'PHASE_UPDATE' }] })
  });
  return res.ok;
}

// Get phase group ID (may change after reset)
async function getPhaseGroupId() {
  const data = await gql(
    `query($phaseId: ID!) { phase(id: $phaseId) { phaseGroups(query: { perPage: 5 }) { nodes { id } } } }`,
    { phaseId: MAIN_PHASE_ID }
  );
  return data?.phase?.phaseGroups?.nodes?.[0]?.id;
}

// Extract bracket sets from a phase group
async function extractBracket(pgId) {
  const allSets = [];
  let page = 1, totalPages = 1;
  while (page <= totalPages) {
    const data = await gql(
      `query($pgId: ID!, $page: Int!) { phaseGroup(id: $pgId) { sets(page: $page, perPage: 50, sortType: STANDARD) { pageInfo { total totalPages } nodes { id identifier round fullRoundText slots { prereqId prereqType prereqPlacement seed { seedNum entrant { id participants { player { gamerTag } } } } } } } } }`,
      { pgId, page }
    );
    const pg = data?.phaseGroup;
    if (!pg) return null;
    totalPages = pg.sets.pageInfo.totalPages;
    allSets.push(...pg.sets.nodes);
    page++;
  }

  const setMap = new Map(allSets.map(s => [String(s.id), s]));
  return allSets.map(s => {
    const slots = s.slots.map(slot => {
      const entry = {};
      if (slot.prereqId) {
        const prereqSet = setMap.get(String(slot.prereqId));
        entry.prereqSetIdentifier = prereqSet?.identifier ?? `?${slot.prereqId}`;
        entry.prereqType = slot.prereqType;
      }
      if (slot.seed?.seedNum) entry.seedNum = slot.seed.seedNum;
      if (slot.seed?.entrant?.participants?.[0]?.player?.gamerTag) {
        entry.gamerTag = slot.seed.entrant.participants[0].player.gamerTag;
      }
      return entry;
    });
    return {
      identifier: s.identifier,
      round: s.round,
      fullRoundText: s.fullRoundText,
      topSlot: slots[0] || {},
      bottomSlot: slots[1] || {},
    };
  }).sort((a, b) => {
    if (a.round > 0 && b.round > 0) return a.round - b.round || a.identifier.localeCompare(b.identifier);
    if (a.round > 0) return -1;
    if (b.round > 0) return 1;
    return Math.abs(a.round) - Math.abs(b.round) || a.identifier.localeCompare(b.identifier);
  });
}

// Sort participants by gamerTag number (NTest → N) descending so we remove highest first
function tagNum(p) {
  const m = (p.playerGamerTag || p.gamerTag).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 999;
}

// Main loop
const allParticipants = await getParticipants();
const mainParticipants = allParticipants
  .filter(p => p.currentEventIds.includes(MAIN_EVENT_ID))
  .sort((a, b) => tagNum(b) - tagNum(a)); // highest number first for removal

console.log(`Main bracket has ${mainParticipants.length} participants\n`);

for (const size of targetSizes) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Extracting ${size}-player bracket`);
  console.log('='.repeat(60));

  // Get current main event participants
  const current = await getParticipants();
  const inMain = current.filter(p => p.currentEventIds.includes(MAIN_EVENT_ID))
    .sort((a, b) => tagNum(b) - tagNum(a));
  const currentCount = inMain.length;

  if (currentCount > size) {
    // Remove excess players (highest seeds first)
    const toRemove = inMain.slice(0, currentCount - size);
    console.log(`  Removing ${toRemove.length} players...`);
    for (const p of toRemove) {
      const newEvents = p.currentEventIds.filter(id => id !== MAIN_EVENT_ID);
      if (newEvents.length === 0) newEvents.push(SWISS_EVENT_ID); // keep in at least Swiss
      const result = await updateParticipantEvents(p.participantId, newEvents);
      if (result.ok) console.log(`    ✓ Removed ${p.gamerTag}`);
      else console.log(`    ✗ Failed to remove ${p.gamerTag}`);
    }
  } else if (currentCount < size) {
    // Add players back
    const notInMain = current.filter(p => !p.currentEventIds.includes(MAIN_EVENT_ID))
      .sort((a, b) => tagNum(a) - tagNum(b)); // lowest number first for addition
    const toAdd = notInMain.slice(0, size - currentCount);
    console.log(`  Adding ${toAdd.length} players...`);
    for (const p of toAdd) {
      const newEvents = [...new Set([...p.currentEventIds, MAIN_EVENT_ID])];
      const result = await updateParticipantEvents(p.participantId, newEvents);
      if (result.ok) console.log(`    ✓ Added ${p.gamerTag}`);
      else console.log(`    ✗ Failed to add ${p.gamerTag}`);
    }
  } else {
    console.log(`  Already at ${size} players`);
  }

  // Reset bracket
  console.log('  Resetting bracket phase...');
  await resetPhase();
  console.log('  Waiting for propagation...');
  await sleep(5000);

  // Fix seeding (NTest = seed N)
  console.log('  Fixing seeding...');
  const pgId = await getPhaseGroupId();
  if (!pgId) { console.error('  ✗ No phase group found'); continue; }

  const seedData = await gql(
    `query($pgId: ID!) { phaseGroup(id: $pgId) { seeds(query: { page: 1, perPage: 64 }) { nodes { id seedNum entrant { id participants { player { gamerTag } } } } } } }`,
    { pgId }
  );
  const seeds = seedData?.phaseGroup?.seeds?.nodes ?? [];
  const seedMapping = seeds.map(s => {
    const tag = s.entrant?.participants?.[0]?.player?.gamerTag ?? '';
    const m = tag.match(/^(\d+)Test$/i);
    return { seedId: String(s.id), phaseGroupId: String(pgId), seedNum: m ? parseInt(m[1], 10) : s.seedNum };
  }).sort((a, b) => a.seedNum - b.seedNum);

  await gql(
    `mutation($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) { updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) { id } }`,
    { phaseId: String(MAIN_PHASE_ID), seedMapping }
  );
  console.log(`  ✓ Seeding fixed for ${seeds.length} seeds`);
  await sleep(2000);

  // Extract topology
  console.log('  Extracting bracket topology...');
  const sets = await extractBracket(pgId);
  if (!sets) { console.error('  ✗ Failed to extract'); continue; }

  const playerCount = new Set(sets.flatMap(s => [s.topSlot.gamerTag, s.bottomSlot.gamerTag].filter(Boolean))).size;
  console.log(`  ✓ ${sets.length} sets, ${playerCount} unique players`);

  // Print drop-in rounds
  const fixtureByLetter = new Map(sets.map(s => [s.identifier, s]));
  for (const s of sets.filter(s => s.round < 0)) {
    const topId = s.topSlot.prereqSetIdentifier;
    if (!topId || topId.startsWith('?')) continue;
    const topSet = fixtureByLetter.get(topId);
    if (topSet && topSet.round > 0) {
      console.log(`    ${s.identifier}: loser of ${topId} (top) + winner of ${s.bottomSlot.prereqSetIdentifier} (bot)`);
    }
  }

  // Save fixture
  const fixture = { phaseGroupId: pgId, playerCount: size, sets };
  const outPath = new URL(`../src/lib/server/test-fixtures/startgg-bracket-${size}p.json`, import.meta.url);
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`  ✓ Saved to test-fixtures/startgg-bracket-${size}p.json`);
}

// Restore to 32 players
console.log(`\n${'='.repeat(60)}`);
console.log('Restoring to 32 players...');
const finalParticipants = await getParticipants();
const finalInMain = finalParticipants.filter(p => p.currentEventIds.includes(MAIN_EVENT_ID));
const notInMain = finalParticipants.filter(p => !p.currentEventIds.includes(MAIN_EVENT_ID));
if (finalInMain.length < 32) {
  const toAdd = notInMain.sort((a, b) => tagNum(a) - tagNum(b)).slice(0, 32 - finalInMain.length);
  for (const p of toAdd) {
    const newEvents = [...new Set([...p.currentEventIds, MAIN_EVENT_ID])];
    await updateParticipantEvents(p.participantId, newEvents);
  }
}
await resetPhase();
console.log('  ✓ Restored\n');
console.log('Done! Run tests with: npx vitest run src/lib/server/swiss.test.ts');
