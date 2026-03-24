<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState, BracketMatch, BracketState, Entrant } from '$lib/types/tournament';

	let tournament = $state<TournamentState | null>(null);
	let activeBracket = $state<'main' | 'redemption'>('main');
	let error = $state('');

	// Character select for top 8
	let reportingMatch = $state<BracketMatch | null>(null);
	let reportWinnerId = $state('');
	let reportTopChar = $state('');
	let reportBotChar = $state('');

	const CHARACTERS = [
		'Mario', 'Donkey Kong', 'Link', 'Samus', 'Dark Samus', 'Yoshi', 'Kirby', 'Fox',
		'Pikachu', 'Luigi', 'Ness', 'Captain Falcon', 'Jigglypuff', 'Peach', 'Daisy', 'Bowser',
		'Ice Climbers', 'Sheik', 'Zelda', 'Dr. Mario', 'Pichu', 'Falco', 'Marth', 'Lucina',
		'Young Link', 'Ganondorf', 'Mewtwo', 'Roy', 'Chrom', 'Mr. Game & Watch', 'Meta Knight',
		'Pit', 'Dark Pit', 'Zero Suit Samus', 'Wario', 'Snake', 'Ike', 'Pokemon Trainer',
		'Diddy Kong', 'Lucas', 'Sonic', 'King Dedede', 'Olimar', 'Lucario', 'R.O.B.', 'Toon Link',
		'Wolf', 'Villager', 'Mega Man', 'Wii Fit Trainer', 'Rosalina & Luma', 'Little Mac',
		'Greninja', 'Palutena', 'Pac-Man', 'Robin', 'Shulk', 'Bowser Jr.', 'Duck Hunt',
		'Ryu', 'Ken', 'Cloud', 'Corrin', 'Bayonetta', 'Inkling', 'Ridley', 'Simon', 'Richter',
		'King K. Rool', 'Isabelle', 'Incineroar', 'Piranha Plant', 'Joker', 'Hero',
		'Banjo & Kazooie', 'Terry', 'Byleth', 'Min Min', 'Steve', 'Sephiroth', 'Pyra/Mythra',
		'Kazuya', 'Sora'
	];

	const inputClass = 'mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500';

	onMount(loadTournament);

	async function loadTournament() {
		const res = await fetch('/api/tournament');
		if (res.ok) tournament = await res.json();
	}

	function getEntrant(id?: string): Entrant | undefined {
		if (!id) return undefined;
		return tournament?.entrants.find((e) => e.id === id);
	}

	function getBracket(): BracketState | undefined {
		return tournament?.brackets?.[activeBracket];
	}

	function isTop8Match(match: BracketMatch, bracket: BracketState): boolean {
		// Top 8 = quarterfinals and beyond in winners, or late losers rounds
		const totalPlayers = bracket.players.length;
		if (totalPlayers <= 8) return true;
		// For larger brackets, check if it's in the final 3 winners rounds or last 4 losers rounds
		const maxWinnersRound = Math.max(...bracket.matches.filter((m) => m.round > 0).map((m) => m.round));
		if (match.round > 0) return match.round >= maxWinnersRound - 2;
		return match.round <= -(Math.max(...bracket.matches.filter((m) => m.round < 0).map((m) => Math.abs(m.round))) - 3);
	}

	function getReadyMatches(bracket: BracketState): BracketMatch[] {
		return bracket.matches.filter(
			(m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId
		);
	}

	function getCompletedMatches(bracket: BracketState): BracketMatch[] {
		return bracket.matches.filter((m) => m.winnerId);
	}

	function openReport(match: BracketMatch) {
		reportingMatch = match;
		reportWinnerId = '';
		reportTopChar = '';
		reportBotChar = '';
	}

	async function submitReport() {
		if (!reportingMatch || !reportWinnerId) return;
		error = '';

		const res = await fetch('/api/tournament/bracket', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				bracketName: activeBracket,
				matchId: reportingMatch.id,
				winnerId: reportWinnerId,
				topCharacter: reportTopChar || undefined,
				bottomCharacter: reportBotChar || undefined
			})
		});

		if (!res.ok) {
			const data = await res.json();
			error = data.error ?? 'Failed to report match';
		} else {
			reportingMatch = null;
			await loadTournament();
		}
	}
</script>

