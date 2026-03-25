<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState, BracketMatch, BracketState, Entrant } from '$lib/types/tournament';

	let tournament = $state<TournamentState | null>(null);
	let activeBracket = $state<'main' | 'redemption'>('main');
	let error = $state('');

	let reportingMatch = $state<BracketMatch | null>(null);
	let reportWinnerId = $state('');
	let reportScore = $state('');
	// Per-game character tracking: index = game number
	let gameTopChars = $state<string[]>([]);
	let gameBotChars = $state<string[]>([]);
	let gameTopSearch = $state<string[]>([]);
	let gameBotSearch = $state<string[]>([]);

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

	function filteredChars(search: string, already: string[]): string[] {
		if (!search.trim()) return [];
		const q = search.toLowerCase();
		return CHARACTERS.filter((c) => c.toLowerCase().includes(q) && !already.includes(c)).slice(0, 8);
	}

	// Simple color from character name hash for visual distinction
	function charColor(name: string): string {
		const colors = ['#7c3aed','#dc2626','#d97706','#16a34a','#0284c7','#db2777','#65a30d','#0891b2','#7c2d12','#4338ca'];
		let h = 0;
		for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
		return colors[h % colors.length];
	}

	function numGames(score: string): number {
		const [w, l] = score.split('-').map(Number);
		return w + l;
	}

	function resizeGameArrays(n: number) {
		gameTopChars = Array.from({ length: n }, (_, i) => gameTopChars[i] ?? '');
		gameBotChars = Array.from({ length: n }, (_, i) => gameBotChars[i] ?? '');
		gameTopSearch = Array.from({ length: n }, (_, i) => gameTopSearch[i] ?? '');
		gameBotSearch = Array.from({ length: n }, (_, i) => gameBotSearch[i] ?? '');
	}

	function setScore(s: string) {
		reportScore = s;
		resizeGameArrays(numGames(s));
	}

	function setGameChar(side: 'top' | 'bot', gameIdx: number, char: string) {
		if (side === 'top') {
			gameTopChars = gameTopChars.map((v, i) => i === gameIdx ? char : v);
			gameTopSearch = gameTopSearch.map((v, i) => i === gameIdx ? '' : v);
		} else {
			gameBotChars = gameBotChars.map((v, i) => i === gameIdx ? char : v);
			gameBotSearch = gameBotSearch.map((v, i) => i === gameIdx ? '' : v);
		}
	}

	function clearGameChar(side: 'top' | 'bot', gameIdx: number) {
		if (side === 'top') gameTopChars = gameTopChars.map((v, i) => i === gameIdx ? '' : v);
		else gameBotChars = gameBotChars.map((v, i) => i === gameIdx ? '' : v);
	}

	// ── Layout constants ──────────────────────────────────────────────────
	const CARD_W = 192;
	const CARD_H = 100;
	const H_GAP = 40;
	const BASE_SLOT_H = 120;

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
		if (match.id.includes('-GFR-')) return true;
		const totalPlayers = bracket.players.length;
		if (totalPlayers <= 8) return true;
		const maxWinnersRound = Math.max(...bracket.matches.filter((m) => m.round > 0).map((m) => m.round));
		if (match.round > 0) return match.round >= maxWinnersRound - 2;
		return match.round <= -(Math.max(...bracket.matches.filter((m) => m.round < 0).map((m) => Math.abs(m.round))) - 3);
	}

	/** Redemption finals: only WF, LF, GF, GFR are BO5 */
	function isFinalsMatch(match: BracketMatch, bracket: BracketState): boolean {
		if (match.id.includes('-GFR-')) return true;
		const positiveRounds = bracket.matches.filter((m) => m.round > 0 && !m.id.includes('-GFR-'));
		if (positiveRounds.length === 0) return false;
		const maxWR = Math.max(...positiveRounds.map((m) => m.round));
		// GF = maxWR, WF = maxWR - 1
		if (match.round >= maxWR - 1) return true;
		const negativeRounds = bracket.matches.filter((m) => m.round < 0);
		if (negativeRounds.length === 0) return false;
		const maxLR = Math.max(...negativeRounds.map((m) => Math.abs(m.round)));
		return match.round === -maxLR;
	}

	function openReport(match: BracketMatch) {
		reportingMatch = match;
		reportWinnerId = match.winnerId ?? '';
		reportScore = '';
		gameTopChars = [];
		gameBotChars = [];
		gameTopSearch = [];
		gameBotSearch = [];
		// Pre-fill from existing characters (restore per-game if available)
		if (match.topCharacters?.length || match.bottomCharacters?.length) {
			const existing = match.topCharacters ?? match.bottomCharacters ?? [];
			resizeGameArrays(existing.length || 1);
			if (match.topCharacters) match.topCharacters.forEach((c, i) => { gameTopChars[i] = c; });
			if (match.bottomCharacters) match.bottomCharacters.forEach((c, i) => { gameBotChars[i] = c; });
		}
	}

	function parseScore(score: string, winnerId: string, match: BracketMatch): [number, number] {
		const winnerIsTop = winnerId === match.topPlayerId;
		const [w, l] = score.split('-').map(Number);
		return winnerIsTop ? [w, l] : [l, w];
	}

	async function submitReport() {
		if (!reportingMatch || !reportWinnerId || !reportScore) return;
		error = '';

		const [topScore, bottomScore] = parseScore(reportScore, reportWinnerId, reportingMatch);
		const topCharacters = gameTopChars.filter(Boolean);
		const bottomCharacters = gameBotChars.filter(Boolean);

		const res = await fetch('/api/tournament/bracket', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				bracketName: activeBracket,
				matchId: reportingMatch.id,
				winnerId: reportWinnerId,
				topCharacters: topCharacters.length ? topCharacters : undefined,
				bottomCharacters: bottomCharacters.length ? bottomCharacters : undefined,
				topScore,
				bottomScore
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

<main class="mx-auto max-w-7xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<div class="mt-4 flex flex-wrap items-center gap-4">
		<h1 class="text-2xl font-bold text-white">Brackets</h1>
		{#if tournament}
			<a href="/live/{tournament.slug}" target="_blank" class="text-xs text-gray-500 hover:text-violet-400">
				Live: /live/{tournament.slug} ↗
			</a>
			<a href="/api/tournament/export?slug={tournament.slug}" target="_blank"
				class="ml-auto text-xs text-gray-500 hover:text-violet-400">
				Export JSON ↗
			</a>
		{/if}
	</div>

	{#if error}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">{error}</div>
	{/if}

	{#if !tournament?.brackets}
		<div class="mt-6 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
			No brackets yet. Complete Swiss rounds first.
			<a href="/dashboard/tournament/swiss" class="block mt-2 text-violet-400 hover:text-violet-300">Go to Swiss &rarr;</a>
		</div>
	{:else}
		<!-- Bracket selector -->
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
			{@const layout = computeLayout(bracket)}
			{@const maxRound = Math.max(...bracket.matches.map((m) => m.round))}
			{@const totalMatches = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length}
			{@const doneMatches = bracket.matches.filter((m) => m.winnerId).length}

			<div class="mt-2 text-xs text-gray-500">
				{bracket.players.length} players · {doneMatches}/{totalMatches} matches complete
				{#if bracket.matches.some((m) => m.isStream && !m.winnerId)}
					{@const streamM = bracket.matches.find((m) => m.isStream && !m.winnerId)!}
					· <span class="text-violet-400">Stream: {getEntrant(streamM.topPlayerId)?.gamerTag} vs {getEntrant(streamM.bottomPlayerId)?.gamerTag}</span>
				{/if}
			</div>

			<!-- Visual bracket (scrollable) -->
			<div class="mt-4 overflow-x-auto overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-4"
				style="max-height: 80vh">
				<div class="relative" style="width: {layout.width}px; height: {layout.height}px">
					<!-- Connector SVG -->
					<svg class="absolute inset-0 pointer-events-none overflow-visible"
						width={layout.width} height={layout.height}>
						{#each layout.connectors as c}
							<!-- Horizontal right arm from match -->
							<line x1={c.x1} y1={c.y1} x2={c.mx} y2={c.y1} stroke="#374151" stroke-width="1.5" />
							<!-- Vertical to next match's y level -->
							{#if c.y1 !== c.y2}
								<line x1={c.mx} y1={c.y1} x2={c.mx} y2={c.y2} stroke="#374151" stroke-width="1.5" />
							{/if}
							<!-- Horizontal arm into next match -->
							<line x1={c.mx} y1={c.y2} x2={c.x2} y2={c.y2} stroke="#374151" stroke-width="1.5" />
						{/each}
					</svg>

					<!-- Match cards -->
					{#each layout.matchPositions as { match, x, y }}
						{@const top = getEntrant(match.topPlayerId)}
						{@const bot = getEntrant(match.bottomPlayerId)}
						{@const ready = !match.winnerId && !!match.topPlayerId && !!match.bottomPlayerId}
						{@const showChars = isTop8Match(match, bracket)}

						<div class="absolute rounded-lg border bg-gray-900 overflow-hidden"
							style="left: {x}px; top: {y}px; width: {CARD_W}px"
							class:border-violet-600={match.isStream && ready}
							class:border-gray-700={!match.isStream || !ready}>

							<!-- Top player row -->
							<div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-800
								{match.winnerId === match.topPlayerId ? 'bg-green-900/20' :
								 match.winnerId && match.topPlayerId ? 'opacity-40' : ''}">
								<span class="text-xs text-gray-500 w-6 text-right shrink-0">
									{tournament?.entrants.find((e) => e.id === match.topPlayerId)
										? `#${tournament!.entrants.find((e) => e.id === match.topPlayerId)!.initialSeed}`
										: ''}
								</span>
								<span class="flex-1 truncate text-sm {match.winnerId === match.topPlayerId ? 'text-green-300 font-medium' : 'text-white'}">
									{top?.gamerTag ?? (match.topPlayerId ? '?' : '—')}
								</span>
								{#if match.topScore !== undefined}
									<span class="text-xs font-mono {match.winnerId === match.topPlayerId ? 'text-green-400' : 'text-gray-500'} shrink-0">
										{match.topScore}
									</span>
								{/if}
							</div>

							<!-- Bottom player row -->
							<div class="flex items-center gap-1.5 px-2 py-1.5
								{match.winnerId === match.bottomPlayerId ? 'bg-green-900/20' :
								 match.winnerId && match.bottomPlayerId ? 'opacity-40' : ''}">
								<span class="text-xs text-gray-500 w-6 text-right shrink-0">
									{tournament?.entrants.find((e) => e.id === match.bottomPlayerId)
										? `#${tournament!.entrants.find((e) => e.id === match.bottomPlayerId)!.initialSeed}`
										: ''}
								</span>
								<span class="flex-1 truncate text-sm {match.winnerId === match.bottomPlayerId ? 'text-green-300 font-medium' : 'text-white'}">
									{bot?.gamerTag ?? (match.bottomPlayerId ? '?' : '—')}
								</span>
								{#if match.bottomScore !== undefined}
									<span class="text-xs font-mono {match.winnerId === match.bottomPlayerId ? 'text-green-400' : 'text-gray-500'} shrink-0">
										{match.bottomScore}
									</span>
								{/if}
							</div>

							<!-- Characters used (top 8, shown after report) -->
							{#if match.winnerId && (match.topCharacters?.length || match.bottomCharacters?.length)}
								<div class="px-2 py-1 text-xs text-gray-500 border-t border-gray-800 leading-relaxed">
									{#if match.topCharacters?.length}<span class="text-gray-400">{getEntrant(match.topPlayerId)?.gamerTag}:</span> {match.topCharacters.join(', ')}{/if}{#if match.topCharacters?.length && match.bottomCharacters?.length} · {/if}{#if match.bottomCharacters?.length}<span class="text-gray-400">{getEntrant(match.bottomPlayerId)?.gamerTag}:</span> {match.bottomCharacters.join(', ')}{/if}
								</div>
							{/if}

							<!-- Footer: station label + report/fix button -->
							{#if ready || match.winnerId}
								<div class="flex items-center justify-between px-2 py-1 border-t border-gray-800 bg-gray-900/50">
									{#if match.station !== undefined}
										<span class="text-xs {match.isStream ? 'text-violet-400' : 'text-gray-500'}">
											{match.isStream ? 'STREAM' : `Stn ${match.station}`}
										</span>
									{:else}
										<span></span>
									{/if}
									{#if ready}
										<button onclick={() => openReport(match)}
											class="rounded bg-violet-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-violet-600">
											Report
										</button>
									{:else if match.winnerId && match.topPlayerId && match.bottomPlayerId}
										<button onclick={() => openReport(match)}
											class="rounded border border-yellow-700/50 px-2 py-0.5 text-xs text-yellow-500 hover:bg-yellow-900/20">
											Fix
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Report modal -->
			{#if reportingMatch}
				{@const top = getEntrant(reportingMatch.topPlayerId)}
				{@const bot = getEntrant(reportingMatch.bottomPlayerId)}
				{@const isTop8 = bracket ? isTop8Match(reportingMatch, bracket) : false}
				{@const isBo5 = activeBracket === 'main' ? isTop8 : (bracket ? isFinalsMatch(reportingMatch, bracket) : false)}
				{@const showChars = isTop8}

				<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
					<div class="w-full max-w-sm rounded-xl bg-gray-900 border border-gray-700 p-5">
						<div class="flex items-start justify-between">
							<div>
								<h3 class="text-base font-semibold text-white">Report Match</h3>
								<p class="text-sm text-gray-400 mt-0.5">{top?.gamerTag ?? '?'} vs {bot?.gamerTag ?? '?'}</p>
							</div>
							<span class="text-xs rounded-full px-2 py-0.5 {isBo5 ? 'bg-violet-900/60 text-violet-300' : 'bg-gray-800 text-gray-400'}">
								{isBo5 ? 'BO5' : 'BO3'}
							</span>
						</div>

						<!-- Step 1: Pick winner -->
						<div class="mt-4 flex gap-2">
							<button onclick={() => { reportWinnerId = reportingMatch!.topPlayerId!; reportScore = ''; }}
								class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors {reportWinnerId === reportingMatch.topPlayerId ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
								{top?.gamerTag ?? '?'}
							</button>
							<button onclick={() => { reportWinnerId = reportingMatch!.bottomPlayerId!; reportScore = ''; }}
								class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors {reportWinnerId === reportingMatch.bottomPlayerId ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
								{bot?.gamerTag ?? '?'}
							</button>
						</div>

						<!-- Step 2: Pick score (BO3 or BO5) -->
						{#if reportWinnerId}
							{#if isBo5}
								<div class="mt-3 grid grid-cols-3 gap-2">
									{#each ['3-0', '3-1', '3-2'] as s}
										<button onclick={() => setScore(s)}
											class="rounded-lg py-2 text-sm font-medium transition-colors {reportScore === s ? 'bg-violet-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
											{s.replace('-', ' – ')}
										</button>
									{/each}
								</div>
							{:else}
								<div class="mt-3 flex gap-2">
									{#each ['2-0', '2-1'] as s}
										<button onclick={() => setScore(s)}
											class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors {reportScore === s ? 'bg-violet-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
											{s.replace('-', ' – ')}
										</button>
									{/each}
								</div>
							{/if}
						{/if}

						<!-- Step 3: Per-game character tracking (top 8 only) -->
						{#if reportWinnerId && reportScore && showChars}
							<div class="mt-3">
								<p class="text-xs font-medium text-gray-400 mb-2">Characters by game</p>
								<div class="space-y-2 max-h-64 overflow-y-auto">
								{#each Array.from({length: numGames(reportScore)}, (_, i) => i) as gameIdx}
									<div class="rounded-lg border border-gray-800 bg-gray-800/50 p-2">
										<div class="text-xs text-gray-500 mb-1.5">Game {gameIdx + 1}</div>
										<div class="grid grid-cols-2 gap-2">
											<div class="relative">
												{#if gameTopChars[gameIdx]}
													<div class="flex items-center gap-1 rounded bg-violet-700/30 px-2 py-1 text-xs text-white">
														<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(gameTopChars[gameIdx])}"></span>
														<span class="flex-1 truncate">{gameTopChars[gameIdx]}</span>
														<button type="button" onclick={() => clearGameChar('top', gameIdx)} class="text-gray-400 hover:text-white leading-none">×</button>
													</div>
												{:else}
													<input bind:value={gameTopSearch[gameIdx]} placeholder="{top?.gamerTag ?? 'Top'}…"
														class="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none" />
													{#if gameTopSearch[gameIdx]}
														<div class="absolute z-20 top-full left-0 mt-0.5 w-full rounded-lg border border-gray-700 bg-gray-900 shadow-xl max-h-36 overflow-y-auto">
															{#each filteredChars(gameTopSearch[gameIdx], []) as char}
																<button type="button" onclick={() => setGameChar('top', gameIdx, char)}
																	class="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-white hover:bg-gray-700 text-left">
																	<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(char)}"></span>
																	{char}
																</button>
															{:else}<div class="px-2 py-1.5 text-xs text-gray-500">No match</div>{/each}
														</div>
													{/if}
												{/if}
											</div>
											<div class="relative">
												{#if gameBotChars[gameIdx]}
													<div class="flex items-center gap-1 rounded bg-violet-700/30 px-2 py-1 text-xs text-white">
														<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(gameBotChars[gameIdx])}"></span>
														<span class="flex-1 truncate">{gameBotChars[gameIdx]}</span>
														<button type="button" onclick={() => clearGameChar('bot', gameIdx)} class="text-gray-400 hover:text-white leading-none">×</button>
													</div>
												{:else}
													<input bind:value={gameBotSearch[gameIdx]} placeholder="{bot?.gamerTag ?? 'Bot'}…"
														class="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none" />
													{#if gameBotSearch[gameIdx]}
														<div class="absolute z-20 top-full left-0 mt-0.5 w-full rounded-lg border border-gray-700 bg-gray-900 shadow-xl max-h-36 overflow-y-auto">
															{#each filteredChars(gameBotSearch[gameIdx], []) as char}
																<button type="button" onclick={() => setGameChar('bot', gameIdx, char)}
																	class="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-white hover:bg-gray-700 text-left">
																	<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(char)}"></span>
																	{char}
																</button>
															{:else}<div class="px-2 py-1.5 text-xs text-gray-500">No match</div>{/each}
														</div>
													{/if}
												{/if}
											</div>
										</div>
									</div>
								{/each}
								</div>
							</div>
						{/if}
												<div class="mt-5 flex gap-2">
							<button onclick={submitReport} disabled={!reportWinnerId || !reportScore}
								class="flex-1 rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
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
		{/if}
	{/if}
</main>
