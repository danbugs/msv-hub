import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Redis } from '@upstash/redis';
import { getAllTimeEvents } from '../src/lib/server/alltime-slugs.ts';
import {
	createRating, rate1v1, rate1v1Weighted, ratingToPoints, DEFAULT_SIGMA
} from '../src/lib/server/trueskill.ts';
import type { Rating } from '../src/lib/server/trueskill.ts';
import type {
	LeagueSeason, LeagueEvent, LeaguePlayer, LeagueMatch, LeaguePlacement, CharacterSelection
} from '../src/lib/types/league.ts';

// ── Env ──────────────────────────────────────────────────────────────────

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const ENV = Object.fromEntries(
	envText.split('\n')
		.filter(l => l && !l.startsWith('#') && l.includes('='))
		.map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const STARTGG_TOKEN = ENV.STARTGG_TOKEN;
const redis = new Redis({
	url: ENV.UPSTASH_REDIS_REST_URL,
	token: ENV.UPSTASH_REDIS_REST_TOKEN
});

if (!STARTGG_TOKEN) throw new Error('STARTGG_TOKEN missing from .env');

// ── StartGG GQL ──────────────────────────────────────────────────────────

const API_URL = 'https://api.start.gg/gql/alpha';
const API_DELAY = 800;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GqlRecord = Record<string, any>;

async function gql<T = GqlRecord>(query: string, variables: GqlRecord): Promise<T | null> {
	await sleep(API_DELAY);
	const res = await fetch(API_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STARTGG_TOKEN}` },
		body: JSON.stringify({ query, variables })
	});
	if (res.status === 429) {
		console.warn('  Rate limited, waiting 10s...');
		await sleep(10_000);
		return gql(query, variables);
	}
	if (!res.ok) {
		console.error(`  HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		return null;
	}
	const json = await res.json();
	if (json.errors) {
		for (const err of json.errors) console.error(`  GQL error: ${err.message ?? JSON.stringify(err)}`);
		return null;
	}
	return json.data as T;
}

const TOURNAMENT_QUERY = `
query TournamentEvents($slug: String!) {
  tournament(slug: $slug) {
    id name startAt
    events(filter: { videogameId: [1386] }) { id name slug numEntrants }
  }
}`;

const SETS_QUERY = `
query LeagueEventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { totalPages }
      nodes {
        id round displayScore winnerId fullRoundText
        phaseGroup { bracketType }
        slots {
          seed { seedNum }
          entrant { id name participants { player { id gamerTag } } }
        }
        games {
          winnerId
          selections {
            entrant { id }
            selectionType selectionValue
            character { id name images(type: "stockIcon") { url } }
          }
        }
      }
    }
  }
}`;

const STANDINGS_QUERY = `
query EventStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    standings(query: { page: $page, perPage: $perPage }) {
      pageInfo { totalPages }
      nodes { placement entrant { id participants { player { id gamerTag } } } }
    }
  }
}`;

// ── Character ID map ─────────────────────────────────────────────────────

