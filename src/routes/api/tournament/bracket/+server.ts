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

	// Guard: don't allow editing a GF result if the GF Reset match has been reported.
	// The reset match's state would become inconsistent. Reset GFR first.
	const targetMatch = bracket.matches.find((m) => m.id === matchId);
	const isGFEdit = targetMatch && targetMatch.winnerId && !matchId.includes('-GFR-');
	if (isGFEdit) {
		const maxRound = Math.max(...bracket.matches.filter((m) => !m.id.includes('-GFR-')).map((m) => m.round));
		const isGF = targetMatch.round === maxRound;
		if (isGF) {
			const gfr = bracket.matches.find((m) => m.id.includes('-GFR-'));
			if (gfr?.winnerId) {
				return Response.json({
					error: 'Cannot edit Grand Finals result: the Reset match has already been reported. Unreport the Reset match first (edit it), then edit the Grand Finals.'
				}, { status: 400 });
			}
		}
	}

	try {
		const otherName = bracketName === 'main' ? 'redemption' : 'main';
		const otherBracket = tournament.brackets[otherName];
		const otherHasStream = otherBracket?.matches.some((m) => m.isStream && !m.winnerId) ?? false;

		// Cumulative stream appearances across all Swiss rounds + brackets.
		// Used to spread stream time across more players instead of same seeds each week.
		const streamCountByPlayer = new Map<string, number>();
		const tally = (ids: (string | undefined)[]) => {
			for (const id of ids) if (id) streamCountByPlayer.set(id, (streamCountByPlayer.get(id) ?? 0) + 1);
		};
		for (const r of tournament.rounds) for (const m of r.matches) if (m.isStream) tally([m.topPlayerId, m.bottomPlayerId]);
		for (const bn of ['main', 'redemption'] as const) {
			const b = tournament.brackets?.[bn];
			if (b) for (const m of b.matches) if (m.isStream) tally([m.topPlayerId, m.bottomPlayerId]);
		}

		tournament.brackets[bracketName] = reportBracketMatch(
			bracket, matchId, winnerId, topCharacters, bottomCharacters, topScore, bottomScore,
			tournament.settings, bracketName, otherHasStream, gameWinners, isDQ, streamCountByPlayer
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

	// Concurrency-safe save: reload the latest tournament from Redis and merge our
	// bracket changes into it. Protects against two bracket reports racing where
	// the second one loads stale state and overwrites the first's winner.
	const fresh = await getActiveTournament();
	if (fresh?.brackets && fresh.brackets[bracketName]) {
		const freshBracket = fresh.brackets[bracketName];
		const ourBracket = tournament.brackets[bracketName];
		const freshMatchIds = new Set(freshBracket.matches.map((m) => m.id));
		const ourMatchMap = new Map(ourBracket.matches.map((m) => [m.id, m]));

		// Merge existing fresh matches
		for (let i = 0; i < freshBracket.matches.length; i++) {
			const fm = freshBracket.matches[i];
			const om = ourMatchMap.get(fm.id);
			if (!om) continue;
			// If we just modified this match (the one being reported), take our version
			if (fm.id === matchId) {
				freshBracket.matches[i] = om;
				continue;
			}
			// Preserve fresh's winner if it has one (don't overwrite concurrent reports)
			if (fm.winnerId) continue;
			// Take our version (may have player advancement placed)
			freshBracket.matches[i] = om;
		}

		// Append matches that exist in OUR bracket but not fresh (e.g. newly-created GFR)
		for (const om of ourBracket.matches) {
			if (!freshMatchIds.has(om.id)) {
				freshBracket.matches.push(om);
			}
		}

		// Remove matches that OUR bracket dropped (e.g. GFR deleted when GF flipped to top-winner)
		freshBracket.matches = freshBracket.matches.filter((fm) => ourMatchMap.has(fm.id));

		if (tournament.phase === 'completed') fresh.phase = 'completed';
		await saveTournament(fresh);
		tournament.brackets[bracketName] = freshBracket;
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
