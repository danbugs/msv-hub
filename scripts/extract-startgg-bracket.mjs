#!/usr/bin/env node
/**
 * Extract the full bracket topology from a StartGG phase group.
 * Outputs a JSON reference fixture with set identifiers, rounds,
 * and slot prereqs (winner-of / loser-of mappings).
 *
 * Usage:
 *   node scripts/extract-startgg-bracket.mjs [phaseGroupId]
 *
 * Default: uses the test tournament's main bracket PG (3346598).
 */
import { readFileSync, writeFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TOKEN = env.STARTGG_TOKEN;
const GQL_URL = 'https://api.start.gg/gql/alpha';

async function gql(query, variables) {
  await new Promise(r => setTimeout(r, 700));
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) console.error('GQL errors:', JSON.stringify(json.errors, null, 2));
  return json.data;
}

const SETS_QUERY = `
  query PhaseGroupSets($pgId: ID!, $page: Int!) {
    phaseGroup(id: $pgId) {
      displayIdentifier
      sets(page: $page, perPage: 50, sortType: STANDARD) {
        pageInfo { total totalPages }
        nodes {
          id
          identifier
          round
          fullRoundText
          slots {
            prereqId
            prereqType
            prereqPlacement
            seed {
              seedNum
              entrant {
                id
                participants { player { gamerTag } }
              }
            }
          }
        }
      }
    }
  }
`;

const pgId = process.argv[2] || '3346598';

console.log(`Extracting bracket topology from phase group ${pgId}...\n`);

// Paginate through all sets
const allSets = [];
let page = 1;
let totalPages = 1;
while (page <= totalPages) {
  const data = await gql(SETS_QUERY, { pgId, page });
  const pg = data?.phaseGroup;
  if (!pg) { console.error('Phase group not found'); process.exit(1); }
  const sets = pg.sets;
  totalPages = sets.pageInfo.totalPages;
  allSets.push(...sets.nodes);
  console.log(`  Page ${page}/${totalPages}: ${sets.nodes.length} sets (total ${sets.pageInfo.total})`);
  page++;
}

console.log(`\nTotal sets: ${allSets.length}`);

// Build reference structure
const setMap = new Map(allSets.map(s => [String(s.id), s]));

const reference = allSets.map(s => {
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
  // Sort: positive rounds ascending, then negative rounds by abs ascending
  if (a.round > 0 && b.round > 0) return a.round - b.round || a.identifier.localeCompare(b.identifier);
  if (a.round > 0) return -1;
  if (b.round > 0) return 1;
  return Math.abs(a.round) - Math.abs(b.round) || a.identifier.localeCompare(b.identifier);
});

// Print summary
const winners = reference.filter(s => s.round > 0);
const losers = reference.filter(s => s.round < 0);

console.log(`\n=== WINNERS (${winners.length} sets) ===`);
for (const s of winners) {
  const top = s.topSlot.gamerTag || (s.topSlot.prereqSetIdentifier ? `${s.topSlot.prereqType} of ${s.topSlot.prereqSetIdentifier}` : '—');
  const bot = s.bottomSlot.gamerTag || (s.bottomSlot.prereqSetIdentifier ? `${s.bottomSlot.prereqType} of ${s.bottomSlot.prereqSetIdentifier}` : '—');
  console.log(`  ${s.identifier.padEnd(3)} (R${s.round}) ${s.fullRoundText.padEnd(25)} | ${top.padEnd(20)} vs ${bot}`);
}

console.log(`\n=== LOSERS (${losers.length} sets) ===`);
for (const s of losers) {
  const top = s.topSlot.gamerTag || (s.topSlot.prereqSetIdentifier ? `${s.topSlot.prereqType} of ${s.topSlot.prereqSetIdentifier}` : '—');
  const bot = s.bottomSlot.gamerTag || (s.bottomSlot.prereqSetIdentifier ? `${s.bottomSlot.prereqType} of ${s.bottomSlot.prereqSetIdentifier}` : '—');
  console.log(`  ${s.identifier.padEnd(3)} (R${s.round}) ${s.fullRoundText.padEnd(25)} | ${top.padEnd(20)} vs ${bot}`);
}

// Save as JSON fixture
const fixture = {
  phaseGroupId: pgId,
  playerCount: new Set(allSets.flatMap(s => s.slots.map(sl => sl.seed?.entrant?.id).filter(Boolean))).size,
  sets: reference,
};

const outPath = new URL(`../src/lib/server/test-fixtures/startgg-bracket-${fixture.playerCount}p.json`, import.meta.url);
writeFileSync(outPath, JSON.stringify(fixture, null, 2));
console.log(`\nFixture saved to: ${outPath.pathname}`);
