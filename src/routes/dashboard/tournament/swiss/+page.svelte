<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState, SwissRound, Entrant, SwissMatch } from '$lib/types/tournament';

	let tournament = $state<TournamentState | null>(null);
	let loading = $state(false);
	let error = $state('');

	let showSetup = $state(false);
	let fixingMatchId = $state<string | null>(null);
	// Score selection: { matchId, winnerId } — waiting for score pick
	let pendingWinner = $state<{ matchId: string; winnerId: string } | null>(null);

	onMount(loadTournament);

	async function loadTournament() {
		const res = await fetch('/api/tournament');
		if (res.ok) {
			const data = await res.json();
			tournament = data;
			if (!data) showSetup = true;
		}
	}

	async function startNextRound(regenerate = false) {
		loading = true;
		error = '';

		const res = await fetch('/api/tournament/round', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ regenerate })
		});

		const data = await res.json();
		if (!res.ok) {
			error = data.error ?? 'Failed to start round';
		} else {
			await loadTournament();
		}
		loading = false;
	}

	async function reportMatch(matchId: string, winnerId: string, score: '2-0' | '2-1', roundNumber?: number) {
		const [topScore, bottomScore] = (() => {
			const m = getMatch(matchId);
			if (!m) return [undefined, undefined];
			const winnerIsTop = winnerId === m.topPlayerId;
			if (score === '2-0') return winnerIsTop ? [2, 0] : [0, 2];
			return winnerIsTop ? [2, 1] : [1, 2];
		})();

		const res = await fetch('/api/tournament/round', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ matchId, winnerId, roundNumber, topScore, bottomScore })
		});

		const data = await res.json();
		if (!res.ok) {
			error = data.error ?? 'Failed to report match';
		} else {
			fixingMatchId = null;
			pendingWinner = null;
			await loadTournament();
		}
	}

	async function setStreamMatch(matchId: string) {
		const res = await fetch('/api/tournament/round/stream', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ matchId })
		});
		if (res.ok) await loadTournament();
		else error = 'Failed to reassign stream';
	}

	async function deleteTournament() {
		if (!confirm('Delete the active tournament? This cannot be undone.')) return;
		await fetch('/api/tournament', { method: 'DELETE' });
		tournament = null;
		showSetup = true;
	}

	function getEntrant(id: string): Entrant | undefined {
		return tournament?.entrants.find((e) => e.id === id);
	}

	function getMatch(id: string): SwissMatch | undefined {
		for (const r of tournament?.rounds ?? []) {
			const m = r.matches.find((m) => m.id === id);
			if (m) return m;
		}
	}

	function getCurrentRound(): SwissRound | undefined {
		if (!tournament) return undefined;
		return tournament.rounds.find((r) => r.status === 'active');
	}

	function isRoundComplete(): boolean {
		const round = getCurrentRound();
		return round ? round.matches.every((m) => m.winnerId) : false;
	}

	function isSwissComplete(): boolean {
		if (!tournament) return false;
		return tournament.rounds.filter((r) => r.status === 'completed').length >= tournament.settings.numRounds;
	}

	function selectWinner(matchId: string, winnerId: string, isCurrent: boolean, isFixing: boolean) {
		if (!isCurrent && !isFixing) return;
		// If clicking the already-pending winner, deselect
		if (pendingWinner?.matchId === matchId && pendingWinner?.winnerId === winnerId) {
			pendingWinner = null;
		} else {
			pendingWinner = { matchId, winnerId };
		}
	}
</script>

