import { gql, TOURNAMENT_QUERY } from '$lib/server/startgg';
import { createRating, rate1v1, ratingToPoints } from '$lib/server/trueskill';
import { getLeagueSeason, saveLeagueSeason, getMergeMap } from '$lib/server/league-store';
import type { MergeMap } from '$lib/server/league-store';
import type { LeagueSeason, LeagueEvent, LeaguePlayer, LeagueMatch, LeaguePlacement, CharacterSelection } from '$lib/types/league';
import type { Rating } from '$lib/server/trueskill';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GqlRecord = Record<string, any>;

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

const LEAGUE_SETS_QUERY = `
query LeagueEventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { totalPages }
      nodes {
        id
        round
        displayScore
        winnerId
        fullRoundText
        phaseGroup { bracketType }
        slots {
          seed { seedNum }
          entrant {
            id
            name
            participants {
              player { id gamerTag }
            }
          }
        }
        games {
          winnerId
          selections {
            entrant { id }
            selectionType
            selectionValue
            character {
              id
              name
              images(type: "stockIcon") { url }
            }
          }
        }
      }
    }
  }
}`;

const API_DELAY = 800;
const SETS_PER_PAGE = 50;

async function fetchLeagueSets(eventId: number): Promise<GqlRecord[]> {
	const all: GqlRecord[] = [];
	let page = 1;
	while (true) {
		const data = await gql<GqlRecord>(LEAGUE_SETS_QUERY, { eventId, page, perPage: SETS_PER_PAGE }, { delay: API_DELAY });
		if (!data) break;
		const paged = (data.event as GqlRecord)?.sets;
		if (!paged) break;
		all.push(...(paged.nodes as GqlRecord[]));
		if (page >= paged.pageInfo.totalPages) break;
		page++;
	}
	return all;
}

interface TournamentData {
	id: number;
	name: string;
	startAt: number;
	events: { id: number; name: string; slug: string; numEntrants: number }[];
}

interface TournamentEventInfo {
	tournamentName: string;
	startAt: number;
	events: { id: number; name: string }[];
	numEntrants: number;
}

async function fetchTournamentEvents(slug: string): Promise<TournamentEventInfo | null> {
	const data = await gql<{ tournament: TournamentData }>(TOURNAMENT_QUERY, { slug });
	if (!data?.tournament?.events?.length) return null;
	const events = data.tournament.events.map((e) => ({ id: e.id, name: e.name }));
	const maxEntrants = Math.max(...data.tournament.events.map((e) => e.numEntrants));
	return { tournamentName: data.tournament.name, startAt: data.tournament.startAt, events, numEntrants: maxEntrants };
}

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
	if (!displayScore) return false;
	return displayScore.toUpperCase().includes('DQ');
}

function parseScore(displayScore: string | null, entrant1Name: string): { s1: number; s2: number } {
	if (!displayScore) return { s1: 0, s2: 0 };
	if (isDQSet(displayScore)) return { s1: 0, s2: 0 };
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
				const name = sel.character?.name as string | undefined
					?? CHAR_ID_TO_NAME[sel.selectionValue as number];
				if (!name || seen.has(name)) continue;
				seen.add(name);
				const iconUrl = (sel.character?.images as GqlRecord[])?.[0]?.url as string | undefined;
				chars.push({ name, iconUrl });
			}
		}
	}
	return chars;
}

function derivePlacements(sets: GqlRecord[], entrantMap: Map<number, { playerId: string; gamerTag: string }>): LeaguePlacement[] {
	const playerWins = new Map<string, number>();
	const playerLosses = new Map<string, number>();
	for (const set of sets) {
		if (!set.winnerId || !set.slots?.length) continue;
		for (const slot of set.slots) {
			const entrantId = slot.entrant?.id as number | undefined;
			if (!entrantId) continue;
			const player = entrantMap.get(entrantId);
			if (!player) continue;
			if (entrantId === set.winnerId) playerWins.set(player.playerId, (playerWins.get(player.playerId) ?? 0) + 1);
			else playerLosses.set(player.playerId, (playerLosses.get(player.playerId) ?? 0) + 1);
		}
	}
	const allPlayerIds = new Set([...playerWins.keys(), ...playerLosses.keys()]);
	const entries = [...allPlayerIds].map((pid) => {
		let tag = '';
		for (const [, p] of entrantMap) { if (p.playerId === pid) { tag = p.gamerTag; break; } }
		return { playerId: pid, gamerTag: tag, wins: playerWins.get(pid) ?? 0, losses: playerLosses.get(pid) ?? 0 };
	});
	entries.sort((a, b) => b.wins !== a.wins ? b.wins - a.wins : a.losses - b.losses);
	return entries.map((e, i) => ({ playerId: e.playerId, gamerTag: e.gamerTag, placement: i + 1 }));
}