const CHAR_ID_TO_NAME: Record<number, string> = {
	1302: 'Mario', 1280: 'Donkey Kong', 1296: 'Link', 1328: 'Samus', 1408: 'Dark Samus',
	1338: 'Yoshi', 1295: 'Kirby', 1286: 'Fox', 1319: 'Pikachu', 1301: 'Luigi',
	1313: 'Ness', 1274: 'Captain Falcon', 1293: 'Jigglypuff', 1317: 'Peach', 1277: 'Daisy',
	1273: 'Bowser', 1290: 'Ice Climbers', 1329: 'Sheik', 1340: 'Zelda', 1282: 'Dr. Mario',
	1318: 'Pichu', 1285: 'Falco', 1304: 'Marth', 1300: 'Lucina', 1339: 'Young Link',
	1287: 'Ganondorf', 1310: 'Mewtwo', 1326: 'Roy', 1409: 'Chrom', 1405: 'Mr. Game & Watch',
	1307: 'Meta Knight', 1320: 'Pit', 1278: 'Dark Pit', 1341: 'Zero Suit Samus', 1335: 'Wario',
	1331: 'Snake', 1291: 'Ike', 1321: 'Pokemon Trainer', 1279: 'Diddy Kong', 1299: 'Lucas',
	1332: 'Sonic', 1294: 'King Dedede', 1314: 'Olimar', 1298: 'Lucario', 1323: 'R.O.B.',
	1333: 'Toon Link', 1337: 'Wolf', 1334: 'Villager', 1305: 'Mega Man', 1336: 'Wii Fit Trainer',
	1325: 'Rosalina & Luma', 1297: 'Little Mac', 1289: 'Greninja',
	1316: 'Palutena', 1315: 'Pac-Man', 1324: 'Robin', 1330: 'Shulk', 1272: 'Bowser Jr.',
	1283: 'Duck Hunt', 1327: 'Ryu', 1410: 'Ken', 1275: 'Cloud', 1276: 'Corrin',
	1271: 'Bayonetta', 1292: 'Inkling', 1322: 'Ridley', 1411: 'Simon', 1412: 'Richter',
	1407: 'King K. Rool', 1413: 'Isabelle', 1406: 'Incineroar',
	1441: 'Piranha Plant', 1453: 'Joker', 1526: 'Hero', 1530: 'Banjo & Kazooie',
	1532: 'Terry', 1539: 'Byleth', 1747: 'Min Min', 1766: 'Steve',
	1777: 'Sephiroth', 1795: 'Pyra/Mythra', 1846: 'Kazuya', 1897: 'Sora',
	1311: 'Mii Brawler', 1415: 'Mii Gunner', 1414: 'Mii Swordfighter'
};

// ── Helpers (replicated from league-import.ts) ───────────────────────────

function classifySet(set: GqlRecord, isRedemption: boolean): { phase: string; roundLabel: string } {
	const fullRoundText = (set.fullRoundText ?? '') as string;
	const bracketType = set.phaseGroup?.bracketType as string | undefined;
	if (bracketType === 'SWISS') return { phase: 'swiss', roundLabel: fullRoundText || `Round ${Math.abs(set.round ?? 0)}` };
	const round = (set.round ?? 0) as number;
	const prefix = isRedemption ? 'redemption-' : '';
	if (round > 0) return { phase: `${prefix}winners`, roundLabel: fullRoundText || `${isRedemption ? 'Redemption ' : ''}Winners R${round}` };
	return { phase: `${prefix}losers`, roundLabel: fullRoundText || `${isRedemption ? 'Redemption ' : ''}Losers R${Math.abs(round)}` };
}

function isDQSet(displayScore: string | null): boolean {
	return displayScore?.toUpperCase().includes('DQ') ?? false;
}

function parseScore(displayScore: string | null, entrant1Name: string): { s1: number; s2: number } {
	if (!displayScore || isDQSet(displayScore)) return { s1: 0, s2: 0 };
	const parts = displayScore.split(' - ');
	if (parts.length !== 2) return { s1: 0, s2: 0 };
	const leftMatch = parts[0].trim().match(/^(.+?)\s+(\d+)$/);
	const rightMatch = parts[1].trim().match(/^(.+?)\s+(\d+)$/);
	if (!leftMatch || !rightMatch) return { s1: 0, s2: 0 };
	const leftName = leftMatch[1].trim();
	const leftScore = parseInt(leftMatch[2], 10);
	const rightScore = parseInt(rightMatch[2], 10);
	if (leftName.toLowerCase().includes(entrant1Name.toLowerCase().slice(0, 6))) return { s1: leftScore, s2: rightScore };
	return { s1: rightScore, s2: leftScore };
}

function extractCharacters(set: GqlRecord, entrantId: number): CharacterSelection[] {
	const games = (set.games ?? []) as GqlRecord[];
	const seen = new Set<string>();
	const chars: CharacterSelection[] = [];
	for (const game of games) {
		for (const sel of (game.selections ?? []) as GqlRecord[]) {
			if (sel.entrant?.id === entrantId && sel.selectionType === 'CHARACTER') {
				const name = sel.character?.name as string | undefined ?? CHAR_ID_TO_NAME[sel.selectionValue as number];
				if (!name || seen.has(name)) continue;
				seen.add(name);
				const iconUrl = (sel.character?.images as GqlRecord[])?.[0]?.url as string | undefined;
				chars.push({ name, iconUrl });
			}
		}
	}
	return chars;
}

