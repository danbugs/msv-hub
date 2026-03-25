<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { TournamentState, Entrant, BracketMatch, BracketState, SwissRound } from '$lib/types/tournament';
	import BracketView from '$lib/components/BracketView.svelte';

	let { data } = $props();
	let tournament = $derived<TournamentState | null>(data.tournament);

	let searchQuery = $state('');
	let selectedEntrantId = $state<string | null>(null);
	let showBracket = $state<'main' | 'redemption'>('main');

	function getEntrant(id?: string): Entrant | undefined {
		if (!id || !tournament) return undefined;
		return tournament.entrants.find((e) => e.id === id);
	}

	function matchedEntrants(): Entrant[] {
		if (!searchQuery.trim() || !tournament) return [];
		const q = searchQuery.toLowerCase();
		return tournament.entrants.filter((e) => e.gamerTag.toLowerCase().includes(q)).slice(0, 6);
	}

	function selectEntrant(id: string) {
		selectedEntrantId = id;
		const e = getEntrant(id);
		if (e) searchQuery = e.gamerTag;
	}

	function clearSearch() {
		searchQuery = '';
		selectedEntrantId = null;
	}

	// ── Player history (why command) ──────────────────────────────────────

	function getSwissMatchesFor(entrantId: string) {
		if (!tournament) return [];
		const results: { round: number; opponentId: string; won: boolean; topScore?: number; bottomScore?: number; isTop: boolean }[] = [];
		for (const r of tournament.rounds) {
			if (r.byePlayerId === entrantId) {
				results.push({ round: r.number, opponentId: 'BYE', won: true, isTop: true });
				continue;
			}
			for (const m of r.matches) {
				if (!m.winnerId) continue;
				const isTop = m.topPlayerId === entrantId;
				const isBot = m.bottomPlayerId === entrantId;
				if (!isTop && !isBot) continue;
				results.push({
					round: r.number,
					opponentId: isTop ? m.bottomPlayerId : m.topPlayerId,
					won: m.winnerId === entrantId,
					topScore: m.topScore,
					bottomScore: m.bottomScore,
					isTop
				});
			}
		}
		return results;
	}

	function getBracketMatchesFor(entrantId: string, bracketName: 'main' | 'redemption') {
		const bracket = tournament?.brackets?.[bracketName];
		if (!bracket) return [];
		const results: { match: BracketMatch; isTop: boolean }[] = [];
		for (const m of bracket.matches) {
			const isTop = m.topPlayerId === entrantId;
			const isBot = m.bottomPlayerId === entrantId;
			if (isTop || isBot) results.push({ match: m, isTop });
		}
		return results.sort((a, b) => {
			const ra = a.match.round < 0 ? 1000 + Math.abs(a.match.round) : -a.match.round;
			const rb = b.match.round < 0 ? 1000 + Math.abs(b.match.round) : -b.match.round;
			return ra - rb;
		});
	}

	function finalStandingFor(entrantId: string) {
		return tournament?.finalStandings?.find((s) => s.entrantId === entrantId);
	}

	// ── Bracket helpers ───────────────────────────────────────────────────

	function matchLabel(match: BracketMatch, bracket: BracketState): string {
		if (match.id.includes('-GFR-')) return 'Grand Finals Reset';
		const positiveRounds = bracket.matches.filter((m) => m.round > 0 && !m.id.includes('-GFR-'));
		const maxWR = positiveRounds.length ? Math.max(...positiveRounds.map((m) => m.round)) : 1;
		const hasGFR = bracket.matches.some((m) => m.id.includes('-GFR-'));
		if (match.round === maxWR) return hasGFR ? 'Grand Final (pre-reset)' : 'Grand Final';
		if (match.round > 0) {
			if (match.round === maxWR - 1) return 'Winners Finals';
			if (match.round === maxWR - 2) return 'Winners Semis';
			return `Winners R${match.round}`;
		}
		const maxLR = bracket.matches.filter((m) => m.round < 0).reduce((mx, m) => Math.max(mx, Math.abs(m.round)), 0);
		const absR = Math.abs(match.round);
		if (absR === maxLR) return 'Losers Finals';
		if (absR === maxLR - 1) return 'Losers Semis';
		return `Losers R${absR}`;
	}

	// Group bracket matches by round label for display
	function bracketRoundGroups(bracket: BracketState): { label: string; matches: BracketMatch[] }[] {
		const groups = new Map<string, BracketMatch[]>();
		// Order: winners rounds asc, then GF, then losers rounds desc, then GFR
		const sorted = [...bracket.matches].sort((a, b) => {
			const key = (m: BracketMatch) => {
				if (m.id.includes('-GFR-')) return 10000;
				if (m.round > 0) return -m.round; // winners: higher round first (closest to GF)
				return 100 + Math.abs(m.round); // losers: lower abs = earlier
			};
			return key(a) - key(b);
		});
		for (const m of sorted) {
			const label = matchLabel(m, bracket);
			const g = groups.get(label) ?? [];
			g.push(m);
			groups.set(label, g);
		}
		return [...groups.entries()].map(([label, matches]) => ({ label, matches }));
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

	function getCurrentRound(): SwissRound | undefined {
		return tournament?.rounds.find((r) => r.status === 'active');
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

<div class="min-h-screen bg-gray-950 text-white">
	<!-- Header -->
	<div class="sticky top-0 z-30 border-b border-gray-800 bg-gray-950/95 backdrop-blur px-4 py-3">
		<div class="mx-auto max-w-3xl">
			<div class="flex items-center gap-3">
				<div class="flex-1 min-w-0">
					<div class="text-base font-bold text-violet-400 truncate">{tournament?.name ?? 'MSV Live'}</div>
					{#if tournament}
						<div class="text-xs text-gray-500">
							{tournament.phase === 'swiss'
								? `Swiss R${tournament.currentRound}/${tournament.settings.numRounds}`
								: tournament.phase === 'brackets' ? 'Brackets' : 'Completed'}
							· {tournament.entrants.length} players
						</div>
					{/if}
				</div>
			</div>

			<!-- Player search -->
			{#if tournament}
				<div class="relative mt-2">
					<input
						bind:value={searchQuery}
						oninput={() => { if (!searchQuery.trim()) selectedEntrantId = null; }}
						placeholder="Search player for match history…"
						class="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none" />
					{#if searchQuery && !selectedEntrantId}
						<div class="absolute top-full mt-1 left-0 w-full rounded-lg border border-gray-700 bg-gray-900 shadow-xl z-40">
							{#each matchedEntrants() as e}
								<button onclick={() => selectEntrant(e.id)}
									class="w-full flex items-center gap-2 px-3 py-2 text-sm text-white hover:bg-gray-700 text-left">
									<span class="text-gray-500 text-xs w-6 text-right shrink-0">#{e.initialSeed}</span>
									{e.gamerTag}
								</button>
							{:else}
								<div class="px-3 py-2 text-sm text-gray-500">No players found</div>
							{/each}
						</div>
					{/if}
					{#if selectedEntrantId}
						<button onclick={clearSearch}
							class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-lg leading-none">×</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<div class="mx-auto max-w-3xl px-4 py-6 space-y-8">

		{#if !tournament}
			<div class="rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
				No active tournament for this slug.
			</div>

		{:else if selectedEntrantId}
			<!-- ── Player history view (like /why) ── -->
			{@const entrant = getEntrant(selectedEntrantId)}
			{@const standing = finalStandingFor(selectedEntrantId)}
			{@const swissMatches = getSwissMatchesFor(selectedEntrantId)}
			{@const swissW = swissMatches.filter((m) => m.won).length}
			{@const swissL = swissMatches.filter((m) => !m.won && m.opponentId !== 'BYE').length}

			<div>
				<div class="flex items-center gap-3 flex-wrap">
					<h2 class="text-xl font-bold text-white">{entrant?.gamerTag}</h2>
					<span class="rounded-full bg-gray-800 px-3 py-0.5 text-xs text-gray-300">Seed #{entrant?.initialSeed}</span>
					<span class="rounded-full bg-gray-800 px-3 py-0.5 text-xs text-green-400">{swissW}W – {swissL}L Swiss</span>
					{#if standing}
						<span class="rounded-full px-3 py-0.5 text-xs {standing.bracket === 'main' ? 'bg-violet-900/60 text-violet-300' : 'bg-red-900/60 text-red-300'}">
							{standing.bracket === 'main' ? 'Main' : 'Redemption'} Bracket — Rank #{standing.rank}
						</span>
					{/if}
				</div>

				<!-- Swiss history -->
				{#if swissMatches.length > 0}
					<div class="mt-4">
						<h3 class="text-sm font-semibold text-gray-400 mb-2">Swiss</h3>
						<div class="space-y-1">
							{#each swissMatches as m}
								{@const opp = m.opponentId === 'BYE' ? null : getEntrant(m.opponentId)}
								<div class="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm">
									<span class="text-xs text-gray-500 w-12 shrink-0">R{m.round}</span>
									<span class="w-2 h-2 rounded-full shrink-0 {m.won ? 'bg-green-500' : 'bg-red-500'}"></span>
									<span class="{m.won ? 'text-green-300' : 'text-red-300'} font-medium w-8 shrink-0">{m.won ? 'W' : 'L'}</span>
									<span class="flex-1 text-white truncate">
										{m.opponentId === 'BYE' ? 'BYE' : (opp?.gamerTag ?? '?')}
									</span>
									{#if m.topScore !== undefined && m.bottomScore !== undefined}
										<span class="text-xs text-gray-400 shrink-0">
											{m.isTop ? `${m.topScore}–${m.bottomScore}` : `${m.bottomScore}–${m.topScore}`}
										</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Bracket history -->
				{#if tournament.brackets}
					{#each (['main', 'redemption'] as const) as bn}
						{@const bracketMatches = getBracketMatchesFor(selectedEntrantId, bn)}
						{#if bracketMatches.length > 0}
							<div class="mt-4">
								<h3 class="text-sm font-semibold text-gray-400 mb-2">
									{bn === 'main' ? 'Main' : 'Redemption'} Bracket
								</h3>
								<div class="space-y-1">
									{#each bracketMatches as { match, isTop }}
										{@const oppId = isTop ? match.bottomPlayerId : match.topPlayerId}
										{@const opp = getEntrant(oppId)}
										{@const won = match.winnerId === selectedEntrantId}
										{@const label = matchLabel(match, tournament.brackets![bn])}
										<div class="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm">
											<span class="text-xs text-gray-500 w-24 shrink-0 truncate">{label}</span>
											{#if match.winnerId}
												<span class="w-2 h-2 rounded-full shrink-0 {won ? 'bg-green-500' : 'bg-red-500'}"></span>
												<span class="{won ? 'text-green-300' : 'text-red-300'} font-medium w-8 shrink-0">{won ? 'W' : 'L'}</span>
											{:else}
												<span class="w-2 h-2 rounded-full shrink-0 bg-gray-600"></span>
												<span class="text-gray-500 w-8 shrink-0">—</span>
											{/if}
											<span class="flex-1 text-white truncate">{opp?.gamerTag ?? (oppId ? '?' : 'TBD')}</span>
											{#if match.topScore !== undefined && match.bottomScore !== undefined}
												<span class="text-xs text-gray-400 shrink-0">
													{isTop ? `${match.topScore}–${match.bottomScore}` : `${match.bottomScore}–${match.topScore}`}
												</span>
											{/if}
										</div>
										{#if match.topCharacters?.length || match.bottomCharacters?.length}
											<div class="flex gap-2 px-3 pb-1 text-xs text-gray-500">
												{#if isTop && match.topCharacters?.length}
													<span>{match.topCharacters.join(', ')}</span>
												{:else if !isTop && match.bottomCharacters?.length}
													<span>{match.bottomCharacters.join(', ')}</span>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							</div>
						{/if}
					{/each}
				{/if}
			</div>

		{:else}
			<!-- ── Full tournament view ── -->

			{#if tournament.phase === 'brackets' && tournament.brackets}
				<!-- Stream banner -->
				{#each (['main', 'redemption'] as const) as bn}
					{@const bracket = tournament.brackets[bn]}
					{@const streamMatch = bracket.matches.find((m) => m.isStream && !m.winnerId)}
					{#if streamMatch}
						<div class="rounded-xl border-2 border-red-500 bg-red-500/10 p-4 text-center">
							<div class="text-xs font-bold text-red-400 mb-1">🔴 STREAM · {matchLabel(streamMatch, bracket)}</div>
							<div class="text-lg font-semibold">
								{getEntrant(streamMatch.topPlayerId)?.gamerTag ?? '?'}
								<span class="text-gray-500 text-sm mx-2">vs</span>
								{getEntrant(streamMatch.bottomPlayerId)?.gamerTag ?? '?'}
							</div>
						</div>
					{/if}
				{/each}
			{/if}

			<!-- Swiss active round (if running) -->
			{#if tournament.phase === 'swiss'}
				{@const round = getCurrentRound()}
				{#if round}
					<div>
						<h2 class="text-base font-bold text-white mb-3">Round {round.number} — Active</h2>
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{#each round.matches.sort((a, b) => (a.station ?? 99) - (b.station ?? 99)) as match}
								{@const top = getEntrant(match.topPlayerId)}
								{@const bot = getEntrant(match.bottomPlayerId)}
								<div class="rounded-xl p-3 {match.isStream ? 'border-2 border-red-500 bg-red-500/10' : 'border border-gray-700 bg-gray-900'} {match.winnerId ? 'opacity-50' : ''}">
									<div class="text-xs font-bold {match.isStream ? 'text-red-400' : 'text-gray-500'} mb-1">
										{match.isStream ? 'STREAM' : `Stn ${match.station}`}
									</div>
									<div class="flex items-center gap-1 text-sm">
										<span class="{match.winnerId === match.topPlayerId ? 'text-green-300 font-semibold' : match.winnerId ? 'text-gray-500' : 'text-white'} truncate flex-1">{top?.gamerTag ?? '?'}</span>
										<span class="text-gray-600 shrink-0 text-xs">vs</span>
										<span class="{match.winnerId === match.bottomPlayerId ? 'text-green-300 font-semibold' : match.winnerId ? 'text-gray-500' : 'text-white'} truncate flex-1 text-right">{bot?.gamerTag ?? '?'}</span>
									</div>
									{#if match.winnerId && match.topScore !== undefined}
										<div class="text-xs text-center text-gray-400 mt-0.5">{match.topScore} – {match.bottomScore}</div>
									{/if}
								</div>
							{/each}
						</div>
						{#if round.byePlayerId}
							<div class="mt-2 text-xs text-yellow-400">BYE: {getEntrant(round.byePlayerId)?.gamerTag}</div>
						{/if}
					</div>
				{/if}
			{/if}

			<!-- Bracket views (when in brackets phase) -->
			{#if tournament.brackets}
				<!-- Bracket tab selector -->
				<div>
					<div class="flex gap-2 mb-4">
						<button onclick={() => showBracket = 'main'}
							class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors {showBracket === 'main' ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
							Main
						</button>
						<button onclick={() => showBracket = 'redemption'}
							class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors {showBracket === 'redemption' ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
							Redemption
						</button>
					</div>

					{#if tournament.brackets[showBracket]}
					{@const bracket = tournament.brackets[showBracket]}
					{@const totalM = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length}
					{@const doneM = bracket.matches.filter((m) => m.winnerId).length}
					<p class="text-xs text-gray-500 mb-3">{doneM}/{totalM} matches complete</p>
					<BracketView bracket={bracket} entrants={tournament.entrants} />
					{/if}
				</div>
			{/if}

			<!-- Swiss rounds history (all rounds, most recent first) -->
			{#if tournament.rounds.length > 0}
				<div>
					<h2 class="text-base font-bold text-white mb-3">Swiss Rounds</h2>
					<div class="space-y-4">
						{#each [...tournament.rounds].reverse() as round}
							<details open={round.status === 'active'}>
								<summary class="cursor-pointer select-none flex items-center gap-2 text-sm font-medium text-gray-300 hover:text-white">
									<span>Round {round.number}</span>
									<span class="rounded-full px-2 py-0.5 text-xs {round.status === 'active' ? 'bg-violet-900/50 text-violet-300' : 'bg-gray-800 text-gray-500'}">{round.status}</span>
									{#if round.byePlayerId}
										<span class="text-xs text-yellow-400">BYE: {getEntrant(round.byePlayerId)?.gamerTag}</span>
									{/if}
								</summary>
								<div class="mt-2 space-y-1 pl-2">
									{#each round.matches as match}
										{@const top = getEntrant(match.topPlayerId)}
										{@const bot = getEntrant(match.bottomPlayerId)}
										<div class="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-1.5 text-sm">
											<span class="text-xs {match.isStream ? 'text-violet-400' : 'text-gray-600'} w-14 shrink-0">
												{match.isStream ? 'STREAM' : `Stn ${match.station}`}
											</span>
											<span class="{match.winnerId === match.topPlayerId ? 'text-green-300 font-medium' : match.winnerId ? 'text-gray-500' : 'text-white'} flex-1 truncate">
												{top?.gamerTag ?? '?'}
											</span>
											{#if match.topScore !== undefined && match.bottomScore !== undefined}
												<span class="text-xs text-gray-500 shrink-0">{match.topScore}–{match.bottomScore}</span>
											{:else}
												<span class="text-xs text-gray-700 shrink-0">vs</span>
											{/if}
											<span class="{match.winnerId === match.bottomPlayerId ? 'text-green-300 font-medium' : match.winnerId ? 'text-gray-500' : 'text-white'} flex-1 truncate text-right">
												{bot?.gamerTag ?? '?'}
											</span>
										</div>
									{/each}
								</div>
							</details>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Standings -->
			{#if tournament.phase === 'swiss' && tournament.currentRound > 0}
				<details>
					<summary class="cursor-pointer select-none text-sm font-medium text-gray-400 hover:text-white">Standings</summary>
					<div class="mt-2 overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-gray-800 text-left text-xs text-gray-500">
									<th class="px-2 py-1.5">Tag</th>
									<th class="px-2 py-1.5 text-right">Seed</th>
									<th class="px-2 py-1.5 text-right">W</th>
									<th class="px-2 py-1.5 text-right">L</th>
								</tr>
							</thead>
							<tbody>
								{#each getStandings() as e}
									<tr class="border-b border-gray-800 hover:bg-gray-900/50">
										<td class="px-2 py-1.5 text-white">{e.gamerTag}</td>
										<td class="px-2 py-1.5 text-right font-mono text-gray-500 text-xs">#{e.initialSeed}</td>
										<td class="px-2 py-1.5 text-right font-mono text-green-400">{e.wins}</td>
										<td class="px-2 py-1.5 text-right font-mono text-red-400">{e.losses}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{/if}

			{#if tournament.phase === 'completed' && tournament.finalStandings}
				<div class="rounded-xl border border-gray-700 bg-gray-900 p-5 text-center">
					<p class="text-lg font-bold text-white">Tournament Complete</p>
					<p class="mt-1 text-sm text-gray-400">Champion: <span class="text-violet-300 font-semibold">{tournament.finalStandings[0]?.gamerTag}</span></p>
				</div>
			{/if}
		{/if}
	</div>
</div>
