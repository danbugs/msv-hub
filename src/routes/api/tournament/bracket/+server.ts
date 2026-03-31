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
	const { bracketName, matchId, winnerId, topCharacters, bottomCharacters, topScore, bottomScore, gameWinners } = body as {
		bracketName: 'main' | 'redemption';
		matchId: string;
		winnerId: string;
		topCharacters?: string[];
		bottomCharacters?: string[];
		topScore?: number;
		bottomScore?: number;
		gameWinners?: ('top' | 'bottom')[];
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
			tournament.settings, bracketName, otherHasStream, gameWinners
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

	// Safe merge: re-load fresh state and apply ONLY this match's changes.
	// Don't re-run reportBracketMatch (which would double-advance players).
	// Instead, apply the match result + advancements field by field.
	const fresh = await getActiveTournament();
	if (fresh?.brackets) {
		const freshBracket = fresh.brackets[bracketName];
		if (freshBracket) {
			const updatedBracket = tournament.brackets![bracketName];
			const updatedMatch = updatedBracket.matches.find((m) => m.id === matchId);

			// Apply match result fields to fresh state
			const fm = freshBracket.matches.find((m) => m.id === matchId);
			if (fm && updatedMatch) {
				fm.winnerId = updatedMatch.winnerId;
				fm.loserId = updatedMatch.loserId;
				fm.topScore = updatedMatch.topScore;
				fm.bottomScore = updatedMatch.bottomScore;
				fm.topCharacters = updatedMatch.topCharacters;
				fm.bottomCharacters = updatedMatch.bottomCharacters;
				fm.gameWinners = updatedMatch.gameWinners;
				fm.isDQ = updatedMatch.isDQ;
				fm.startggSetId = reportedMatch.startggSetId;
			}

			// Apply player advancements: copy topPlayerId/bottomPlayerId for downstream matches
			// that were changed by advancePlayer (only set them if fresh state doesn't have them yet)
			for (const um of updatedBracket.matches) {
				const freshM = freshBracket.matches.find((m) => m.id === um.id);
				if (!freshM) continue;
				if (um.topPlayerId && !freshM.topPlayerId) freshM.topPlayerId = um.topPlayerId;
				if (um.bottomPlayerId && !freshM.bottomPlayerId) freshM.bottomPlayerId = um.bottomPlayerId;
			}
		}

		if (tournament.startggSync) fresh.startggSync = tournament.startggSync;

		const allComplete2 = Object.values(fresh.brackets).every((b) =>
			b.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).every((m) => m.winnerId)
		);
		if (allComplete2) fresh.phase = 'completed';

		await saveTournament(fresh);
	} else {
		await saveTournament(tournament);
	}
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
