#!/usr/bin/env node
/**
 * Apply a manually-specified seeding order to a StartGG tournament.
 * Usage: node scripts/apply-baseline-seeds.mjs <tournament-slug>
 * Example: node scripts/apply-baseline-seeds.mjs microspacing-vancouver-macro-8
 */
import { readFileSync } from 'node:fs';

try {
	const env = readFileSync('.env', 'utf8');
	for (const line of env.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) process.env[m[1]] = m[2];
	}
} catch (e) { console.error('Failed to load .env:', e.message); process.exit(1); }

const TOKEN = process.env.STARTGG_TOKEN;
const GQL = 'https://api.start.gg/gql/alpha';

// ── Baseline seeding (edit this list to change the order) ──────────────
// Format: [seedNum, gamerTag]
const BASELINE_SEEDS = [
	[1, 'Ouch!?'],
	[2, 'Boongly4'],
	[3, 'Vertigo'],
	[4, 'MOX'],
	[5, 'mr. money'],
	[6, 'Spikefire'],
	[7, 'Mossayef'],
	[8, 'Bunky'],
	[9, 'TetraTheThief'],
	[10, 'RedX'],
	[11, 'GEEK'],
	[12, 'Cash'],
	[13, 'TG'],
	[14, 'SLett'],
	[15, 'Hahahahahahahahahahaha00'],
	[16, 'noelle204'],
	[17, 'kazuYoshi'],
	[18, 'Apex'],
	[19, 'Dantotto'],
	[20, 'Little Cheese'],
	[21, 'skyes'],
	[22, 'Cooolth'],
	[23, 'alexasf'],
	[24, 'Jon Z'],
	[25, 'Car'],
	[26, 'Frog'],
	[27, 'Salade au Thon'],
	[28, 'Dreigon'],
	[29, 'BIGTGDAIRFAN600'],
	[30, 'Praxis'],
	[31, 'KORCAmeep'],
	[32, 'Taima'],
	[33, 'BrenX1'],
	[34, 'ImSoChove'],
	[35, 'bob'],
	[36, 'Kannyobi'],
	[37, 'Rautava'],
	[38, 'WilloTillo'],
	[39, 'Nel'],
	[40, 'mellowo'],
	[41, 'Ticolol'],
	[42, 'redbebber'],
	[43, 'Kenshiro'],
	[44, 'Kyo'],
	[45, 'Bon'],
	[46, 'MuteD'],
	[47, 'Jkami'],
	[48, 'Ruby | SadEgg'],
	[49, 'Joey Jojo Jr. Shabadoo'],
	[50, 'HunterBot'],
	[51, 'LeeWillin'],
	[52, 'Momonokill'],
	[53, 'Xidrion'],
	[54, 'Theory'],
	[55, 'jojo558'],
	[56, 'Bochito'],
	[57, 'Aqwess'],
	[58, 'Coppp89'],
	[59, 'CosmicTB'],
	[60, 'Binc'],
	[61, 'Aru'],
	[62, 'john larp'],
	[63, 'Luke'],
	[64, 'Dokiume'],
];

// ── GraphQL helpers ────────────────────────────────────────────────────

async function query(q, vars) {
	const r = await fetch(GQL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ query: q, variables: vars })
	});
	const json = await r.json();
	if (json.errors) {
		console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
		return null;
	}
	return json.data;
}

const TOURNAMENT_QUERY = `query Tournament($slug: String!) {
  tournament(slug: $slug) {
    id name
    events { id name }
  }
}`;

const EVENT_PHASES_QUERY = `query EventPhases($eventId: ID!) {
  event(id: $eventId) {
    phases { id name }
  }
}`;

const PHASE_SEEDS_QUERY = `query PhaseSeeds($phaseId: ID!, $page: Int!, $perPage: Int!) {
  phase(id: $phaseId) {
    seeds(query: { page: $page, perPage: $perPage }) {
      pageInfo { totalPages }
      nodes {
        id
        seedNum
        entrant {
          id
          name
          participants { player { id gamerTag } }
        }
      }
    }
  }
}`;

const UPDATE_SEEDING_MUTATION = `mutation UpdatePhaseSeeding($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
  updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) { id }
}`;

async function fetchAllSeeds(phaseId) {
	const all = [];
	let page = 1;
	while (true) {
		const data = await query(PHASE_SEEDS_QUERY, { phaseId, page, perPage: 50 });
		if (!data?.phase?.seeds?.nodes) break;
		all.push(...data.phase.seeds.nodes);
		if (page >= data.phase.seeds.pageInfo.totalPages) break;
		page++;
	}
	return all;
}

// ── Tag normalization for fuzzy matching ───────────────────────────────

function normalize(tag) {
	return tag.replace(/\s*\*\s*$/, '').trim().toLowerCase();
}

// ── Main ───────────────────────────────────────────────────────────────

const slug = process.argv[2];
if (!slug) {
	console.error('Usage: node scripts/apply-baseline-seeds.mjs <tournament-slug>');
	process.exit(1);
}

console.log(`[1] Fetching tournament: ${slug}`);
const tData = await query(TOURNAMENT_QUERY, { slug });
if (!tData?.tournament) { console.error('Tournament not found'); process.exit(1); }
console.log(`    ${tData.tournament.name} — ${tData.tournament.events.length} event(s)`);

const tagToSeedNum = new Map(BASELINE_SEEDS.map(([num, tag]) => [normalize(tag), num]));

for (const event of tData.tournament.events) {
	console.log(`\n[2] Event: ${event.name}`);
	const phData = await query(EVENT_PHASES_QUERY, { eventId: event.id });
	if (!phData?.event?.phases) { console.log('    No phases'); continue; }

	for (const phase of phData.event.phases) {
		console.log(`    Phase: ${phase.name} (${phase.id})`);
		const seeds = await fetchAllSeeds(phase.id);
		if (!seeds.length) { console.log('    No seeds'); continue; }

		const seedMapping = [];
		const unmatched = [];

		for (const seed of seeds) {
			const tag = seed.entrant?.participants?.[0]?.player?.gamerTag
				?? seed.entrant?.name ?? '';
			const desired = tagToSeedNum.get(normalize(tag));
			if (desired !== undefined) {
				seedMapping.push({ seedId: seed.id, seedNum: desired });
			} else {
				unmatched.push(tag);
			}
		}

		if (unmatched.length) {
			console.log(`    ⚠ ${unmatched.length} entrant(s) not in baseline: ${unmatched.join(', ')}`);
			console.log(`      They will keep their current seed positions.`);
		}

		if (!seedMapping.length) {
			console.log('    No matching seeds to apply');
			continue;
		}

		seedMapping.sort((a, b) => a.seedNum - b.seedNum);
		console.log(`    Applying ${seedMapping.length}/${seeds.length} seeds...`);

		const result = await query(UPDATE_SEEDING_MUTATION, { phaseId: phase.id, seedMapping });
		console.log(result ? '    ✓ Seeding applied' : '    ✗ Failed to apply');
	}
}

console.log('\nDone.');
