/**
 * Report the first three waves of a 32-player Main bracket on StartGG,
 * minus 1 match (last LR2 match left unreported so redemption doesn't fully trigger).
 *
 * Wave 1: WR1 (16 matches)
 * Wave 2: WR2 + LR1 (8 + 8 = 16 matches)
 * Wave 3: LR2 minus last (7 matches)
 * Total: 39 matches reported. Higher seed always wins, 2-0.
 *
 * Usage: node scripts/report-waves-1-2.mjs
 */
import { readFileSync } from 'fs';
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TOKEN = env.STARTGG_TOKEN;
const EMAIL = env.STARTGG_EMAIL;
const PASSWORD = env.STARTGG_PASSWORD;
const MAIN_EVENT_ID = 1590950;

const GQL_URL = 'https://api.start.gg/gql/alpha';
const PROD_GQL = 'https://www.start.gg/api/-/gql';
const LOGIN_URL = 'https://www.start.gg/api/-/rest/user/login';

async function gql(query, variables) {
  await new Promise(r => setTimeout(r, 600));
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) console.error('GQL errors:', json.errors.map(e => e.message));
  return json.data;
}

let cookie;
async function login() {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Version': '20' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, rememberMe: true }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').match(/(gg_session=[^;]+)/)?.[1];
  if (!cookie) throw new Error('Login failed');
  console.log('Logged in');
}

async function adminFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'Client-Version': '20',
      'X-web-source': 'gg-web-gql-client',
      ...(opts.headers || {}),
    },
  });
}

async function fetchSets(pgId) {
  const url = `https://www.start.gg/api/-/rest/admin/phase_group/${pgId}?expand=["sets"]&mutations=["sets"]`;
  const res = await adminFetch(url);
  const json = await res.json();
  return json?.entities?.sets ?? [];
}

async function completeSet(pgId, e1Id, e2Id, winnerId, winScore, loseScore) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) {
      const base = [200, 500, 1000, 2000, 3000][attempt - 1] ?? 3000;
      await new Promise(r => setTimeout(r, base + Math.random() * base * 0.3));
    }

    // Re-fetch the set fresh each attempt to avoid stale data
    const sets = await fetchSets(pgId);
    const set = sets.find(s =>
      (Number(s.entrant1Id) === e1Id && Number(s.entrant2Id) === e2Id) ||
      (Number(s.entrant1Id) === e2Id && Number(s.entrant2Id) === e1Id)
    );
    if (!set) return { ok: false, error: `Set not found for ${e1Id} vs ${e2Id}` };
    if (set.winnerId) return { ok: true, alreadyDone: true };

    const isE1Winner = Number(set.entrant1Id) === winnerId;
    const payload = {
      ...set,
      entrant1: Number(set.entrant1Id),
      entrant2: Number(set.entrant2Id),
      entrant1Score: isE1Winner ? winScore : loseScore,
      entrant2Score: isE1Winner ? loseScore : winScore,
      winnerId: null,
      isLast: false,
      games: [],
    };
    const setId = String(set.id);
    if (setId.startsWith('preview_')) {
      payload.mutations = { ffaData: { [setId]: { isFFA: false } } };
    }
    const res = await adminFetch(`https://www.start.gg/api/-/rest/set/${setId}/complete`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };

    const text = await res.text().catch(() => '');
    if (res.status === 400 && text.includes('out of date')) continue; // retry with fresh data
    if (res.status === 500) continue; // transient conflict
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: false, error: 'Max retries exceeded' };
}

// Fetch entrant seeds to determine "higher seed"
async function getEntrantSeeds(phaseId) {
  const data = await gql(
    `query($phaseId:ID!,$page:Int!,$perPage:Int!){phase(id:$phaseId){seeds(query:{page:$page,perPage:$perPage}){nodes{seedNum entrant{id}}}}}`,
    { phaseId, page: 1, perPage: 64 }
  );
  const map = new Map();
  for (const s of data?.phase?.seeds?.nodes ?? []) {
    if (s.entrant?.id) map.set(Number(s.entrant.id), s.seedNum);
  }
  return map;
}