function isSwissEvent(name: string): boolean { return /swiss/i.test(name); }
function isRedemptionEvent(name: string): boolean { return /redemption/i.test(name); }

// ── Data fetchers ────────────────────────────────────────────────────────

interface TournamentInfo {
	name: string;
	startAt: number;
	events: { id: number; name: string }[];
	numEntrants: number;
}

async function fetchTournamentInfo(slug: string): Promise<TournamentInfo | null> {
	const data = await gql<GqlRecord>(TOURNAMENT_QUERY, { slug });
	if (!data?.tournament?.events?.length) return null;
	const events = data.tournament.events.map((e: GqlRecord) => ({ id: e.id as number, name: e.name as string }));
	const maxEntrants = Math.max(...data.tournament.events.map((e: GqlRecord) => e.numEntrants as number));
	return { name: data.tournament.name as string, startAt: data.tournament.startAt as number, events, numEntrants: maxEntrants };
}

async function fetchAllSets(eventId: number): Promise<GqlRecord[]> {
	const all: GqlRecord[] = [];
	let page = 1;
	while (true) {
		const data = await gql<GqlRecord>(SETS_QUERY, { eventId, page, perPage: 20 });
		if (!data) break;
		const paged = (data.event as GqlRecord)?.sets;
		if (!paged) break;
		all.push(...(paged.nodes as GqlRecord[]));
		if (page >= paged.pageInfo.totalPages) break;
		page++;
	}
	return all;
}

async function fetchStandings(eventId: number): Promise<{ playerId: string; gamerTag: string; placement: number }[]> {
	const results: { playerId: string; gamerTag: string; placement: number }[] = [];
	let page = 1;
	while (true) {
		const data = await gql<GqlRecord>(STANDINGS_QUERY, { eventId, page, perPage: 50 });
		if (!data) break;
		const standings = (data.event as GqlRecord)?.standings;
		if (!standings?.nodes?.length) break;
		for (const node of standings.nodes as GqlRecord[]) {
			const playerId = node.entrant?.participants?.[0]?.player?.id;
			const gamerTag = node.entrant?.participants?.[0]?.player?.gamerTag;
			if (playerId && node.placement) {
				results.push({ playerId: String(playerId), gamerTag: gamerTag ?? '', placement: node.placement as number });
			}
		}
		if (page >= standings.pageInfo.totalPages) break;
		page++;
	}
	return results;
}

// ── Cache ────────────────────────────────────────────────────────────────

const CACHE_FILE = new URL('./.alltime-cache.json', import.meta.url).pathname;

interface CachedTournament {
	info: TournamentInfo;
	sets: { set: GqlRecord; isRedemption: boolean }[];
	standings: { eventId: number; eventName: string; standings: { playerId: string; gamerTag: string; placement: number }[] }[];
}

let cache: Record<string, CachedTournament> = {};
if (existsSync(CACHE_FILE)) {
	cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
	console.log(`Loaded cache: ${Object.keys(cache).length} tournaments`);
}

