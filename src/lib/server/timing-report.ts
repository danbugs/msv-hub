import type { TournamentState, BracketMatch } from '$lib/types/tournament';

interface RoundTiming {
	label: string;
	durationMs: number;
	longestMatch?: { players: string; durationMs: number };
}

interface TimingReport {
	totalDurationMs: number;
	swiss: { totalMs: number; rounds: RoundTiming[]; adminMs: number };
	transitionMs: number;
	brackets: { name: string; totalMs: number; rounds: RoundTiming[] }[];
	adminBetweenBracketRoundsMs: number;
	bottlenecks: RoundTiming[];
}

function fmt(ms: number): string {
	const totalSec = Math.round(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
	return `${s}s`;
}

function bracketRoundLabel(round: number, bracketName: string): string {
	const prefix = bracketName === 'main' ? '' : 'Red. ';
	if (round > 0) return `${prefix}WR${round}`;
	return `${prefix}LR${Math.abs(round)}`;
}

export function generateTimingReport(tournament: TournamentState): TimingReport | null {
	if (tournament.phase !== 'completed') return null;

	const entrantMap = new Map(tournament.entrants.map((e) => [e.id, e.gamerTag]));
	const tag = (id?: string) => (id ? entrantMap.get(id) ?? id : '???');

	// --- Swiss rounds ---
	const swissRounds: RoundTiming[] = [];
	let swissAdminMs = 0;

	for (let i = 0; i < tournament.rounds.length; i++) {
		const r = tournament.rounds[i];
		const start = r.startedAt;
		const end = r.completedAt;
		if (!start || !end) {
			swissRounds.push({ label: `Swiss R${r.number}`, durationMs: 0 });
			continue;
		}

		let longest: RoundTiming['longestMatch'];
		for (const m of r.matches) {
			if (!m.reportedAt) continue;
			const matchDur = m.reportedAt - start;
			if (!longest || matchDur > longest.durationMs) {
				longest = { players: `${tag(m.topPlayerId)} vs ${tag(m.bottomPlayerId)}`, durationMs: matchDur };
			}
		}

		swissRounds.push({ label: `Swiss R${r.number}`, durationMs: end - start, longestMatch: longest });

		// Admin gap between this round's completion and next round's start
		if (i < tournament.rounds.length - 1) {
			const nextStart = tournament.rounds[i + 1].startedAt;
			if (nextStart && end) swissAdminMs += nextStart - end;
		}
	}

	const swissStart = tournament.phaseTimestamps?.swissStartedAt ?? tournament.rounds[0]?.startedAt;
	const swissEnd = tournament.phaseTimestamps?.swissCompletedAt ?? tournament.rounds.at(-1)?.completedAt;
	const swissTotalMs = swissStart && swissEnd ? swissEnd - swissStart : 0;

	// --- Swiss → Brackets transition ---
	const bracketsStart = tournament.phaseTimestamps?.bracketsStartedAt;
	const transitionMs = swissEnd && bracketsStart ? bracketsStart - swissEnd : 0;

	// --- Bracket rounds ---
	const bracketSections: TimingReport['brackets'] = [];
	let totalAdminBetweenBracketRoundsMs = 0;

	for (const name of ['main', 'redemption'] as const) {
		const bracket = tournament.brackets?.[name];
		if (!bracket) continue;

		// Group matches by round number
		const byRound = new Map<number, BracketMatch[]>();
		for (const m of bracket.matches) {
			if (!m.topPlayerId || !m.bottomPlayerId) continue;
			const existing = byRound.get(m.round) ?? [];
			existing.push(m);
			byRound.set(m.round, existing);
		}

		// Sort rounds: positive (winners) ascending, then negative (losers) by absolute value
		// Interleave them in play order: WR1, LR1, LR2, WR2, LR3, LR4, ...
		// Actually, just sort by earliest calledAt/reportedAt in each round group
		const roundNums = [...byRound.keys()].sort((a, b) => {
			const aMatches = byRound.get(a)!;
			const bMatches = byRound.get(b)!;
			const aFirst = Math.min(...aMatches.map((m) => m.calledAt ?? m.reportedAt ?? Infinity));
			const bFirst = Math.min(...bMatches.map((m) => m.calledAt ?? m.reportedAt ?? Infinity));
			return aFirst - bFirst;
		});

		const rounds: RoundTiming[] = [];
		let prevRoundEnd = 0;

		for (const roundNum of roundNums) {
			const matches = byRound.get(roundNum)!;
			const calledTimes = matches.map((m) => m.calledAt).filter((t): t is number => t !== undefined);
			const reportedTimes = matches.map((m) => m.reportedAt).filter((t): t is number => t !== undefined);

			const roundStart = calledTimes.length > 0 ? Math.min(...calledTimes) : 0;
			const roundEnd = reportedTimes.length > 0 ? Math.max(...reportedTimes) : 0;
			const durationMs = roundStart && roundEnd ? roundEnd - roundStart : 0;

			let longest: RoundTiming['longestMatch'];
			for (const m of matches) {
				const mStart = m.calledAt;
				const mEnd = m.reportedAt;
				if (!mStart || !mEnd) continue;
				const dur = mEnd - mStart;
				if (!longest || dur > longest.durationMs) {
					longest = { players: `${tag(m.topPlayerId)} vs ${tag(m.bottomPlayerId)}`, durationMs: dur };
				}
			}

			// Admin gap between bracket rounds
			if (prevRoundEnd && roundStart && roundStart > prevRoundEnd) {
				totalAdminBetweenBracketRoundsMs += roundStart - prevRoundEnd;
			}
			if (roundEnd) prevRoundEnd = roundEnd;

			rounds.push({ label: bracketRoundLabel(roundNum, name), durationMs, longestMatch: longest });
		}

		const sectionStart = rounds.length > 0 ? Math.min(...[...byRound.values()].flat().map((m) => m.calledAt ?? Infinity)) : 0;
		const sectionEnd = rounds.length > 0 ? Math.max(...[...byRound.values()].flat().map((m) => m.reportedAt ?? 0)) : 0;
		const totalMs = sectionStart && sectionEnd ? sectionEnd - sectionStart : 0;

		bracketSections.push({ name, totalMs, rounds });
	}

	// --- Total ---
	const tournamentStart = swissStart ?? tournament.createdAt;
	const lastReportedAt = Math.max(
		...Object.values(tournament.brackets ?? {})
			.filter(Boolean)
			.flatMap((b) => b!.matches.map((m) => m.reportedAt ?? 0))
	);
	const totalDurationMs = lastReportedAt ? lastReportedAt - tournamentStart : 0;

	// --- Bottlenecks ---
	const allRounds: RoundTiming[] = [
		...swissRounds,
		...bracketSections.flatMap((s) => s.rounds)
	].filter((r) => r.durationMs > 0);
	const bottlenecks = allRounds
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, 5);

	return {
		totalDurationMs,
		swiss: { totalMs: swissTotalMs, rounds: swissRounds, adminMs: swissAdminMs },
		transitionMs,
		brackets: bracketSections,
		adminBetweenBracketRoundsMs: totalAdminBetweenBracketRoundsMs,
		bottlenecks
	};
}

