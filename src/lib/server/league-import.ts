import { gql, TOURNAMENT_QUERY, fetchAllSets } from '$lib/server/startgg';
import { createRating, rate1v1, ratingToPoints } from '$lib/server/trueskill';
import { saveLeagueSeason } from '$lib/server/league-store';
import type { LeagueSeason, LeagueEvent, LeaguePlayer, LeagueMatch, LeaguePlacement } from '$lib/types/league';
import type { Rating } from '$lib/server/trueskill';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GqlRecord = Record<string, any>;

interface TournamentData {
	id: number;
	name: string;
	startAt: number;
	events: { id: number; name: string; slug: string; numEntrants: number }[];
}

async function fetchTournamentEvent(slug: string): Promise<{ tournamentName: string; startAt: number; eventId: number; eventSlug: string; numEntrants: number } | null> {
	const data = await gql<{ tournament: TournamentData }>(TOURNAMENT_QUERY, { slug });
	if (!data?.tournament?.events?.length) return null;
	const event = data.tournament.events[0];
	return {
		tournamentName: data.tournament.name,
		startAt: data.tournament.startAt,
		eventId: event.id,
		eventSlug: event.slug,
		numEntrants: event.numEntrants
	};
}

function classifySet(set: GqlRecord): { phase: string; roundLabel: string } {
	const fullRoundText = (set.fullRoundText ?? '') as string;
	const bracketType = set.phaseGroup?.bracketType as string | undefined;

	if (bracketType === 'SWISS') {
		return { phase: 'swiss', roundLabel: fullRoundText || `Round ${Math.abs(set.round ?? 0)}` };
	}

	const round = (set.round ?? 0) as number;
	if (round > 0) {
		return { phase: 'winners', roundLabel: fullRoundText || `Winners R${round}` };
	}
	return { phase: 'losers', roundLabel: fullRoundText || `Losers R${Math.abs(round)}` };
}

function parseScore(displayScore: string | null, entrant1Name: string): { s1: number; s2: number } {
	if (!displayScore) return { s1: 0, s2: 0 };
	if (displayScore.toUpperCase().includes('DQ')) return { s1: 0, s2: 0 };

	const parts = displayScore.split(' - ');
	if (parts.length !== 2) return { s1: 0, s2: 0 };

	const left = parts[0].trim();
	const right = parts[1].trim();

	const leftMatch = left.match(/^(.+?)\s+(\d+)$/);
	const rightMatch = right.match(/^(\d+)\s*$/);

	if (!leftMatch || !rightMatch) return { s1: 0, s2: 0 };

	const leftName = leftMatch[1].trim();
	const leftScore = parseInt(leftMatch[2], 10);
	const rightScore = parseInt(rightMatch[1], 10);

	if (leftName.toLowerCase().includes(entrant1Name.toLowerCase().slice(0, 6))) {
		return { s1: leftScore, s2: rightScore };
	}
	return { s1: rightScore, s2: leftScore };
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
			if (entrantId === set.winnerId) {
				playerWins.set(player.playerId, (playerWins.get(player.playerId) ?? 0) + 1);
			} else {
				playerLosses.set(player.playerId, (playerLosses.get(player.playerId) ?? 0) + 1);
			}
		}
	}

	const allPlayerIds = new Set([...playerWins.keys(), ...playerLosses.keys()]);
	const entries = [...allPlayerIds].map((pid) => ({
		playerId: pid,
		gamerTag: '',
		wins: playerWins.get(pid) ?? 0,
		losses: playerLosses.get(pid) ?? 0
	}));

	for (const e of entries) {
		for (const [, p] of entrantMap) {
			if (p.playerId === e.playerId) { e.gamerTag = p.gamerTag; break; }
		}
	}

	entries.sort((a, b) => {
		if (b.wins !== a.wins) return b.wins - a.wins;
		return a.losses - b.losses;
	});

	return entries.map((e, i) => ({
		playerId: e.playerId,
		gamerTag: e.gamerTag,
		placement: i + 1
	}));
}