async function main() {
  await login();

  // Resolve Main event phase + PG
  const epData = await gql(
    `query($eventId:ID!){event(id:$eventId){phases{id name}}}`,
    { eventId: MAIN_EVENT_ID }
  );
  const phase = epData?.event?.phases?.[0];
  if (!phase) { console.error('No phase found'); return; }
  console.log(`Phase: ${phase.name} (${phase.id})`);

  const pgData = await gql(
    `query($phaseId:ID!){phase(id:$phaseId){phaseGroups(query:{page:1,perPage:10}){nodes{id displayIdentifier}}}}`,
    { phaseId: phase.id }
  );
  const pg = pgData?.phase?.phaseGroups?.nodes?.[0];
  if (!pg) { console.error('No phase group found'); return; }
  console.log(`Phase Group: ${pg.displayIdentifier} (${pg.id})`);

  // Get seeds for higher-seed-wins logic
  const seeds = await getEntrantSeeds(phase.id);
  console.log(`${seeds.size} entrant seeds loaded`);

  // Fetch all sets
  const allSets = await fetchSets(pg.id);
  console.log(`${allSets.length} total sets in phase group`);

  // Discover round numbers dynamically
  const roundCounts = new Map();
  for (const s of allSets) {
    const r = s.round;
    roundCounts.set(r, (roundCounts.get(r) ?? 0) + 1);
  }
  console.log('Rounds:', [...roundCounts.entries()].sort((a, b) => a[0] - b[0]).map(([r, c]) => `${r}:${c}`).join(', '));

  const winRounds = [...roundCounts.keys()].filter(r => r > 0).sort((a, b) => a - b);
  const losRounds = [...roundCounts.keys()].filter(r => r < 0).sort((a, b) => Math.abs(a) - Math.abs(b));
  console.log(`Winners rounds: ${winRounds.join(', ')}, Losers rounds: ${losRounds.join(', ')}`);

  const playable = s => s.entrant1Id && s.entrant2Id;

  // Helper: report all playable sets in a round, return count
  async function reportRound(label, sets, skip = 0) {
    const toReport = skip > 0 ? sets.slice(0, -skip) : sets;
    let ok = 0;
    for (const set of toReport) {
      const e1 = Number(set.entrant1Id), e2 = Number(set.entrant2Id);
      const s1 = seeds.get(e1) ?? 999, s2 = seeds.get(e2) ?? 999;
      const winner = s1 <= s2 ? e1 : e2;
      console.log(`  Seed ${s1} vs Seed ${s2} → winner: seed ${Math.min(s1, s2)}`);
      const result = await completeSet(pg.id, e1, e2, winner, 2, 0);
      if (result.ok) { ok++; } else { console.error(`  FAIL: ${result.error}`); }
    }
    console.log(`${label}: ${ok}/${toReport.length} reported`);
    if (skip > 0 && sets.length > 0) {
      const skipped = sets[sets.length - 1];
      console.log(`  Skipped last set: ${skipped.id} (${skipped.entrant1Id} vs ${skipped.entrant2Id})`);
    }
    return ok;
  }

  // Helper: fetch playable sets for a given round
  async function getPlayable(roundNum, label) {
    const sets = await fetchSets(pg.id);
    const found = sets.filter(s => s.round === roundNum && playable(s))
      .sort((a, b) => a.identifier - b.identifier);
    console.log(`${label} (round ${roundNum}): ${found.length} playable`);
    return found;
  }

  // === WAVE 1: WR1 ===
  const wr1 = allSets.filter(s => s.round === winRounds[0] && playable(s))
    .sort((a, b) => a.identifier - b.identifier);
  console.log(`\n=== WAVE 1: WR1 (round ${winRounds[0]}) — ${wr1.length} sets ===`);
  let total = await reportRound('WR1', wr1);

  // === WAVE 2: WR2 + LR1 ===
  console.log('\nWaiting for WR2/LR1 to populate...');
  await new Promise(r => setTimeout(r, 2000));

  const wr2 = await getPlayable(winRounds[1], 'WR2');
  console.log(`\n=== WAVE 2: WR2 (round ${winRounds[1]}) ===`);
  total += await reportRound('WR2', wr2);

  // Find first losers round with actual playable sets
  let lr1Sets = [];
  let lr1Idx = -1;
  for (let i = 0; i < losRounds.length; i++) {
    const sets = await getPlayable(losRounds[i], `LR check ${i+1}`);
    if (sets.length > 0) { lr1Sets = sets; lr1Idx = i; break; }
  }
  if (lr1Sets.length > 0) {
    console.log(`\n=== WAVE 2: LR1 (round ${losRounds[lr1Idx]}) — ${lr1Sets.length} sets ===`);
    total += await reportRound('LR1', lr1Sets);
  } else {
    console.log('No LR1 sets found');
  }

  // === WAVE 3: LR2 minus last ===
  console.log('\nWaiting for LR2 to populate...');
  await new Promise(r => setTimeout(r, 2000));

  // Find next losers round with playable sets (after LR1)
  let lr2Sets = [];
  let lr2Idx = -1;
  for (let i = (lr1Idx >= 0 ? lr1Idx + 1 : 0); i < losRounds.length; i++) {
    const sets = await getPlayable(losRounds[i], `LR2 check ${i+1}`);
    if (sets.length > 0) { lr2Sets = sets; lr2Idx = i; break; }
  }
  if (lr2Sets.length > 0) {
    console.log(`\n=== WAVE 3: LR2 (round ${losRounds[lr2Idx]}) — ${lr2Sets.length} sets, skip last ===`);
    total += await reportRound('LR2', lr2Sets, 1);
  } else {
    console.log('No LR2 sets found — LR1 winners may not have populated LR2 yet');
  }

  console.log(`\nTotal: ${total} matches reported`);
}

main().catch(console.error);