function applyMerges(
	matches: LeagueMatch[],
	events: LeagueEvent[],
	allTags: Map<string, Set<string>>,
	mergeMap: MergeMap
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

export async function importSeason(
	seasonId: number,
	seasonName: string,
	startDate: string,
	endDate: string,
	tournamentSlugs: string[],
	onProgress?: (msg: string) => void,
	forceRefetch = false
): Promise<LeagueSeason> {
	const log = onProgress ?? console.log;

	const existing = await getLeagueSeason(seasonId);
	const existingEventSlugs = new Set(existing?.events.map((e) => e.slug) ?? []);
	const existingMatchesByEvent = new Map<string, LeagueMatch[]>();
	if (existing) {
		for (const m of existing.matches) {
			const arr = existingMatchesByEvent.get(m.eventSlug) ?? [];
			arr.push(m);
			existingMatchesByEvent.set(m.eventSlug, arr);
		}
	}

	const allTags = new Map<string, Set<string>>();
	const events: LeagueEvent[] = [];
	const allMatches: LeagueMatch[] = [];

	for (const slug of tournamentSlugs) {
		if (!forceRefetch && existingEventSlugs.has(slug)) {
			log(`Using cached data for ${slug}`);
			const cachedEvent = existing!.events.find((e) => e.slug === slug)!;
			events.push(cachedEvent);
			const cachedMatches = existingMatchesByEvent.get(slug) ?? [];
			allMatches.push(...cachedMatches);
			for (const m of cachedMatches) {
				addTag(allTags, m.player1Id, m.player1Tag);
				addTag(allTags, m.player2Id, m.player2Tag);
			}
			continue;
		}

		log(`Fetching ${slug}...`);
		const info = await fetchTournamentEvents(slug);
		if (!info) { log(`Skipping ${slug} — not found on StartGG`); continue; }

		const eventNumber = parseInt(slug.match(/(\d+)$/)?.[1] ?? '0', 10);
		const dateStr = new Date(info.startAt * 1000).toISOString().split('T')[0];

		log(`Fetching sets for ${info.tournamentName} (${info.numEntrants} entrants, ${info.events.length} events)...`);
		const setsWithSource: { set: GqlRecord; isRedemption: boolean }[] = [];
		for (const evt of info.events) {
			const isRedemption = /redemption/i.test(evt.name);
			const eventSets = await fetchLeagueSets(evt.id);
			for (const s of eventSets) setsWithSource.push({ set: s, isRedemption });
		}
		if (!setsWithSource.length) { log(`Skipping ${slug} — no sets found`); continue; }

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

		const completedSets = setsWithSource.filter(({ set: s }) => s.winnerId && s.slots?.length >= 2);
		const eventMatches: LeagueMatch[] = [];

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

			eventMatches.push({
				eventSlug: slug, eventNumber,
				player1Id: e1.playerId, player1Tag: e1.gamerTag,
				player2Id: e2.playerId, player2Tag: e2.gamerTag,
				winnerId: winnerPlayer.playerId,
				player1Score: s1, player2Score: s2,
				player1Characters: p1Chars.length ? p1Chars : undefined,
				player2Characters: p2Chars.length ? p2Chars : undefined,
				isDQ: dq || undefined,
				phase, roundLabel, date: dateStr
			});
		}

		allMatches.push(...eventMatches);
		const allSets = setsWithSource.map(({ set }) => set);
		events.push({
			slug, name: info.tournamentName, date: dateStr,
			eventNumber, entrantCount: info.numEntrants,
			placements: derivePlacements(allSets, entrantMap)
		});

		log(`Processed ${info.tournamentName}: ${eventMatches.length} matches, ${entrantMap.size} players`);
	}

	const mergeMap = await getMergeMap();
	if (Object.keys(mergeMap).length > 0) {
		applyMerges(allMatches, events, allTags, mergeMap);
		log(`Applied ${Object.keys(mergeMap).length} player merge(s)`);
	}

	const players = new Map<string, LeaguePlayer>();
	const ratings = new Map<string, Rating>();

	for (const evt of events) {
		const eventMatches = allMatches.filter((m) => m.eventSlug === evt.slug);
		for (const match of eventMatches) {
			if (!ratings.has(match.player1Id)) ratings.set(match.player1Id, createRating());
			if (!ratings.has(match.player2Id)) ratings.set(match.player2Id, createRating());
			const r1 = ratings.get(match.player1Id)!;
			const r2 = ratings.get(match.player2Id)!;
			const result = match.winnerId === match.player1Id ? rate1v1(r1, r2) : rate1v1(r2, r1);
			if (match.winnerId === match.player1Id) {
				ratings.set(match.player1Id, result.winner);
				ratings.set(match.player2Id, result.loser);
			} else {
				ratings.set(match.player2Id, result.winner);
				ratings.set(match.player1Id, result.loser);
			}
		}

		const ranked = [...ratings.entries()]
			.map(([id, r]) => ({ id, points: ratingToPoints(r), sigma: r.sigma }))
			.sort((a, b) => b.points - a.points || a.sigma - b.sigma);

		for (const [id, r] of ratings) {
			const tags = allTags.get(id);
			const latestTag = getLatestTag(allMatches, id, tags);
			const aliases = tags ? [...tags].filter((t) => t !== latestTag) : [];
			const rankIdx = ranked.findIndex((x) => x.id === id);
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

	const season: LeagueSeason = {
		id: seasonId, name: seasonName, startDate, endDate,
		events, players: Object.fromEntries(players), matches: allMatches
	};

	await saveLeagueSeason(season);
	log(`Season ${seasonId} saved: ${events.length} events, ${players.size} players, ${allMatches.length} matches`);
	return season;
}

function addTag(allTags: Map<string, Set<string>>, playerId: string, tag: string) {
	const existing = allTags.get(playerId) ?? new Set();
	existing.add(tag);
	allTags.set(playerId, existing);
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
