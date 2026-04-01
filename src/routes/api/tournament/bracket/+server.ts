import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { reportBracketMatch } from '$lib/server/swiss';
import { reportBracketMatch as reportBracketMatchToStartGG } from '$lib/server/startgg-reporter';

/** PATCH — report a bracket match result */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });
	if (!tournament.brackets) return Response.json({ error: 'No brackets generated' }, { status: 400 });

	const body = await request.json();
	const { bracketName, matchId, winnerId, topCharacters, bottomCharacters, topScore, bottomScore, gameWinners, isDQ } = body as {
		bracketName: 'main' | 'redemption';
		matchId: string;
		winnerId: string;
		topCharacters?: string[];
		bottomCharacters?: string[];
		topScore?: number;
		bottomScore?: number;
		gameWinners?: ('top' | 'bottom')[];
		isDQ?: boolean;
	};

	if (!bracketName || !matchId || !winnerId) {
		return Response.json({ error: 'bracketName, matchId, and winnerId are required' }, { status: 400 });
	}

	const bracket = tournament.brackets[bracketName];
	if (!bracket) return Response.json({ error: `Bracket "${bracketName}" not found` }, { status: 404 });

	try {
		const otherName = bracketName === 'main' ? 'redemption' : 'main';
		const otherBracket = tournament.brackets[otherName];
		const otherHasStream = otherBracket?.matches.some((m) => m.isStream && !m.winnerId) ?? false;
		tournament.brackets[bracketName] = reportBracketMatch(
			bracket, matchId, winnerId, topCharacters, bottomCharacters, topScore, bottomScore,
			tournament.settings, bracketName, otherHasStream, gameWinners, isDQ
		);
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 400 });
	}

	// Check if all bracket matches are complete
	const allComplete = Object.values(tournament.brackets).every((b) =>
		b.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).every((m) => m.winnerId)
	);

	if (allComplete) tournament.phase = 'completed';

	// Report to StartGG (queued if split not yet confirmed).
	const reportedMatch = tournament.brackets[bracketName].matches.find((m) => m.id === matchId)!;
	const sgResult = await reportBracketMatchToStartGG(tournament, bracketName, reportedMatch).catch(
		(e) => ({ ok: false, queued: false, error: e instanceof Error ? e.message : String(e) })
	);

	// Save directly. Bracket reports should not be concurrent for the same match
	// (UI has per-match lock). Player advancement is deterministic from the match result,
	// so saving the full tournament state is safe.
	await saveTournament(tournament);
	return Response.json({
		ok: true,
		bracket: tournament.brackets[bracketName],
		tournamentComplete: allComplete,
		startgg: {
			ok: sgResult.ok,
			queued: sgResult.queued ?? false,
			error: sgResult.ok ? undefined : sgResult.error
		}
	});
};
