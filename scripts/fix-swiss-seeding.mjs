/**
 * One-shot script: fix seeding so 1Test=seed1, 2Test=seed2, ..., 32Test=seed32.
 * Discovers all events in the tournament, finds which ones have players, and
 * corrects seeding on those.
 *
 * Usage: node scripts/fix-swiss-seeding.mjs
 */
import { readFileSync } from 'fs';
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const STARTGG_TOKEN = env.STARTGG_TOKEN;
const TOURNAMENT_SLUG = 'microspacing-vancouver-test';

const GQL_URL = 'https://api.start.gg/gql/alpha';

async function gql(query, variables) {
  await new Promise(r => setTimeout(r, 600));
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STARTGG_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error('GQL errors:', JSON.stringify(json.errors, null, 2));
  }
  return json.data;
}

const TOURNAMENT_EVENTS_QUERY = `
  query TournamentEvents($slug: String!) {
    tournament(slug: $slug) {
      events { id name numEntrants }
    }
  }
`;

const EVENT_PHASES_QUERY = `
  query EventPhases($eventId: ID!) {
    event(id: $eventId) {
      phases { id name }
    }
  }
`;

const PHASE_GROUPS_QUERY = `
  query PhaseGroups($phaseId: ID!) {
    phase(id: $phaseId) {
      phaseGroups(query: { perPage: 10 }) {
        nodes { id displayIdentifier }
      }
    }
  }
`;

const SEEDS_QUERY = `
  query PhaseGroupSeeds($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $phaseGroupId) {
      seeds(query: { page: $page, perPage: $perPage }) {
        nodes {
          id
          seedNum
          entrant {
            id
            participants { player { gamerTag } }
          }
        }
      }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation UpdatePhaseSeeding($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
    updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) { id }
  }
`;

async function fixEventSeeding(label, eventId) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Fixing ${label} seeding (event ${eventId})...`);
  console.log('='.repeat(50));

  const phaseData = await gql(EVENT_PHASES_QUERY, { eventId });
  const phases = phaseData?.event?.phases ?? [];
  if (!phases.length) { console.error(`No phases found for ${label}`); return; }
  const phaseId = phases[0].id;
  console.log(`  Phase: ${phases[0].name} (${phaseId})`);

  const pgData = await gql(PHASE_GROUPS_QUERY, { phaseId });
  const groups = pgData?.phase?.phaseGroups?.nodes ?? [];
  if (!groups.length) { console.error(`No phase groups found for ${label}`); return; }
  const pgId = groups[0].id;
  console.log(`  Phase Group: ${groups[0].displayIdentifier} (${pgId})`);

  console.log('\nFetching seeds...');
  const data = await gql(SEEDS_QUERY, { phaseGroupId: pgId, page: 1, perPage: 64 });
  const seeds = data?.phaseGroup?.seeds?.nodes ?? [];
  console.log(`Found ${seeds.length} seeds`);

  if (seeds.length === 0) { console.log(`No seeds to fix for ${label}`); return; }

  const current = seeds
    .map((s) => ({
      seedId: String(s.id),
      entrantId: s.entrant?.id,
      tag: s.entrant?.participants?.[0]?.player?.gamerTag ?? '?',
      seedNum: s.seedNum,
    }))
    .sort((a, b) => a.seedNum - b.seedNum);

  console.log('\nCurrent seeding:');
  for (const s of current) {
    console.log(`  Seed ${s.seedNum}: ${s.tag}`);
  }

  const seedMapping = current.map((s) => {
    const match = s.tag.match(/^(\d+)Test$/i);
    const correctSeed = match ? parseInt(match[1], 10) : s.seedNum;
    return {
      seedId: s.seedId,
      phaseGroupId: String(pgId),
      seedNum: correctSeed,
    };
  });

  seedMapping.sort((a, b) => a.seedNum - b.seedNum);

  const alreadyCorrect = current.every((s) => {
    const match = s.tag.match(/^(\d+)Test$/i);
    return match && parseInt(match[1], 10) === s.seedNum;
  });
  if (alreadyCorrect) {
    console.log(`\n${label} seeding is already correct — skipping.`);
    return;
  }

  console.log('\nPushing corrected seeding...');
  const result = await gql(UPDATE_MUTATION, {
    phaseId: String(phaseId),
    seedMapping,
  });

  if (result) {
    console.log(`${label} seeding updated!`);
  } else {
    console.error(`${label} mutation failed`);
    return;
  }

  await new Promise(r => setTimeout(r, 1000));
  console.log('\nVerifying...');
  const verify = await gql(SEEDS_QUERY, { phaseGroupId: pgId, page: 1, perPage: 64 });
  const after = (verify?.phaseGroup?.seeds?.nodes ?? [])
    .map((s) => ({
      tag: s.entrant?.participants?.[0]?.player?.gamerTag ?? '?',
      seedNum: s.seedNum,
    }))
    .sort((a, b) => a.seedNum - b.seedNum);

  console.log('\nNew seeding:');
  for (const s of after) {
    console.log(`  Seed ${s.seedNum}: ${s.tag}`);
  }
}

async function main() {
  console.log(`Discovering events for tournament: ${TOURNAMENT_SLUG}`);
  const tData = await gql(TOURNAMENT_EVENTS_QUERY, { slug: TOURNAMENT_SLUG });
  const events = tData?.tournament?.events ?? [];
  if (!events.length) { console.error('No events found'); return; }

  console.log(`Found ${events.length} events:`);
  for (const e of events) {
    console.log(`  ${e.name} (${e.id}) — ${e.numEntrants ?? 0} entrants`);
  }

  const withPlayers = events.filter(e => (e.numEntrants ?? 0) > 0);
  if (!withPlayers.length) {
    console.log('\nNo events have players — nothing to fix.');
    return;
  }

  for (const e of withPlayers) {
    await fixEventSeeding(e.name, e.id);
  }

  console.log('\nAll done!');
}

main().catch(console.error);