export async function importSeason(
	seasonId: number,
	seasonName: string,
	startDate: string,
	endDate: string,
	tournamentSlugs: string[],
	onProgress?: (msg: string) => void
): Promise<LeagueSeason> {
	const log = onProgress ?? console.log;
	const gamerTags = new Map<string, string>();
	const events: LeagueEvent[] = [];
	const allMatches: LeagueMatch[] = [];

	for (const slug of tournamentSlugs) {
		log(`Fetching ${slug}...`);
		const info = await fetchTournamentEvent(slug);
		if (!info) {
			log(`Skipping ${slug} — not found on StartGG`);
			continue;
		}

		const eventNumber = parseInt(slug.match(/(\d+)$/)?.[1] ?? '0', 10);
		const dateStr = new Date(info.startAt * 1000).toISOString().split('T')[0];

		log(`Fetching sets for ${info.tournamentName} (${info.numEntrants} entrants)...`);
		const sets = await fetchAllSets(info.eventId);
		if (!sets.length) {
			log(`Skipping ${slug} — no sets found`);
			continue;
		}

		const entrantMap = new Map<number, { playerId: string; gamerTag: string }>();
		for (const set of sets) {
			for (const slot of (set.slots ?? []) as GqlRecord[]) {
				const entrantId = slot.entrant?.id as number | undefined;
				const playerId = slot.entrant?.participants?.[0]?.player?.id as number | undefined;
				const tag = slot.entrant?.participants?.[0]?.player?.gamerTag as string | undefined;
				if (entrantId && playerId && tag) {
					entrantMap.set(entrantId, { playerId: String(playerId), gamerTag: tag });
					gamerTags.set(String(playerId), tag);
				}
			}
		}

		const completedSets = sets.filter((s: GqlRecord) => s.winnerId && s.slots?.length >= 2);
		const eventMatches: LeagueMatch[] = [];

		for (const set of completedSets) {
			const slots = set.slots as GqlRecord[];
			const e1 = entrantMap.get(slots[0]?.entrant?.id);
			const e2 = entrantMap.get(slots[1]?.entrant?.id);
			if (!e1 || !e2) continue;

			const winnerId = set.winnerId as number;
			const winnerPlayer = entrantMap.get(winnerId);
			if (!winnerPlayer) continue;

			const { phase, roundLabel } = classifySet(set);
			const { s1, s2 } = parseScore(set.displayScore as string | null, e1.gamerTag);

			eventMatches.push({
				eventSlug: slug,
				eventNumber,
				player1Id: e1.playerId,
				player1Tag: e1.gamerTag,
				player2Id: e2.playerId,
				player2Tag: e2.gamerTag,
				winnerId: winnerPlayer.playerId,
				player1Score: s1,
				player2Score: s2,
				phase,
				roundLabel,
				date: dateStr
			});
		}

		allMatches.push(...eventMatches);
		const placements = derivePlacements(completedSets as GqlRecord[], entrantMap);

		events.push({
			slug,
			name: info.tournamentName,
			date: dateStr,
			eventNumber,
			entrantCount: info.numEntrants,
			placements
		});

		log(`Processed ${info.tournamentName}: ${eventMatches.length} matches, ${entrantMap.size} players`);
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

			const result = match.winnerId === match.player1Id
				? rate1v1(r1, r2)
				: rate1v1(r2, r1);

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
			const tag = gamerTags.get(id) ?? 'Unknown';
			const rankIdx = ranked.findIndex((x) => x.id === id);
			let player = players.get(id);
			if (!player) {
				player = {
					id,
					gamerTag: tag,
					mu: r.mu,
					sigma: r.sigma,
					points: ratingToPoints(r),
					rankHistory: []
				};
				players.set(id, player);
			}
			player.mu = r.mu;
			player.sigma = r.sigma;
			player.points = ratingToPoints(r);
			player.gamerTag = tag;
			player.rankHistory.push({
				eventSlug: evt.slug,
				eventNumber: evt.eventNumber,
				rank: rankIdx + 1,
				points: ratingToPoints(r),
				mu: r.mu,
				sigma: r.sigma
			});
		}
	}

	const season: LeagueSeason = {
		id: seasonId,
		name: seasonName,
		startDate,
		endDate,
		events,
		players: Object.fromEntries(players),
		matches: allMatches
	};

	await saveLeagueSeason(season);
	log(`Season ${seasonId} saved: ${events.length} events, ${players.size} players, ${allMatches.length} matches`);
	return season;
}