<main class="mx-auto max-w-5xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Run Swiss</h1>

	{#if error}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">{error}</div>
	{/if}

	{#if showSetup && !tournament}
		<div class="mt-6 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
			No active tournament.
			<a href="/dashboard/pre-tournament/seed" class="block mt-2 text-violet-400 hover:text-violet-300">
				Run the seeder first, then click "Start Swiss →" &larr;
			</a>
		</div>

	{:else if tournament}
		<!-- Header -->
		<div class="mt-2 flex flex-wrap items-center gap-3">
			<h2 class="text-lg text-gray-300">{tournament.name}</h2>
			<span class="rounded-full bg-gray-800 px-3 py-0.5 text-xs font-medium text-violet-400">
				{tournament.phase === 'swiss' ? `Swiss — Round ${tournament.currentRound}/${tournament.settings.numRounds}` : tournament.phase}
			</span>
			<span class="text-xs text-gray-500">{tournament.entrants.length} players · {tournament.settings.numStations} stations</span>
			{#if tournament.phase === 'brackets'}
				<a href="/dashboard/tournament/brackets" class="text-sm text-violet-400 hover:text-violet-300">Go to Brackets &rarr;</a>
			{/if}
			<a href="/live/{tournament.slug}" target="_blank" class="ml-auto text-xs text-gray-500 hover:text-violet-400">
				Live: /live/{tournament.slug} ↗
			</a>
		</div>

		{#if tournament.phase === 'swiss'}
			<!-- Round controls -->
			<div class="mt-6 flex items-center gap-3">
				{#if tournament.currentRound === 0 || isRoundComplete()}
					<button onclick={() => startNextRound()} disabled={loading}
						class="rounded-lg bg-violet-600 px-5 py-2 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50">
						{loading ? 'Generating...' : tournament.currentRound === 0 ? 'Start Round 1' : isSwissComplete() ? 'Finish Swiss & Generate Brackets' : `Start Round ${tournament.currentRound + 1}`}
					</button>
				{/if}
				<button onclick={deleteTournament}
					class="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:border-red-700 hover:text-red-400 transition-colors">
					Delete Tournament
				</button>
			</div>

			<!-- Rounds (most recent first) -->
			{#each [...tournament.rounds].reverse() as round}
				{@const isCurrent = round.status === 'active'}
				<div class="mt-6">
					<div class="flex items-center gap-3 mb-3">
						<h3 class="text-lg font-semibold text-white">Round {round.number}</h3>
						<span class="rounded-full px-2 py-0.5 text-xs font-medium {isCurrent ? 'bg-violet-900/50 text-violet-300' : 'bg-gray-800 text-gray-400'}">
							{round.status}
						</span>
						{#if round.byePlayerId}
							<span class="text-xs text-yellow-400">BYE: {getEntrant(round.byePlayerId)?.gamerTag}</span>
						{/if}
					</div>

					<div class="space-y-1">
						{#each round.matches as match}
							{@const top = getEntrant(match.topPlayerId)}
							{@const bot = getEntrant(match.bottomPlayerId)}
							{@const isFixing = fixingMatchId === match.id}
							{@const isPending = pendingWinner?.matchId === match.id}
							{@const canInteract = isCurrent || isFixing}

							<div class="rounded-lg bg-gray-900 {match.isStream ? 'border border-violet-700' : 'border border-transparent'}">
								<!-- Match row -->
								<div class="flex items-center gap-2 px-3 py-2">
									<!-- Station label -->
									<span class="w-16 shrink-0 text-right text-xs font-mono {match.isStream ? 'text-violet-400' : 'text-gray-500'}">
										{match.isStream ? 'STREAM' : `Stn ${match.station}`}
									</span>

									<!-- Top player -->
									<button
										class="flex-1 min-w-0 truncate text-left rounded px-2 py-1 text-sm transition-colors
											{match.winnerId === match.topPlayerId ? 'bg-green-900/30 text-green-300 font-medium' :
											 match.winnerId ? 'text-gray-500' :
											 isPending && pendingWinner?.winnerId === match.topPlayerId ? 'bg-violet-900/40 text-violet-200' :
											 'text-white hover:bg-gray-800'}
											{!canInteract ? 'pointer-events-none' : ''}"
										disabled={!canInteract}
										onclick={() => selectWinner(match.id, match.topPlayerId, isCurrent, isFixing)}>
										<span class="text-xs text-gray-500 mr-1">#{top?.initialSeed}</span>
										{top?.gamerTag ?? '?'}
										{#if match.winnerId === match.topPlayerId && match.topScore !== undefined}
											<span class="ml-1 text-xs text-gray-400">{match.topScore}-{match.bottomScore}</span>
										{/if}
									</button>

									<span class="text-gray-600 text-xs shrink-0">vs</span>

									<!-- Bottom player -->
									<button
										class="flex-1 min-w-0 truncate text-left rounded px-2 py-1 text-sm transition-colors
											{match.winnerId === match.bottomPlayerId ? 'bg-green-900/30 text-green-300 font-medium' :
											 match.winnerId ? 'text-gray-500' :
											 isPending && pendingWinner?.winnerId === match.bottomPlayerId ? 'bg-violet-900/40 text-violet-200' :
											 'text-white hover:bg-gray-800'}
											{!canInteract ? 'pointer-events-none' : ''}"
										disabled={!canInteract}
										onclick={() => selectWinner(match.id, match.bottomPlayerId, isCurrent, isFixing)}>
										<span class="text-xs text-gray-500 mr-1">#{bot?.initialSeed}</span>
										{bot?.gamerTag ?? '?'}
										{#if match.winnerId === match.bottomPlayerId && match.bottomScore !== undefined}
											<span class="ml-1 text-xs text-gray-400">{match.topScore}-{match.bottomScore}</span>
										{/if}
									</button>

									<!-- Actions -->
									<div class="flex items-center gap-1 shrink-0">
										{#if isCurrent && !match.isStream}
											<button onclick={() => setStreamMatch(match.id)}
												class="text-xs px-2 py-1 rounded text-gray-600 hover:text-violet-400 hover:bg-violet-900/20 transition-colors"
												title="Set as stream match">
												📺
											</button>
										{/if}
										{#if round.status === 'completed' && match.winnerId}
											<button onclick={() => { fixingMatchId = isFixing ? null : match.id; pendingWinner = null; }}
												class="text-xs px-2 py-1 rounded {isFixing ? 'bg-yellow-900/30 text-yellow-300' : 'text-gray-500 hover:text-yellow-400'}">
												{isFixing ? 'Cancel' : 'Fix'}
											</button>
										{/if}
									</div>
								</div>

								<!-- Score picker (shown when a winner is selected but no score yet) -->
								{#if isPending}
									<div class="flex items-center gap-2 px-3 pb-2">
										<span class="text-xs text-gray-400 ml-16">Score:</span>
										<button
											onclick={() => reportMatch(match.id, pendingWinner!.winnerId, '2-0', round.number)}
											class="rounded bg-green-700 px-3 py-1 text-xs font-medium text-white hover:bg-green-600">
											2 – 0
										</button>
										<button
											onclick={() => reportMatch(match.id, pendingWinner!.winnerId, '2-1', round.number)}
											class="rounded bg-green-700 px-3 py-1 text-xs font-medium text-white hover:bg-green-600">
											2 – 1
										</button>
										<button onclick={() => pendingWinner = null}
											class="text-xs text-gray-500 hover:text-gray-300 px-2">Cancel</button>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}

			<!-- Standings -->
			{#if tournament.currentRound > 0}
				<details class="mt-8 rounded-lg border border-gray-800 bg-gray-900">
					<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-gray-300">Current Standings</summary>
					<div class="px-4 pb-4">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-gray-700 text-left text-gray-400">
									<th class="px-2 py-2">Tag</th>
									<th class="px-2 py-2 text-right">Seed</th>
									<th class="px-2 py-2 text-right">W</th>
									<th class="px-2 py-2 text-right">L</th>
								</tr>
							</thead>
							<tbody>
								{#each tournament.entrants
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
									.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.initialSeed - b.initialSeed) as entrant}
									<tr class="border-b border-gray-800">
										<td class="px-2 py-1.5 text-white">{entrant.gamerTag}</td>
										<td class="px-2 py-1.5 text-right font-mono text-gray-400">#{entrant.initialSeed}</td>
										<td class="px-2 py-1.5 text-right font-mono text-green-400">{entrant.wins}</td>
										<td class="px-2 py-1.5 text-right font-mono text-red-400">{entrant.losses}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{/if}
		{/if}

		{#if tournament.phase === 'brackets' && tournament.finalStandings}
			<div class="mt-6">
				<h3 class="text-lg font-semibold text-white">Swiss Complete — Final Standings</h3>
				<div class="mt-3 grid gap-6 sm:grid-cols-2">
					<div>
						<h4 class="text-sm font-medium text-violet-400 mb-2">Main Bracket ({tournament.finalStandings.filter((s) => s.bracket === 'main').length} players)</h4>
						{#each tournament.finalStandings.filter((s) => s.bracket === 'main') as s}
							<div class="flex items-center gap-2 text-sm py-0.5">
								<span class="w-6 text-right font-mono text-gray-500">{s.rank}.</span>
								<span class="text-white">{s.gamerTag}</span>
								<span class="text-gray-500">{s.wins}-{s.losses}</span>
								{#if s.cinderellaBonus > 0}
									<span class="text-yellow-400 text-xs">+{s.cinderellaBonus.toFixed(0)} Cinderella</span>
								{/if}
							</div>
						{/each}
					</div>
					<div>
						<h4 class="text-sm font-medium text-red-400 mb-2">Redemption Bracket ({tournament.finalStandings.filter((s) => s.bracket === 'redemption').length} players)</h4>
						{#each tournament.finalStandings.filter((s) => s.bracket === 'redemption') as s}
							<div class="flex items-center gap-2 text-sm py-0.5">
								<span class="w-6 text-right font-mono text-gray-500">{s.rank}.</span>
								<span class="text-white">{s.gamerTag}</span>
								<span class="text-gray-500">{s.wins}-{s.losses}</span>
							</div>
						{/each}
					</div>
				</div>
				<a href="/dashboard/tournament/brackets" class="mt-4 inline-block text-sm text-violet-400 hover:text-violet-300">
					Go to Brackets &rarr;
				</a>
			</div>
		{/if}
	{/if}
</main>