export function formatTimingReportForDiscord(tournament: TournamentState): string | null {
	const report = generateTimingReport(tournament);
	if (!report) return null;

	const lines: string[] = [];
	lines.push(`**${tournament.name} — Timing Report**`);
	lines.push(`Total: **${fmt(report.totalDurationMs)}**`);
	lines.push('');

	// Swiss
	if (report.swiss.rounds.length > 0) {
		lines.push(`**Swiss Phase** (${fmt(report.swiss.totalMs)})`);
		for (const r of report.swiss.rounds) {
			const longest = r.longestMatch ? ` · slowest: ${r.longestMatch.players} (${fmt(r.longestMatch.durationMs)})` : '';
			lines.push(`  ${r.label}: ${fmt(r.durationMs)}${longest}`);
		}
		if (report.swiss.adminMs > 0) {
			lines.push(`  ⏱ Between-round admin: ${fmt(report.swiss.adminMs)}`);
		}
		lines.push('');
	}

	// Transition
	if (report.transitionMs > 0) {
		lines.push(`⏱ Swiss → Bracket transition: ${fmt(report.transitionMs)}`);
		lines.push('');
	}

	// Brackets
	for (const section of report.brackets) {
		const label = section.name === 'main' ? 'Main Bracket' : 'Redemption Bracket';
		lines.push(`**${label}** (${fmt(section.totalMs)})`);
		for (const r of section.rounds) {
			const longest = r.longestMatch ? ` · slowest: ${r.longestMatch.players} (${fmt(r.longestMatch.durationMs)})` : '';
			lines.push(`  ${r.label}: ${fmt(r.durationMs)}${longest}`);
		}
		lines.push('');
	}

	if (report.adminBetweenBracketRoundsMs > 0) {
		lines.push(`⏱ Bracket between-round admin: ${fmt(report.adminBetweenBracketRoundsMs)}`);
		lines.push('');
	}

	// Bottlenecks
	if (report.bottlenecks.length > 0) {
		lines.push('**Top Bottlenecks:**');
		for (let i = 0; i < report.bottlenecks.length; i++) {
			const b = report.bottlenecks[i];
			const longest = b.longestMatch ? ` (slowest: ${b.longestMatch.players}, ${fmt(b.longestMatch.durationMs)})` : '';
			lines.push(`  ${i + 1}. ${b.label} — ${fmt(b.durationMs)}${longest}`);
		}
	}

	return lines.join('\n');
}
