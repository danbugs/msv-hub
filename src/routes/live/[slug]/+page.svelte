<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { TournamentState, Entrant, SwissRound, BracketMatch, BracketState } from '$lib/types/tournament';

	let { data } = $props();
	let tournament = $derived<TournamentState | null>(data.tournament);

	function getEntrant(id?: string): Entrant | undefined {
		if (!id || !tournament) return undefined;
		return tournament.entrants.find((e) => e.id === id);
	}

	function getCurrentRound(): SwissRound | undefined {
		if (!tournament) return undefined;
		return tournament.rounds.find((r) => r.status === 'active');
	}

	function getStandings() {
		if (!tournament) return [];
		return tournament.entrants
			.map((e) => {
				let wins = 0, losses = 0;
				for (const r of tournament!.rounds) {
					if (r.byePlayerId === e.id) wins++;
					for (const m of r.matches) {
						if (!m.winnerId) continue;
						if (m.topPlayerId === e.id || m.bottomPlayerId === e.id) {
							if (m.winnerId === e.id) wins++; else losses++;
						}
					}
				}
				return { ...e, wins, losses };
			})
			.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.initialSeed - b.initialSeed);
	}

	/** Active bracket matches: ready to play, sorted by station */
	function getActiveBracketMatches(bracket: BracketState): BracketMatch[] {
		return bracket.matches
			.filter((m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId)
			.sort((a, b) => (a.station ?? 99) - (b.station ?? 99));
	}

	function roundLabel(round: number, bracket: BracketState): string {
		const maxRound = Math.max(...bracket.matches.map((m) => m.round));
		if (round === maxRound) return 'Grand Final';
		if (round === maxRound - 1 && bracket.matches.some((m) => m.id.includes('-GFR-'))) return 'Grand Final';
		if (round > 0) {
			const maxWR = Math.max(...bracket.matches.filter((m) => m.round > 0 && !m.id.includes('-GFR-')).map((m) => m.round));
			if (round === maxWR) return 'Winners Finals';
			if (round === maxWR - 1) return 'Winners Semis';
			return `Winners R${round}`;
		}
		return `Losers R${Math.abs(round)}`;
	}

	// Auto-refresh every 15s
	$effect(() => {
		const interval = setInterval(() => invalidateAll(), 15_000);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>{tournament?.name ?? data.slug} — MSV Live</title>
</svelte:head>

<div class="min-h-screen bg-gray-950 px-4 py-8">
	<div class="mx-auto max-w-4xl">
		<h1 class="text-2xl font-bold text-violet-400">{tournament?.name ?? 'MSV Live'}</h1>
		{#if tournament}
			<p class="mt-1 text-gray-400">
				{tournament.phase === 'swiss'
					? `Swiss Round ${tournament.currentRound}/${tournament.settings.numRounds}`
					: tournament.phase === 'brackets'
						? 'Bracket Phase'
						: 'Completed'}
				— {tournament.entrants.length} players
			</p>
		{:else}
			<p class="mt-1 text-gray-400">No active tournament</p>
		{/if}

		{#if tournament}
			{#if tournament.phase === 'swiss'}
				{@const round = getCurrentRound()}
				{#if round}
					<!-- Station Assignments -->
					<div class="mt-8">
						<h2 class="text-lg font-semibold text-white">Round {round.number} — Station Assignments</h2>
						<div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
							{#each round.matches.sort((a, b) => (a.station ?? 99) - (b.station ?? 99)) as match}
								{@const top = getEntrant(match.topPlayerId)}
								{@const bot = getEntrant(match.bottomPlayerId)}
								{@const done = !!match.winnerId}

								<div class="rounded-xl p-3 text-center {match.isStream ? 'border-2 border-red-500 bg-red-500/10' : 'border border-gray-700 bg-gray-900'} {done ? 'opacity-40' : ''}">
									<div class="text-xs font-bold {match.isStream ? 'text-red-400' : 'text-gray-400'}">
										{match.isStream ? 'STREAM' : `STN ${match.station}`}
									</div>
									<div class="mt-1 text-sm">
										<div class="text-white truncate">{top?.gamerTag ?? '?'}</div>
										<div class="text-gray-500 text-xs">vs</div>
										<div class="text-white truncate">{bot?.gamerTag ?? '?'}</div>
									</div>
									{#if done}
										<div class="mt-1 text-xs text-green-400 truncate">{getEntrant(match.winnerId)?.gamerTag} wins</div>
									{/if}
								</div>
							{/each}

							{#if round.byePlayerId}
								<div class="rounded-xl border border-yellow-700 bg-yellow-900/20 p-3 text-center">
									<div class="text-xs font-bold text-yellow-400">BYE</div>
									<div class="mt-1 text-sm text-white">{getEntrant(round.byePlayerId)?.gamerTag}</div>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Standings -->
				<div class="mt-8">
					<h2 class="text-lg font-semibold text-white">Standings</h2>
					{#if tournament.currentRound > 0}
						<div class="mt-4 overflow-x-auto">
							<table class="w-full text-sm">
								<thead>
									<tr class="border-b border-gray-700 text-left text-gray-400">
										<th class="px-3 py-2">Tag</th>
										<th class="px-3 py-2 text-right">Seed</th>
										<th class="px-3 py-2 text-right">W</th>
										<th class="px-3 py-2 text-right">L</th>
									</tr>
								</thead>
								<tbody>
									{#each getStandings() as e}
										<tr class="border-b border-gray-800">
											<td class="px-3 py-2 text-white">{e.gamerTag}</td>
											<td class="px-3 py-2 text-right font-mono text-gray-400">#{e.initialSeed}</td>
											<td class="px-3 py-2 text-right font-mono text-green-400">{e.wins}</td>
											<td class="px-3 py-2 text-right font-mono text-red-400">{e.losses}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else}
						<div class="mt-4 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
							Tournament data will appear once Swiss begins.
						</div>
					{/if}
				</div>

			{:else if tournament.phase === 'brackets' && tournament.brackets}
				{#each (['main', 'redemption'] as const) as bracketName}
					{@const bracket = tournament.brackets[bracketName]}
					{@const activeMatches = getActiveBracketMatches(bracket)}
					{@const totalM = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length}
					{@const doneM = bracket.matches.filter((m) => m.winnerId).length}

					{#if bracket.players.length > 0}
						<div class="mt-8">
							<div class="flex items-center gap-3">
								<h2 class="text-lg font-semibold text-white">
									{bracketName === 'main' ? 'Main Bracket' : 'Redemption Bracket'}
								</h2>
								<span class="text-xs text-gray-500">{doneM}/{totalM} matches done</span>
							</div>

							{#if activeMatches.length > 0}
								<!-- Stream match banner -->
								{@const streamMatch = activeMatches.find((m) => m.isStream)}
								{#if streamMatch}
									<div class="mt-3 rounded-xl border-2 border-red-500 bg-red-500/10 p-4 text-center">
										<div class="text-xs font-bold text-red-400 mb-1">🔴 ON STREAM — {roundLabel(streamMatch.round, bracket)}</div>
										<div class="text-lg font-semibold text-white">
											{getEntrant(streamMatch.topPlayerId)?.gamerTag ?? '?'}
											<span class="text-gray-500 text-sm mx-2">vs</span>
											{getEntrant(streamMatch.bottomPlayerId)?.gamerTag ?? '?'}
										</div>
									</div>
								{/if}

								<!-- Active matches grid -->
								<div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
									{#each activeMatches.filter((m) => !m.isStream) as match}
										<div class="rounded-xl border border-gray-700 bg-gray-900 p-3 text-center">
											<div class="text-xs font-bold text-gray-400">
												{match.station !== undefined ? `STN ${match.station}` : roundLabel(match.round, bracket)}
											</div>
											<div class="mt-1 text-sm">
												<div class="text-white truncate">{getEntrant(match.topPlayerId)?.gamerTag ?? '?'}</div>
												<div class="text-gray-500 text-xs">vs</div>
												<div class="text-white truncate">{getEntrant(match.bottomPlayerId)?.gamerTag ?? '?'}</div>
											</div>
											<div class="mt-1 text-xs text-gray-500">{roundLabel(match.round, bracket)}</div>
										</div>
									{/each}
								</div>
							{:else}
								<p class="mt-3 text-sm text-gray-500">All matches complete.</p>
							{/if}

							<!-- Recent results (last 5 completed) -->
							{#if bracket.matches.some((m) => m.winnerId)}
							{@const recentDone = bracket.matches
								.filter((m) => m.winnerId && m.topPlayerId && m.bottomPlayerId)
								.slice(-5)
								.reverse()}
								<div class="mt-4">
									<h3 class="text-sm font-medium text-gray-400 mb-2">Recent Results</h3>
									<div class="space-y-1">
										{#each recentDone as m}
											{@const winner = getEntrant(m.winnerId)}
											{@const top = getEntrant(m.topPlayerId)}
											{@const bot = getEntrant(m.bottomPlayerId)}
											<div class="flex items-center gap-2 text-sm rounded-lg bg-gray-900 px-3 py-1.5">
												<span class="text-xs text-gray-500 w-24 shrink-0">{roundLabel(m.round, bracket)}</span>
												<span class="{m.winnerId === m.topPlayerId ? 'text-green-300 font-medium' : 'text-gray-500'}">{top?.gamerTag ?? '?'}</span>
												{#if m.topScore !== undefined}<span class="text-xs text-gray-400">{m.topScore}</span>{/if}
												<span class="text-gray-600 text-xs">–</span>
												{#if m.bottomScore !== undefined}<span class="text-xs text-gray-400">{m.bottomScore}</span>{/if}
												<span class="{m.winnerId === m.bottomPlayerId ? 'text-green-300 font-medium' : 'text-gray-500'}">{bot?.gamerTag ?? '?'}</span>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/if}
				{/each}

				<!-- Final Swiss standings (collapsed) -->
				{#if tournament.finalStandings}
					<details class="mt-8 rounded-lg border border-gray-800 bg-gray-900">
						<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-gray-300">Swiss Final Standings</summary>
						<div class="px-4 pb-4 grid gap-6 sm:grid-cols-2">
							<div>
								<h4 class="text-xs font-medium text-violet-400 mb-2 mt-2">Main Bracket</h4>
								{#each tournament.finalStandings.filter((s) => s.bracket === 'main') as s}
									<div class="flex items-center gap-2 text-sm py-0.5">
										<span class="w-6 text-right font-mono text-gray-500">{s.rank}.</span>
										<span class="text-white">{s.gamerTag}</span>
										<span class="text-gray-500">{s.wins}-{s.losses}</span>
									</div>
								{/each}
							</div>
							<div>
								<h4 class="text-xs font-medium text-red-400 mb-2 mt-2">Redemption</h4>
								{#each tournament.finalStandings.filter((s) => s.bracket === 'redemption') as s}
									<div class="flex items-center gap-2 text-sm py-0.5">
										<span class="w-6 text-right font-mono text-gray-500">{s.rank}.</span>
										<span class="text-white">{s.gamerTag}</span>
										<span class="text-gray-500">{s.wins}-{s.losses}</span>
									</div>
								{/each}
							</div>
						</div>
					</details>
				{/if}

			{:else if tournament.phase === 'completed'}
				<div class="mt-8 rounded-xl border border-gray-700 bg-gray-900 p-6 text-center">
					<p class="text-lg font-semibold text-white">Tournament Complete!</p>
					{#if tournament.finalStandings}
						<p class="mt-2 text-sm text-gray-400">
							Champion: <span class="text-violet-300 font-medium">{tournament.finalStandings[0]?.gamerTag}</span>
						</p>
					{/if}
				</div>
			{/if}
		{:else}
			<div class="mt-8 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
				No active tournament for this slug.
			</div>
		{/if}
	</div>
</div>
