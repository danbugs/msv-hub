import type { RequestHandler } from '@sveltejs/kit';
import { getActiveTournament, saveTournament } from '$lib/server/store';

/** PUT — set stream match for a bracket */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.brackets) return Response.json({ error: 'No brackets' }, { status: 400 });

	const body = await request.json();
	const { bracketName, matchId } = body as { bracketName: 'main' | 'redemption'; matchId: string };
	if (!bracketName || !matchId) {
		return Response.json({ error: 'bracketName and matchId are required' }, { status: 400 });
	}

	const bracket = tournament.brackets[bracketName];
	if (!bracket) return Response.json({ error: `Bracket "${bracketName}" not found` }, { status: 404 });

	const targetMatch = bracket.matches.find((m) => m.id === matchId);
	if (!targetMatch) return Response.json({ error: 'Match not found' }, { status: 404 });

	const streamStn = tournament.settings.streamStation;
	const half = Math.floor(tournament.settings.numStations / 2);

	// Collect all used stations across both brackets (excluding stream station)
	const allMatches = [...tournament.brackets.main.matches, ...tournament.brackets.redemption.matches];
	const usedStations = new Set(
		allMatches
			.filter((m) => m.station !== undefined && m.station !== streamStn && !m.winnerId)
			.map((m) => m.station!)
	);

	// Clear stream from ALL bracket matches. If a match had the stream station,
	// assign it a regular station from its bracket's range.
	for (const [bName, b] of Object.entries(tournament.brackets) as ['main' | 'redemption', typeof bracket][]) {
		const startStn = bName === 'redemption' ? half + 1 : 1;
		const endStn = bName === 'redemption' ? tournament.settings.numStations : half;
		for (const m of b.matches) {
			if (m.isStream) {
				m.isStream = false;
				if (m.station === streamStn && !m.winnerId) {
					// Find next available station in this bracket's range
					for (let s = startStn; s <= endStn; s++) {
						if (s !== streamStn && !usedStations.has(s)) {
							m.station = s;
							usedStations.add(s);
							break;
						}
					}
				}
			}
		}
	}

	// Set new stream match with stream station
	targetMatch.station = streamStn;
	targetMatch.isStream = true;

	await saveTournament(tournament);
	return Response.json({ ok: true });
};