function saveCache() {
	writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// ── Merge map ────────────────────────────────────────────────────────────

async function getMergeMap(): Promise<Record<string, string>> {
	const data = await redis.get<string>('league:merges');
	if (!data) return {};
	return typeof data === 'string' ? JSON.parse(data) : data as unknown as Record<string, string>;
}

// ── Main import ──────────────────────────────────────────────────────────

async function main() {
	const configs = getAllTimeEvents();
	const weightMap = new Map(configs.map(c => [c.slug, c.weight]));
	const singlesOnly = new Set(configs.filter(c => c.singlesOnly).map(c => c.slug));
	const mergeMap = await getMergeMap();

	console.log(`\nImporting ${configs.length} tournaments for All-Time season...`);
	console.log(`Merge map: ${Object.keys(mergeMap).length} entries\n`);

	const allTags = new Map<string, Set<string>>();
	const events: LeagueEvent[] = [];
	const allMatches: LeagueMatch[] = [];

	for (let idx = 0; idx < configs.length; idx++) {
		const { slug, weight } = configs[idx];
		const label = `[${idx + 1}/${configs.length}]`;

		if (cache[slug]) {
			const cached = cache[slug];
			console.log(`${label} ${cached.info.name} (cached)`);

			const eventNumber = parseInt(slug.match(/(\d+)/)?.[1] ?? '0', 10);
			const dateStr = new Date(cached.info.startAt * 1000).toISOString().split('T')[0];

			let eventsToProcess = cached.info.events;
			if (singlesOnly.has(slug)) {
				const filtered = eventsToProcess.filter(e => /singles/i.test(e.name));
				if (filtered.length) eventsToProcess = filtered;
			}

			const entrantMap = new Map<number, { playerId: string; gamerTag: string }>();
			for (const { set } of cached.sets) {
				for (const slot of (set.slots ?? []) as GqlRecord[]) {
					const entrantId = slot.entrant?.id as number | undefined;
					const playerId = slot.entrant?.participants?.[0]?.player?.id as number | undefined;
					const tag = slot.entrant?.participants?.[0]?.player?.gamerTag as string | undefined;
					if (entrantId && playerId && tag) {
						entrantMap.set(entrantId, { playerId: String(playerId), gamerTag: tag });
						addTag(allTags, String(playerId), tag);
					}
				}
			}

			const eventMatches = buildMatches(cached.sets, slug, eventNumber, dateStr, entrantMap, weight);
			allMatches.push(...eventMatches);

			const placements = buildPlacements(cached.standings, eventsToProcess, entrantMap, mergeMap);
			events.push({ slug, name: cached.info.name, date: dateStr, eventNumber, entrantCount: cached.info.numEntrants, placements, weight: weight < 1 ? weight : undefined });
			continue;
		}

		console.log(`${label} Fetching ${slug}...`);
		const info = await fetchTournamentInfo(slug);
		if (!info) { console.log(`  Skipped — not found`); continue; }

		let eventsToProcess = info.events;
		if (singlesOnly.has(slug)) {
			const filtered = eventsToProcess.filter(e => /singles/i.test(e.name));
			if (filtered.length) eventsToProcess = filtered;
		}

		console.log(`  ${info.name} — ${info.numEntrants} entrants, ${eventsToProcess.length} events`);

		const setsWithSource: { set: GqlRecord; isRedemption: boolean }[] = [];
		for (const evt of eventsToProcess) {
			const isRedemption = /redemption/i.test(evt.name);
			const eventSets = await fetchAllSets(evt.id);
			for (const s of eventSets) setsWithSource.push({ set: s, isRedemption });
		}

		const standingsData: CachedTournament['standings'] = [];
		for (const evt of eventsToProcess) {
			const standings = await fetchStandings(evt.id);
			standingsData.push({ eventId: evt.id, eventName: evt.name, standings });
		}

		cache[slug] = { info, sets: setsWithSource, standings: standingsData };
		saveCache();

		const eventNumber = parseInt(slug.match(/(\d+)/)?.[1] ?? '0', 10);
		const dateStr = new Date(info.startAt * 1000).toISOString().split('T')[0];

		const entrantMap = new Map<number, { playerId: string; gamerTag: string }>();
		for (const { set } of setsWithSource) {
			for (const slot of (set.slots ?? []) as GqlRecord[]) {
				const entrantId = slot.entrant?.id as number | undefined;
				const playerId = slot.entrant?.participants?.[0]?.player?.id as number | undefined;
				const tag = slot.entrant?.participants?.[0]?.player?.gamerTag as string | undefined;
				if (entrantId && playerId && tag) {
					entrantMap.set(entrantId, { playerId: String(playerId), gamerTag: tag });
					addTag(allTags, String(playerId), tag);
				}
			}
		}

		const eventMatches = buildMatches(setsWithSource, slug, eventNumber, dateStr, entrantMap, weight);
		allMatches.push(...eventMatches);

		const placements = buildPlacements(standingsData, eventsToProcess, entrantMap, mergeMap);
		events.push({ slug, name: info.name, date: dateStr, eventNumber, entrantCount: info.numEntrants, placements, weight: weight < 1 ? weight : undefined });

		console.log(`  ${eventMatches.length} matches, ${entrantMap.size} players`);
	}

	// Sort events chronologically
	events.sort((a, b) => a.date.localeCompare(b.date) || a.eventNumber - b.eventNumber);

	// Apply merges
	if (Object.keys(mergeMap).length > 0) {
		applyMerges(allMatches, events, allTags, mergeMap);
		console.log(`\nApplied ${Object.keys(mergeMap).length} player merge(s)`);
	}

	// Single-pass TrueSkill (single pass lets ratings naturally track improvement over time)
	console.log(`\nComputing ratings across ${events.length} events, ${allMatches.length} matches...`);
	const result = computeRatings(events, allMatches, allTags);
	console.log(`Complete: ${result.ratings.size} players`);

	// Build season
	const season: LeagueSeason = {
		id: 0,
		name: 'All-Time',
		startDate: events[0]?.date ?? '',
		endDate: events[events.length - 1]?.date ?? '',
		events,
		players: Object.fromEntries(result.players),
		matches: allMatches
	};

	// Save to Redis (split matches into separate key if too large)
	console.log(`\nSaving to Redis (season 0)...`);
	const full = JSON.stringify(season);
	if (full.length > 5 * 1024 * 1024) {
		const { matches, ...rest } = season;
		await Promise.all([
			redis.set('league:season:0', JSON.stringify({ ...rest, matches: [] })),
			redis.set('league:season:0:matches', JSON.stringify(matches))
		]);
		console.log(`Split save: season ${(JSON.stringify(rest).length / 1024 / 1024).toFixed(1)}MB + matches ${(JSON.stringify(matches).length / 1024 / 1024).toFixed(1)}MB`);
	} else {
		await redis.set('league:season:0', full);
		await redis.del('league:season:0:matches');
	}

	// Update season index
	const indexRaw = await redis.get<string>('league:seasons');
	let index: { id: number; name: string }[] = [];
	if (indexRaw) {
		index = typeof indexRaw === 'string' ? JSON.parse(indexRaw) : indexRaw as unknown as { id: number; name: string }[];
	}
	if (!index.some(s => s.id === 0)) {
		index.unshift({ id: 0, name: 'All-Time' });
		await redis.set('league:seasons', JSON.stringify(index));
	}

	console.log(`\nDone! ${events.length} events, ${result.players.size} players, ${allMatches.length} matches`);

	// Print top 20
	const ranked = [...result.players.values()]
		.sort((a, b) => b.points - a.points)
		.slice(0, 20);
	console.log('\nTop 20 All-Time:');
	for (let i = 0; i < ranked.length; i++) {
		console.log(`  ${String(i + 1).padStart(2)}. ${ranked[i].gamerTag.padEnd(20)} ${ranked[i].points} pts`);
	}
}

// ── Build helpers ────────────────────────────────────────────────────────

function addTag(allTags: Map<string, Set<string>>, playerId: string, tag: string) {
	const existing = allTags.get(playerId) ?? new Set();
	existing.add(tag);
	allTags.set(playerId, existing);
}

function buildMatches(
	setsWithSource: { set: GqlRecord; isRedemption: boolean }[],
	slug: string, eventNumber: number, dateStr: string,
	entrantMap: Map<number, { playerId: string; gamerTag: string }>,
	weight: number
): LeagueMatch[] {
	const completedSets = setsWithSource.filter(({ set: s }) => s.winnerId && s.slots?.length >= 2);
	const matches: LeagueMatch[] = [];

	for (const { set, isRedemption } of completedSets) {
		const slots = set.slots as GqlRecord[];
		const entrant1Id = slots[0]?.entrant?.id as number | undefined;
		const entrant2Id = slots[1]?.entrant?.id as number | undefined;
		const e1 = entrant1Id ? entrantMap.get(entrant1Id) : undefined;
		const e2 = entrant2Id ? entrantMap.get(entrant2Id) : undefined;
		if (!e1 || !e2 || !entrant1Id || !entrant2Id) continue;

		const winnerPlayer = entrantMap.get(set.winnerId as number);
		if (!winnerPlayer) continue;

		const { phase, roundLabel } = classifySet(set, isRedemption);
		const dq = isDQSet(set.displayScore as string | null);
		const { s1, s2 } = parseScore(set.displayScore as string | null, e1.gamerTag);
		const p1Chars = extractCharacters(set, entrant1Id);
		const p2Chars = extractCharacters(set, entrant2Id);

		matches.push({
			eventSlug: slug, eventNumber,
			player1Id: e1.playerId, player1Tag: e1.gamerTag,
			player2Id: e2.playerId, player2Tag: e2.gamerTag,
			winnerId: winnerPlayer.playerId,
			player1Score: s1, player2Score: s2,
			player1Characters: p1Chars.length ? p1Chars : undefined,
			player2Characters: p2Chars.length ? p2Chars : undefined,
			isDQ: dq || undefined,
			phase, roundLabel, date: dateStr,
			weight: weight < 1 ? weight : undefined
		});
	}
	return matches;
}

function buildPlacements(
	standingsData: CachedTournament['standings'],
	eventsToProcess: { id: number; name: string }[],
	entrantMap: Map<number, { playerId: string; gamerTag: string }>,
	mergeMap: Record<string, string>
): LeaguePlacement[] {
	const placements = new Map<string, LeaguePlacement>();

	const mainEvents = eventsToProcess.filter(e => !isSwissEvent(e.name) && !isRedemptionEvent(e.name));
	const redemptionEvents = eventsToProcess.filter(e => isRedemptionEvent(e.name));

	let mainBracketSize = 0;
	for (const evt of mainEvents) {
		const sd = standingsData.find(s => s.eventId === evt.id);
		if (!sd) continue;
		for (const s of sd.standings) {
			const pid = mergeMap[s.playerId] ?? s.playerId;
			if (!placements.has(pid) || s.placement < placements.get(pid)!.placement) {
				placements.set(pid, { playerId: pid, gamerTag: s.gamerTag, placement: s.placement });
			}
		}
		mainBracketSize = Math.max(mainBracketSize, sd.standings.length);
	}

	for (const evt of redemptionEvents) {
		const sd = standingsData.find(s => s.eventId === evt.id);
		if (!sd) continue;
		for (const s of sd.standings) {
			const pid = mergeMap[s.playerId] ?? s.playerId;
			const adjusted = s.placement + mainBracketSize;
			if (!placements.has(pid) || adjusted < placements.get(pid)!.placement) {
				placements.set(pid, { playerId: pid, gamerTag: s.gamerTag, placement: adjusted });
			}
		}
	}

	for (const [, p] of entrantMap) {
		const pid = mergeMap[p.playerId] ?? p.playerId;
		if (!placements.has(pid)) {
			placements.set(pid, { playerId: pid, gamerTag: p.gamerTag, placement: placements.size + 1 });
		}
	}

	return [...placements.values()].sort((a, b) => a.placement - b.placement);
}

function applyMerges(
	matches: LeagueMatch[], events: LeagueEvent[],
	allTags: Map<string, Set<string>>, mergeMap: Record<string, string>
) {
	const resolve = (id: string): string => mergeMap[id] ?? id;
	for (const m of matches) {
		m.player1Id = resolve(m.player1Id);
		m.player2Id = resolve(m.player2Id);
		m.winnerId = resolve(m.winnerId);
	}
	for (const evt of events) {
		const merged = new Map<string, LeaguePlacement>();
		for (const p of evt.placements) {
			const resolvedId = resolve(p.playerId);
			if (!merged.has(resolvedId) || p.placement < merged.get(resolvedId)!.placement) {
				merged.set(resolvedId, { ...p, playerId: resolvedId });
			}
		}
		evt.placements = [...merged.values()].sort((a, b) => a.placement - b.placement);
	}
	for (const [secondaryId, primaryId] of Object.entries(mergeMap)) {
		const secondaryTags = allTags.get(secondaryId);
		if (secondaryTags) {
			const primaryTags = allTags.get(primaryId) ?? new Set();
			for (const t of secondaryTags) primaryTags.add(t);
			allTags.set(primaryId, primaryTags);
			allTags.delete(secondaryId);
		}
	}
}

function getLatestTag(matches: LeagueMatch[], playerId: string, tags?: Set<string>): string {
	if (!tags?.size) return 'Unknown';
	if (tags.size === 1) return [...tags][0];
	for (let i = matches.length - 1; i >= 0; i--) {
		const m = matches[i];
		if (m.player1Id === playerId) return m.player1Tag;
		if (m.player2Id === playerId) return m.player2Tag;
	}
	return [...tags][0];
}

// ── TrueSkill computation ────────────────────────────────────────────────

function computeRatings(
	events: LeagueEvent[], allMatches: LeagueMatch[],
	allTags: Map<string, Set<string>>,
	initialRatings?: Map<string, Rating>, resetSigma?: number
) {
	const players = new Map<string, LeaguePlayer>();
	const ratings = new Map<string, Rating>();
	if (initialRatings && resetSigma) {
		for (const [id, r] of initialRatings) {
			ratings.set(id, createRating(r.mu, resetSigma));
		}
	}

	for (const evt of events) {
		const evtMatches = allMatches.filter(m => m.eventSlug === evt.slug);
		const weight = evt.weight ?? 1.0;
		const eventPlayerIds = new Set<string>();

		for (const match of evtMatches) {
			if (!ratings.has(match.player1Id)) ratings.set(match.player1Id, createRating());
			if (!ratings.has(match.player2Id)) ratings.set(match.player2Id, createRating());
			eventPlayerIds.add(match.player1Id);
			eventPlayerIds.add(match.player2Id);
			if (match.isDQ) {
				match.p1Delta = 0;
				match.p2Delta = 0;
				continue;
			}

			const r1 = ratings.get(match.player1Id)!;
			const r2 = ratings.get(match.player2Id)!;
			const p1Before = ratingToPoints(r1);
			const p2Before = ratingToPoints(r2);

			const rateFn = weight < 1.0
				? (w: Rating, l: Rating) => rate1v1Weighted(w, l, weight)
				: rate1v1;
			const result = match.winnerId === match.player1Id ? rateFn(r1, r2) : rateFn(r2, r1);

			if (match.winnerId === match.player1Id) {
				ratings.set(match.player1Id, result.winner);
				ratings.set(match.player2Id, result.loser);
			} else {
				ratings.set(match.player2Id, result.winner);
				ratings.set(match.player1Id, result.loser);
			}
			match.p1Delta = ratingToPoints(ratings.get(match.player1Id)!) - p1Before;
			match.p2Delta = ratingToPoints(ratings.get(match.player2Id)!) - p2Before;
		}

		const ranked = [...ratings.entries()]
			.map(([id, r]) => ({ id, points: ratingToPoints(r), sigma: r.sigma }))
			.sort((a, b) => b.points - a.points || a.sigma - b.sigma);

		for (const id of eventPlayerIds) {
			const r = ratings.get(id)!;
			const tags = allTags.get(id);
			const latestTag = getLatestTag(allMatches, id, tags);
			const aliases = tags ? [...tags].filter(t => t !== latestTag) : [];
			const rankIdx = ranked.findIndex(x => x.id === id);
			let player = players.get(id);
			if (!player) {
				player = { id, gamerTag: latestTag, aliases, mu: r.mu, sigma: r.sigma, points: ratingToPoints(r), rankHistory: [] };
				players.set(id, player);
			}
			player.mu = r.mu;
			player.sigma = r.sigma;
			player.points = ratingToPoints(r);
			player.gamerTag = latestTag;
			player.aliases = aliases;
			player.rankHistory.push({
				eventSlug: evt.slug, eventNumber: evt.eventNumber,
				rank: rankIdx + 1, points: ratingToPoints(r), mu: r.mu, sigma: r.sigma
			});
		}
	}
	return { players, ratings };
}

// ── Run ──────────────────────────────────────────────────────────────────

main().catch(e => { console.error(e); process.exit(1); });
