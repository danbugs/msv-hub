<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { TournamentState, Entrant, SwissRound } from '$lib/types/tournament';

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
						? 'Brackets'
						: 'Completed'}
				— {tournament.entrants.length} players
			</p>
		{:else}
			<p class="mt-1 text-gray-400">No active tournament</p>
		{/if}

		{#if tournament}
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

				{#if tournament.finalStandings}
					<div class="mt-4 grid gap-6 sm:grid-cols-2">
						<div>
							<h3 class="text-sm font-medium text-violet-400 mb-2">Main Bracket</h3>
							{#each tournament.finalStandings.filter((s) => s.bracket === 'main') as s}
								<div class="flex items-center gap-2 text-sm py-0.5">
									<span class="w-6 text-right font-mono text-gray-500">{s.rank}.</span>
									<span class="text-white">{s.gamerTag}</span>
									<span class="text-gray-500">{s.wins}-{s.losses}</span>
								</div>
							{/each}
						</div>
						<div>
							<h3 class="text-sm font-medium text-red-400 mb-2">Redemption Bracket</h3>
							{#each tournament.finalStandings.filter((s) => s.bracket === 'redemption') as s}
								<div class="flex items-center gap-2 text-sm py-0.5">
									<span class="w-6 text-right font-mono text-gray-500">{s.rank}.</span>
									<span class="text-white">{s.gamerTag}</span>
									<span class="text-gray-500">{s.wins}-{s.losses}</span>
								</div>
							{/each}
						</div>
					</div>
				{:else if tournament.currentRound > 0}
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
		{:else}
			<div class="mt-8 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
				No active tournament for this slug.
			</div>
		{/if}
	</div>
</div>
