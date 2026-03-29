<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState, BracketMatch, BracketState, Entrant } from '$lib/types/tournament';
	import BracketView from '$lib/components/BracketView.svelte';

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
			gameTopChars = gameTopChars.map((v, i) => i === gameIdx || (i > gameIdx && v === '') ? char : v);
			gameTopSearch = gameTopSearch.map((v, i) => i === gameIdx ? '' : v);
		} else {
			gameBotChars = gameBotChars.map((v, i) => i === gameIdx || (i > gameIdx && v === '') ? char : v);
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

	async function callMatch(match: BracketMatch) {
		await fetch('/api/tournament/bracket/call', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bracketName: activeBracket, matchId: match.id })
		});
		await loadTournament();
	}

	async function setStreamMatch(match: BracketMatch) {
		await fetch('/api/tournament/bracket/stream', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bracketName: activeBracket, matchId: match.id })
		});
		await loadTournament();
	}

	let mainEventUrl = $state('');
	let redemptionEventUrl = $state('');
	let linkingEvents = $state(false);
	let linkResult = $state('');

	async function linkBracketEvents() {
		if (!mainEventUrl.trim() && !redemptionEventUrl.trim()) return;
		linkingEvents = true;
		linkResult = '';
		const res = await fetch('/api/tournament/bracket-events', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mainEventSlug: mainEventUrl.trim() || undefined,
				redemptionEventSlug: redemptionEventUrl.trim() || undefined
			})
		});
		const data = await res.json();
		if (res.ok) { linkResult = 'Linked!'; await loadTournament(); }
		else linkResult = data.error ?? 'Failed';
		linkingEvents = false;
	}

	let splitConfirming = $state(false);
	let splitResult = $state<{ reported: number; failed: number } | null>(null);

	async function confirmSplit() {
		splitConfirming = true;
		splitResult = null;
		const res = await fetch('/api/tournament/startgg-sync', { method: 'POST' });
		const data = await res.json().catch(() => ({}));
		if (res.ok) splitResult = { reported: data.reported, failed: data.failed };
		else error = (data as { error?: string }).error ?? 'Failed to confirm split';
		splitConfirming = false;
		await loadTournament();
	}

	async function clearStartggErrors() {
		await fetch('/api/tournament/startgg-sync', { method: 'DELETE' });
		await loadTournament();
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

	<!-- StartGG split confirmation -->
	{#if tournament && !tournament.startggSync?.splitConfirmed}
		<div class="mt-4 rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3">
			<p class="text-sm text-amber-300">
				<span class="font-semibold">StartGG:</span> Correct the main/redemption bracket split in StartGG&#8217;s phase 2 before
				confirming. Match results reported here are <strong>queued</strong> until you click Split Done.
			</p>
			<div class="mt-2 flex items-center gap-3">
				<button
					onclick={confirmSplit}
					disabled={splitConfirming}
					class="rounded-lg bg-amber-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 transition-colors"
				>
					{splitConfirming ? 'Flushing...' : 'Split Done'}
				</button>
				{#if splitResult}
					<span class="text-xs text-gray-400">
						Flushed {splitResult.reported} match(es)
						{#if splitResult.failed > 0}<span class="text-red-400">, {splitResult.failed} failed (see errors below)</span>{/if}
					</span>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Link StartGG bracket events -->
	{#if tournament && (!tournament.startggMainBracketEventId || !tournament.startggRedemptionBracketEventId)}
		<div class="mt-4 rounded-lg border border-gray-700 bg-gray-800/40 px-4 py-3">
			<p class="text-sm text-gray-300 font-medium">Link StartGG Bracket Events</p>
			<p class="text-xs text-gray-500 mt-1">Paste the StartGG event URLs for main and redemption brackets to enable result sync.</p>
			<div class="mt-2 grid grid-cols-2 gap-2">
				<input bind:value={mainEventUrl} placeholder="Main bracket event URL"
					class="rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none" />
				<input bind:value={redemptionEventUrl} placeholder="Redemption bracket event URL"
					class="rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none" />
			</div>
			<div class="mt-2 flex items-center gap-2">
				<button onclick={linkBracketEvents} disabled={linkingEvents}
					class="rounded bg-violet-700 px-3 py-1 text-xs font-medium text-white hover:bg-violet-600 disabled:opacity-50">
					{linkingEvents ? 'Linking...' : 'Link Events'}
				</button>
				{#if linkResult}<span class="text-xs text-gray-400">{linkResult}</span>{/if}
				{#if tournament.startggMainBracketEventId}<span class="text-xs text-green-400">Main: linked</span>{/if}
				{#if tournament.startggRedemptionBracketEventId}<span class="text-xs text-green-400">Redemption: linked</span>{/if}
			</div>
		</div>
	{/if}

	<!-- StartGG errors -->
	{#if tournament?.startggSync?.errors?.length}
		<div class="mt-3 space-y-1">
			{#each tournament.startggSync.errors as err}
				<div class="flex items-start gap-2 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
					<span class="shrink-0 font-semibold">StartGG error</span>
					<span class="min-w-0 break-words">{err.message}</span>
				</div>
			{/each}
			<button onclick={clearStartggErrors} class="text-xs text-gray-600 hover:text-gray-400 transition-colors">Clear errors</button>
		</div>
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
			{@const totalMatches = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length}
			{@const doneMatches = bracket.matches.filter((m) => m.winnerId).length}
			{@const readyMatches = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId)}
			{@const calledMatches = readyMatches.filter((m) => m.calledAt)}

			<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
				<span>{bracket.players.length} players · {doneMatches}/{totalMatches} matches complete</span>
				{#if readyMatches.length > 0}
					<span class="{calledMatches.length === readyMatches.length ? 'text-green-400' : 'text-gray-400'}">
						{calledMatches.length}/{readyMatches.length} called
						{#if calledMatches.length === readyMatches.length}&nbsp;✓{/if}
					</span>
				{/if}
				{#if bracket.matches.some((m) => m.isStream && !m.winnerId)}
					{@const streamM = bracket.matches.find((m) => m.isStream && !m.winnerId)!}
					<span class="text-violet-400">Stream: {getEntrant(streamM.topPlayerId)?.gamerTag} vs {getEntrant(streamM.bottomPlayerId)?.gamerTag}</span>
				{/if}
			</div>

			<!-- Visual bracket (scrollable) -->
			<div class="mt-4">
				<BracketView
					bracket={bracket}
					entrants={tournament!.entrants}
					onReport={openReport}
					onCall={callMatch}
					onStream={setStreamMatch} />
			</div>

			<!-- Report modal -->
			{#if reportingMatch}
				{@const top = getEntrant(reportingMatch.topPlayerId)}
				{@const bot = getEntrant(reportingMatch.bottomPlayerId)}
				{@const isTop8 = bracket ? isTop8Match(reportingMatch, bracket) : false}
				{@const isBo5 = activeBracket === 'main' ? isTop8 : (bracket ? isFinalsMatch(reportingMatch, bracket) : false)}
				{@const showChars = isBo5}

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
