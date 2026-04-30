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

	// If target is already stream, toggle it OFF (remove stream from all brackets)
	if (targetMatch.isStream) {
		const streamStn = tournament.settings.streamStation;
		const allRegular = Array.from({ length: tournament.settings.numStations }, (_, i) => i + 1)
			.filter((s) => s !== streamStn);
		const halfIdx = Math.floor(allRegular.length / 2);
		const pool = bracketName === 'redemption' ? allRegular.slice(halfIdx) : allRegular.slice(0, halfIdx);
		const usedStations = new Set(
			[...tournament.brackets.main.matches, ...(tournament.brackets.redemption?.matches ?? [])]
				.filter((m) => m.station !== undefined && m.station !== streamStn && !m.winnerId && m.id !== targetMatch.id)
				.map((m) => m.station!)
		);
		targetMatch.isStream = false;
		for (const s of pool) {
			if (!usedStations.has(s)) { targetMatch.station = s; break; }
		}
		await saveTournament(tournament);
		return Response.json({ ok: true, removed: true });
	}

	const streamStn = tournament.settings.streamStation;

	// Build station pools same as initial assignment (exclude stream, split evenly)
	const allRegular = Array.from({ length: tournament.settings.numStations }, (_, i) => i + 1)
		.filter((s) => s !== streamStn);
	const halfIdx = Math.floor(allRegular.length / 2);
	const mainPool = new Set(allRegular.slice(0, halfIdx));
	const redemptionPool = new Set(allRegular.slice(halfIdx));

	// Collect all used stations across both brackets (excluding stream station)
	const allMatches = [...tournament.brackets.main.matches, ...(tournament.brackets.redemption?.matches ?? [])];
	const usedStations = new Set(
		allMatches
			.filter((m) => m.station !== undefined && m.station !== streamStn && !m.winnerId)
			.map((m) => m.station!)
	);

	// Swap stations: old stream match gets the new stream match's station, new stream match gets stream station
	const targetOldStation = targetMatch.station;

	for (const b of Object.values(tournament.brackets).filter(Boolean)) {
		for (const m of b!.matches) {
			if (m.isStream && m.id !== targetMatch.id) {
				m.isStream = false;
				// Give the old stream match the new stream match's old station
				if (m.station === streamStn && !m.winnerId && targetOldStation !== undefined) {
					m.station = targetOldStation;
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