<main class="mx-auto max-w-5xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Brackets</h1>

	{#if error}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">{error}</div>
	{/if}

	{#if !tournament?.brackets}
		<div class="mt-6 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
			No brackets yet. Complete Swiss rounds first.
			<a href="/dashboard/tournament/swiss" class="block mt-2 text-violet-400 hover:text-violet-300">Go to Swiss &rarr;</a>
		</div>
	{:else}
		<!-- Bracket tab selector -->
		<div class="mt-4 flex gap-2">
			<button onclick={() => activeBracket = 'main'}
				class="rounded-lg px-4 py-2 text-sm font-medium transition-colors {activeBracket === 'main' ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
				Main Bracket
			</button>
			<button onclick={() => activeBracket = 'redemption'}
				class="rounded-lg px-4 py-2 text-sm font-medium transition-colors {activeBracket === 'redemption' ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
				Redemption Bracket
			</button>
		</div>

		{@const bracket = getBracket()}
		{#if bracket}
			{@const ready = getReadyMatches(bracket)}
			{@const completed = getCompletedMatches(bracket)}

			<div class="mt-2 text-xs text-gray-500">
				{bracket.players.length} players | {completed.length}/{bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length} matches completed
			</div>

			<!-- Ready matches (can report) -->
			{#if ready.length > 0}
				<div class="mt-6">
					<h3 class="text-sm font-medium text-gray-300 mb-2">Ready to Play ({ready.length})</h3>
					<div class="space-y-2">
						{#each ready as match}
							{@const top = getEntrant(match.topPlayerId)}
							{@const bot = getEntrant(match.bottomPlayerId)}
							{@const showChars = isTop8Match(match, bracket)}

							<div class="flex items-center gap-3 rounded-lg bg-gray-900 px-4 py-3">
								<span class="w-24 text-xs text-gray-500 font-mono">
									{match.round > 0 ? `W${match.round}` : `L${Math.abs(match.round)}`}-{match.matchIndex + 1}
								</span>

								<span class="flex-1 text-white">{top?.gamerTag ?? '?'}</span>
								<span class="text-gray-600 text-xs">vs</span>
								<span class="flex-1 text-white">{bot?.gamerTag ?? '?'}</span>

								<button onclick={() => openReport(match)}
									class="rounded bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-500">
									Report
								</button>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Report modal -->
			{#if reportingMatch}
				{@const top = getEntrant(reportingMatch.topPlayerId)}
				{@const bot = getEntrant(reportingMatch.bottomPlayerId)}
				{@const showChars = bracket ? isTop8Match(reportingMatch, bracket) : false}

				<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
					<div class="w-full max-w-md rounded-xl bg-gray-900 border border-gray-700 p-6">
						<h3 class="text-lg font-semibold text-white">Report Match</h3>
						<p class="text-sm text-gray-400 mt-1">{top?.gamerTag ?? '?'} vs {bot?.gamerTag ?? '?'}</p>

						<!-- Winner selection -->
						<div class="mt-4 flex gap-3">
							<button onclick={() => reportWinnerId = reportingMatch!.topPlayerId!}
								class="flex-1 rounded-lg py-3 font-medium transition-colors {reportWinnerId === reportingMatch.topPlayerId ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
								{top?.gamerTag ?? '?'} wins
							</button>
							<button onclick={() => reportWinnerId = reportingMatch!.bottomPlayerId!}
								class="flex-1 rounded-lg py-3 font-medium transition-colors {reportWinnerId === reportingMatch.bottomPlayerId ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
								{bot?.gamerTag ?? '?'} wins
							</button>
						</div>

						<!-- Character select for top 8 -->
						{#if showChars}
							<div class="mt-4 space-y-3">
								<div>
									<label for="top-char" class="block text-xs text-gray-400">{top?.gamerTag}'s character</label>
									<select id="top-char" bind:value={reportTopChar} class={inputClass}>
										<option value="">— select —</option>
										{#each CHARACTERS as char}
											<option value={char}>{char}</option>
										{/each}
									</select>
								</div>
								<div>
									<label for="bot-char" class="block text-xs text-gray-400">{bot?.gamerTag}'s character</label>
									<select id="bot-char" bind:value={reportBotChar} class={inputClass}>
										<option value="">— select —</option>
										{#each CHARACTERS as char}
											<option value={char}>{char}</option>
										{/each}
									</select>
								</div>
							</div>
						{/if}

						<div class="mt-6 flex gap-3">
							<button onclick={submitReport} disabled={!reportWinnerId}
								class="flex-1 rounded-lg bg-violet-600 py-2 font-medium text-white hover:bg-violet-500 disabled:opacity-50">
								Submit
							</button>
							<button onclick={() => reportingMatch = null}
								class="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-white">
								Cancel
							</button>
						</div>
					</div>
				</div>
			{/if}

			<!-- Completed matches log -->
			{#if completed.length > 0}
				<details class="mt-6 rounded-lg border border-gray-800 bg-gray-900">
					<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-gray-300">
						Completed Matches ({completed.length})
					</summary>
					<div class="px-4 pb-4 space-y-1">
						{#each completed as match}
							{@const top = getEntrant(match.topPlayerId)}
							{@const bot = getEntrant(match.bottomPlayerId)}
							{@const winner = getEntrant(match.winnerId)}
							<div class="flex items-center gap-2 text-sm py-1">
								<span class="w-16 text-xs text-gray-500 font-mono">
									{match.round > 0 ? `W${match.round}` : `L${Math.abs(match.round)}`}
								</span>
								<span class="{match.winnerId === match.topPlayerId ? 'text-green-300 font-medium' : 'text-gray-400'}">
									{top?.gamerTag ?? '?'}
									{#if match.topCharacter}<span class="text-xs text-gray-500"> ({match.topCharacter})</span>{/if}
								</span>
								<span class="text-gray-600">vs</span>
								<span class="{match.winnerId === match.bottomPlayerId ? 'text-green-300 font-medium' : 'text-gray-400'}">
									{bot?.gamerTag ?? '?'}
									{#if match.bottomCharacter}<span class="text-xs text-gray-500"> ({match.bottomCharacter})</span>{/if}
								</span>
							</div>
						{/each}
					</div>
				</details>
			{/if}
		{/if}
	{/if}
</main>
