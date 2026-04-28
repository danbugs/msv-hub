<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState, BracketMatch, BracketState, Entrant } from '$lib/types/tournament';
	import BracketView from '$lib/components/BracketView.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';

	let tournament = $state<TournamentState | null>(null);
	let activeBracket = $state<'main' | 'redemption'>('main');
	let error = $state('');

	let reportingMatch = $state<BracketMatch | null>(null);
	let reportWinnerId = $state('');
	let reportScore = $state('');
	let submittingReport = $state(false);
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
		'Kazuya', 'Sora', 'Mii Brawler', 'Mii Swordfighter', 'Mii Gunner'
	];

	function filteredChars(search: string, already: string[]): string[] {
		if (!search.trim()) return [];
		const q = search.toLowerCase();
		// Rank: exact match > starts-with > contains > word-start match (covers "K. Rool" for "rool")
		function rank(name: string): number {
			const n = name.toLowerCase();
			if (n === q) return 0;
			if (n.startsWith(q)) return 1;
			// any word in the name starts with q
			if (n.split(/\s+|\./).some((w) => w.startsWith(q))) return 2;
			if (n.includes(q)) return 3;
			return 99;
		}
		return CHARACTERS
			.filter((c) => c.toLowerCase().includes(q) && !already.includes(c))
			.map((c) => [c, rank(c)] as const)
			.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
			.map(([c]) => c)
			.slice(0, 8);
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

	// Per-game winner: 'top' or 'bottom' for each game
	let gameWinners = $state<('top' | 'bottom')[]>([]);

	// Cache for game rows that get shrunk off (so expanding again restores them)
	let gameTopCharsCache: string[] = [];
	let gameBotCharsCache: string[] = [];

	function resizeGameArrays(n: number) {
		// Save entries we're about to drop so a later expansion can restore them
		for (let i = n; i < gameTopChars.length; i++) if (gameTopChars[i]) gameTopCharsCache[i] = gameTopChars[i];
		for (let i = n; i < gameBotChars.length; i++) if (gameBotChars[i]) gameBotCharsCache[i] = gameBotChars[i];

		gameTopChars = Array.from({ length: n }, (_, i) => gameTopChars[i] || gameTopCharsCache[i] || '');
		gameBotChars = Array.from({ length: n }, (_, i) => gameBotChars[i] || gameBotCharsCache[i] || '');
		gameTopSearch = Array.from({ length: n }, (_, i) => gameTopSearch[i] ?? '');
		gameBotSearch = Array.from({ length: n }, (_, i) => gameBotSearch[i] ?? '');
	}

	function setScore(s: string) {
		reportScore = s;
		if (s === 'DQ') { gameWinners = []; resizeGameArrays(0); return; }
		const [wScore, lScore] = s.split('-').map(Number);
		const total = wScore + lScore;
		resizeGameArrays(total);

		// Pre-populate game winners: W,W,...,L,...,W pattern
		const winnerSide: 'top' | 'bottom' = reportWinnerId === reportingMatch?.topPlayerId ? 'top' : 'bottom';
		const loserSide: 'top' | 'bottom' = winnerSide === 'top' ? 'bottom' : 'top';
		const pattern: ('top' | 'bottom')[] = [];
		const winnerFirstBatch = lScore > 0 ? wScore - 1 : wScore;
		for (let i = 0; i < winnerFirstBatch; i++) pattern.push(winnerSide);
		for (let i = 0; i < lScore; i++) pattern.push(loserSide);
		if (lScore > 0) pattern.push(winnerSide);
		gameWinners = pattern;
	}

	function toggleGameWinner(gameIdx: number) {
		if (!reportingMatch) return;
		// Toggle the specified game, then walk the sequence to find the first point where
		// someone reaches 3 wins. That determines the final score + match winner, and
		// trims/extends the game list to match.
		const toggled = gameWinners.map((w, i) => i === gameIdx ? (w === 'top' ? 'bottom' : 'top') : w);

		// First, walk forward and stop when either side reaches 3 wins (set is over).
		const clipped: ('top' | 'bottom')[] = [];
		let topCount = 0, botCount = 0;
		for (const w of toggled) {
			clipped.push(w);
			if (w === 'top') topCount++;
			else botCount++;
			if (topCount >= 3 || botCount >= 3) break;
		}

		// If no one has reached 3 yet, pad remaining games so the in-progress leader takes it.
		if (topCount < 3 && botCount < 3) {
			const leader: 'top' | 'bottom' = topCount >= botCount ? 'top' : 'bottom';
			while ((leader === 'top' ? topCount : botCount) < 3) {
				clipped.push(leader);
				if (leader === 'top') topCount++;
				else botCount++;
			}
		}

		gameWinners = clipped;

		// Update reportScore based on final counts
		const finalWinnerWins = Math.max(topCount, botCount);
		const finalLoserWins = Math.min(topCount, botCount);
		reportScore = `${finalWinnerWins}-${finalLoserWins}`;

		// Match winner = side with more wins
		const matchWinnerSide: 'top' | 'bottom' = topCount > botCount ? 'top' : 'bottom';
		const newWinnerId = matchWinnerSide === 'top' ? reportingMatch.topPlayerId : reportingMatch.bottomPlayerId;
		if (newWinnerId && newWinnerId !== reportWinnerId) {
			reportWinnerId = newWinnerId;
		}

		// Resize character arrays to match game count (preserves existing entries where possible)
		resizeGameArrays(clipped.length);
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
		gameWinners = [];
		gameTopCharsCache = [];
		gameBotCharsCache = [];
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
	let discoveredEvents = $state<{ main: { id: number; name: string } | null; redemption: { id: number; name: string } | null } | null>(null);
	let discovering = $state(false);

	async function discoverBracketEvents() {
		discovering = true;
		const res = await fetch('/api/tournament/bracket-events');
		if (res.ok) {
			const data = await res.json();
			discoveredEvents = data.suggested;
		}
		discovering = false;
	}

	async function linkBracketEvents(useDiscovered = false) {
		linkingEvents = true;
		linkResult = '';
		const body: Record<string, unknown> = {};
		if (useDiscovered && discoveredEvents) {
			if (discoveredEvents.main) body.mainEventId = discoveredEvents.main.id;
			if (discoveredEvents.redemption) body.redemptionEventId = discoveredEvents.redemption.id;
		} else {
			if (mainEventUrl.trim()) body.mainEventSlug = mainEventUrl.trim();
			if (redemptionEventUrl.trim()) body.redemptionEventSlug = redemptionEventUrl.trim();
		}
		if (!Object.keys(body).length) { linkingEvents = false; return; }
		const res = await fetch('/api/tournament/bracket-events', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
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

	let syncingFromStartGG = $state(false);
	let syncResult = $state('');
	async function syncFromStartGG() {
		if (!confirm(`Sync ${activeBracket} bracket from StartGG? This overwrites MSV Hub's bracket state with StartGG's current results.`)) return;
		syncingFromStartGG = true;
		syncResult = '';
		const res = await fetch('/api/tournament/bracket/sync-from-startgg', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bracketName: activeBracket })
		});
		const data = await res.json();
		if (res.ok) {
			const dbg = data.debug ? `\n\n${data.debug.join('\n')}` : '';
			syncResult = `Synced ${data.synced}/${data.totalSetsOnStartGG} matches (${data.notFound} unmatched)${dbg}`;
		}
		else error = data.error ?? 'Sync failed';
		syncingFromStartGG = false;
		await loadTournament();
	}

	async function submitReport() {
		if (!reportingMatch || !reportWinnerId || !reportScore || submittingReport) return;
		error = '';
		submittingReport = true;

		const isDQ = reportScore === 'DQ';
		const [topScore, bottomScore] = isDQ ? [0, 0] : parseScore(reportScore, reportWinnerId, reportingMatch);
		const topCharacters = isDQ ? [] : gameTopChars.filter(Boolean);
		const bottomCharacters = isDQ ? [] : gameBotChars.filter(Boolean);

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
				bottomScore,
				isDQ: isDQ || undefined,
				gameWinners: !isDQ && reportScore.startsWith('3-') && gameWinners.length ? gameWinners : undefined
			})
		});

		if (!res.ok) {
			const data = await res.json();
			error = data.error ?? 'Failed to report match';
			submittingReport = false;
		} else {
			reportingMatch = null;
			await loadTournament();
			submittingReport = false;
		}
	}
</script>

<main class="px-4 py-8">
	<a href="/dashboard" class="text-sm text-primary hover:text-primary/80">&larr; Dashboard</a>
	<div class="mt-4 flex flex-wrap items-center gap-4">
		<h1 class="text-2xl font-bold text-foreground">Brackets</h1>
		{#if tournament}
			<a href="/live/{tournament.slug}" target="_blank" class="text-xs text-muted-foreground hover:text-primary">
				Live: /live/{tournament.slug} ↗
			</a>
			<a href="/api/tournament/export?slug={tournament.slug}" target="_blank"
				class="ml-auto text-xs text-muted-foreground hover:text-primary">
				Export JSON ↗
			</a>
		{/if}
	</div>

	{#if error}
		<div class="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
	{/if}

	<!-- StartGG split confirmation -->
	{#if tournament && !tournament.startggSync?.splitConfirmed}
		<div class="mt-4 rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3">
			<p class="text-sm text-amber-300">
				<span class="font-semibold">StartGG:</span> Click <strong>Run Bracket Split</strong> to automatically assign players
				to Main and Redemption bracket events on StartGG, push seeding, and start reporting.
			</p>
			<div class="mt-2 flex items-center gap-3">
				<Button onclick={confirmSplit} disabled={splitConfirming} size="sm">
					{splitConfirming ? 'Assigning players & seeding...' : 'Run Bracket Split'}
				</Button>
				{#if splitResult}
					<span class="text-xs text-muted-foreground">
						Flushed {splitResult.reported} match(es)
						{#if splitResult.failed > 0}<span class="text-red-400">, {splitResult.failed} failed (see errors below)</span>{/if}
					</span>
				{/if}
				{#if tournament.startggMainBracketEventId}
					<span class="text-xs text-green-400">Main: linked</span>
				{/if}
				{#if tournament.startggRedemptionBracketEventId}
					<span class="text-xs text-green-400">Redemption: linked</span>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Bracket events are auto-linked during bracket generation. No manual step needed. -->

	<!-- StartGG errors -->
	{#if tournament?.startggSync?.errors?.length}
		<div class="mt-3 space-y-1">
			{#each tournament.startggSync.errors as err}
				<div class="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					<span class="shrink-0 font-semibold">StartGG error</span>
					<span class="min-w-0 break-words">{err.message}</span>
				</div>
			{/each}
			<button onclick={clearStartggErrors} class="text-xs text-muted-foreground hover:text-foreground transition-colors">Clear errors</button>
		</div>
	{/if}

	{#if !tournament?.brackets}
		<div class="mt-6 rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
			No brackets yet. Complete Swiss rounds first.
			<a href="/dashboard/tournament/swiss" class="block mt-2 text-primary hover:text-primary/80">Go to Swiss &rarr;</a>
		</div>
	{:else}
		<!-- Both brackets side by side -->
		<div class="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
			{#each ['main', 'redemption'] as bracketName (bracketName)}
				{@const bracket = tournament!.brackets![bracketName as 'main' | 'redemption']}
				{#if bracket}
					{@const totalMatches = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length}
					{@const doneMatches = bracket.matches.filter((m) => m.winnerId).length}
					{@const readyMatches = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId)}
					{@const calledMatches = readyMatches.filter((m) => m.calledAt)}

					<section class="min-w-0 rounded-xl border {bracketName === 'main' ? 'border-sky-700/30' : 'border-red-700/30'} bg-card/40 p-4">
						<div class="flex items-center justify-between mb-2">
							<h2 class="text-sm font-bold {bracketName === 'main' ? 'text-sky-400' : 'text-red-400'}">
								{bracketName === 'main' ? 'Main Bracket' : 'Redemption Bracket'}
							</h2>
							<Button variant="outline" size="sm" onclick={() => { activeBracket = bracketName as 'main' | 'redemption'; syncFromStartGG(); }} disabled={syncingFromStartGG}>
								{syncingFromStartGG && activeBracket === bracketName ? 'Syncing...' : 'Sync'}
							</Button>
						</div>

						<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
							<span>{bracket.players.length} players · {doneMatches}/{totalMatches} matches</span>
							{#if readyMatches.length > 0}
								<span class="{calledMatches.length === readyMatches.length ? 'text-green-400' : 'text-muted-foreground'}">
									{calledMatches.length}/{readyMatches.length} called
									{#if calledMatches.length === readyMatches.length}&nbsp;✓{/if}
								</span>
							{/if}
							{#if bracket.matches.some((m) => m.isStream && !m.winnerId)}
								{@const streamM = bracket.matches.find((m) => m.isStream && !m.winnerId)!}
								<span class="text-primary">Stream: {getEntrant(streamM.topPlayerId)?.gamerTag} vs {getEntrant(streamM.bottomPlayerId)?.gamerTag}</span>
							{/if}
						</div>

						{#if syncResult && activeBracket === bracketName}
							<pre class="mt-1 text-xs text-green-400 whitespace-pre-wrap">{syncResult}</pre>
						{/if}

						<div class="mt-3 overflow-x-auto">
							<BracketView
								bracket={bracket}
								entrants={tournament!.entrants}
								onReport={(m) => { activeBracket = bracketName as 'main' | 'redemption'; openReport(m); }}
								onCall={(m) => { activeBracket = bracketName as 'main' | 'redemption'; callMatch(m); }}
								onStream={(m) => { activeBracket = bracketName as 'main' | 'redemption'; setStreamMatch(m); }} />
						</div>
					</section>
				{/if}
			{/each}
		</div>

		{@const bracket = getBracket()}{#if bracket}

			<!-- Report modal -->
			{#if reportingMatch}
				{@const top = getEntrant(reportingMatch.topPlayerId)}
				{@const bot = getEntrant(reportingMatch.bottomPlayerId)}
				{@const isTop8 = bracket ? isTop8Match(reportingMatch, bracket) : false}
				{@const isBo5 = activeBracket === 'main' ? isTop8 : (bracket ? isFinalsMatch(reportingMatch, bracket) : false)}
				{@const showChars = isTop8 || isBo5}

				<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
					<div class="w-full max-w-sm rounded-xl bg-card border border-border p-5">
						<div class="flex items-start justify-between">
							<div>
								<h3 class="text-base font-semibold text-foreground">Report Match</h3>
								<p class="text-sm text-muted-foreground mt-0.5">{top?.gamerTag ?? '?'} vs {bot?.gamerTag ?? '?'}</p>
							</div>
							<Badge variant={isBo5 ? 'default' : 'secondary'}>
								{isBo5 ? 'BO5' : 'BO3'}
							</Badge>
						</div>

						<!-- Step 1: Pick winner -->
						<div class="mt-4 flex gap-2">
							<button onclick={() => { reportWinnerId = reportingMatch!.topPlayerId!; reportScore = ''; }}
								class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors {reportWinnerId === reportingMatch.topPlayerId ? 'bg-emerald-600 text-white' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
								{top?.gamerTag ?? '?'}
							</button>
							<button onclick={() => { reportWinnerId = reportingMatch!.bottomPlayerId!; reportScore = ''; }}
								class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors {reportWinnerId === reportingMatch.bottomPlayerId ? 'bg-emerald-600 text-white' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
								{bot?.gamerTag ?? '?'}
							</button>
						</div>

						<!-- Step 2: Pick score (BO3 or BO5) -->
						{#if reportWinnerId}
							{#if isBo5}
								<div class="mt-3 grid grid-cols-4 gap-2">
									{#each ['3-0', '3-1', '3-2'] as s}
										<button onclick={() => setScore(s)}
											class="rounded-lg py-2 text-sm font-medium transition-colors {reportScore === s ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
											{s.replace('-', ' – ')}
										</button>
									{/each}
									<button onclick={() => setScore('DQ')}
										class="rounded-lg py-2 text-sm font-medium transition-colors {reportScore === 'DQ' ? 'bg-orange-700 text-white' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
										title="Opponent did not show up">
										DQ Win
									</button>
								</div>
							{:else}
								<div class="mt-3 flex gap-2">
									{#each ['2-0', '2-1'] as s}
										<button onclick={() => setScore(s)}
											class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors {reportScore === s ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
											{s.replace('-', ' – ')}
										</button>
									{/each}
									<button onclick={() => setScore('DQ')}
										class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors {reportScore === 'DQ' ? 'bg-orange-700 text-white' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
										title="Opponent did not show up">
										DQ Win
									</button>
								</div>
							{/if}
						{/if}

						<!-- Step 3: Per-game details (winner + characters) -->
						{#if reportWinnerId && reportScore && showChars && reportScore !== 'DQ'}
							<div class="mt-3">
								<p class="text-xs font-medium text-muted-foreground mb-2">Per-game details</p>
								<div class="space-y-2 max-h-64 overflow-y-auto">
								{#each Array.from({length: numGames(reportScore)}, (_, i) => i) as gameIdx}
									<div class="rounded-lg border border-border bg-secondary/50 p-2">
										<div class="flex items-center gap-2 mb-1.5">
											<span class="text-xs text-muted-foreground">G{gameIdx + 1}</span>
											<button type="button" onclick={() => toggleGameWinner(gameIdx)}
												class="rounded px-1.5 py-0.5 text-xs font-medium transition-colors
													{gameWinners[gameIdx] === 'top' ? 'bg-emerald-600/40 text-emerald-200' : 'bg-muted text-muted-foreground hover:text-foreground'}">
												{gameWinners[gameIdx] === 'top' ? 'W' : 'L'} {top?.gamerTag ?? '?'}
											</button>
											<button type="button" onclick={() => toggleGameWinner(gameIdx)}
												class="rounded px-1.5 py-0.5 text-xs font-medium transition-colors
													{gameWinners[gameIdx] === 'bottom' ? 'bg-emerald-600/40 text-emerald-200' : 'bg-muted text-muted-foreground hover:text-foreground'}">
												{gameWinners[gameIdx] === 'bottom' ? 'W' : 'L'} {bot?.gamerTag ?? '?'}
											</button>
										</div>
										<div class="grid grid-cols-2 gap-2">
											<div class="relative">
												{#if gameTopChars[gameIdx]}
													<div class="flex items-center gap-1 rounded bg-primary/20 px-2 py-1 text-xs text-foreground">
														<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(gameTopChars[gameIdx])}"></span>
														<span class="flex-1 truncate">{gameTopChars[gameIdx]}</span>
														<button type="button" onclick={() => clearGameChar('top', gameIdx)} class="text-muted-foreground hover:text-foreground leading-none">×</button>
													</div>
												{:else}
													<input bind:value={gameTopSearch[gameIdx]} placeholder="{top?.gamerTag ?? 'Top'}…"
														class="w-full rounded border border-input bg-secondary px-2 py-1 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none" />
													{#if gameTopSearch[gameIdx]}
														<div class="absolute z-20 top-full left-0 mt-0.5 w-full rounded-lg border border-border bg-popover shadow-xl max-h-36 overflow-y-auto">
															{#each filteredChars(gameTopSearch[gameIdx], []) as char}
																<button type="button" onclick={() => setGameChar('top', gameIdx, char)}
																	class="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-popover-foreground hover:bg-accent text-left">
																	<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(char)}"></span>
																	{char}
																</button>
															{:else}<div class="px-2 py-1.5 text-xs text-muted-foreground">No match</div>{/each}
														</div>
													{/if}
												{/if}
											</div>
											<div class="relative">
												{#if gameBotChars[gameIdx]}
													<div class="flex items-center gap-1 rounded bg-primary/20 px-2 py-1 text-xs text-foreground">
														<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(gameBotChars[gameIdx])}"></span>
														<span class="flex-1 truncate">{gameBotChars[gameIdx]}</span>
														<button type="button" onclick={() => clearGameChar('bot', gameIdx)} class="text-muted-foreground hover:text-foreground leading-none">×</button>
													</div>
												{:else}
													<input bind:value={gameBotSearch[gameIdx]} placeholder="{bot?.gamerTag ?? 'Bot'}…"
														class="w-full rounded border border-input bg-secondary px-2 py-1 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none" />
													{#if gameBotSearch[gameIdx]}
														<div class="absolute z-20 top-full left-0 mt-0.5 w-full rounded-lg border border-border bg-popover shadow-xl max-h-36 overflow-y-auto">
															{#each filteredChars(gameBotSearch[gameIdx], []) as char}
																<button type="button" onclick={() => setGameChar('bot', gameIdx, char)}
																	class="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-popover-foreground hover:bg-accent text-left">
																	<span class="w-2 h-2 rounded-full shrink-0" style="background:{charColor(char)}"></span>
																	{char}
																</button>
															{:else}<div class="px-2 py-1.5 text-xs text-muted-foreground">No match</div>{/each}
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
							<Button class="flex-1" onclick={submitReport} disabled={!reportWinnerId || !reportScore || submittingReport}>
								{#if submittingReport}
									<svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
										<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" opacity="0.25"/>
										<path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
									</svg>
									Submitting…
								{:else}
									Submit
								{/if}
							</Button>
							<Button variant="outline" onclick={() => reportingMatch = null} disabled={submittingReport}>
								Cancel
							</Button>
						</div>
					</div>
				</div>
			{/if}
		{/if}

	<!-- Swiss summary (expandable) -->
	{#if tournament?.rounds?.length}
		<details class="mt-8 rounded-lg border border-border bg-card">
			<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">Swiss Rounds & Final Standings</summary>
			<div class="px-4 pb-4 space-y-4">
				<!-- Swiss rounds -->
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">Swiss Rounds</h3>
					{#each [...tournament.rounds].reverse() as round}
						<details class="mb-2">
							<summary class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
								Round {round.number} <span class="text-muted-foreground/60">({round.status})</span>
							</summary>
							<div class="mt-1 space-y-0.5 pl-2">
								{#each round.matches as match}
									<div class="flex items-center gap-2 text-xs py-0.5">
										<span class="text-muted-foreground w-12 shrink-0 text-right">{match.isStream ? 'STREAM' : `Stn ${match.station}`}</span>
										<span class="{match.winnerId === match.topPlayerId ? 'text-green-300 font-medium' : match.winnerId ? 'text-muted-foreground' : 'text-foreground'} flex-1 truncate">
											{getEntrant(match.topPlayerId)?.gamerTag ?? '?'}
										</span>
										<span class="text-muted-foreground shrink-0">
											{#if match.topScore !== undefined}{match.topScore}–{match.bottomScore}{:else}vs{/if}
										</span>
										<span class="{match.winnerId === match.bottomPlayerId ? 'text-green-300 font-medium' : match.winnerId ? 'text-muted-foreground' : 'text-foreground'} flex-1 truncate text-right">
											{getEntrant(match.bottomPlayerId)?.gamerTag ?? '?'}
										</span>
									</div>
								{/each}
							</div>
						</details>
					{/each}
				</div>

				<!-- Final standings -->
				{#if tournament.finalStandings}
				<div class="grid gap-6 sm:grid-cols-2 border-t border-border pt-4">
					<div>
						<h4 class="text-sm font-medium text-primary mb-2">Main Bracket ({tournament.finalStandings.filter((s) => s.bracket === 'main').length})</h4>
						{#each tournament.finalStandings.filter((s) => s.bracket === 'main') as s}
							<div class="flex items-center gap-2 text-xs py-0.5">
								<span class="w-5 text-right font-mono text-muted-foreground">{s.rank}.</span>
								<span class="text-foreground">{s.gamerTag}</span>
								<span class="text-muted-foreground">{s.wins}-{s.losses}</span>
								{#if s.cinderellaBonus > 0}<span class="text-yellow-400">+{s.cinderellaBonus.toFixed(0)}C</span>{/if}
							</div>
						{/each}
					</div>
					<div>
						<h4 class="text-sm font-medium text-red-400 mb-2">Redemption Bracket ({tournament.finalStandings.filter((s) => s.bracket === 'redemption').length})</h4>
						{#each tournament.finalStandings.filter((s) => s.bracket === 'redemption') as s}
							<div class="flex items-center gap-2 text-xs py-0.5">
								<span class="w-5 text-right font-mono text-muted-foreground">{s.rank}.</span>
								<span class="text-foreground">{s.gamerTag}</span>
								<span class="text-muted-foreground">{s.wins}-{s.losses}</span>
								{#if s.cinderellaBonus > 0}<span class="text-yellow-400">+{s.cinderellaBonus.toFixed(0)}C</span>{/if}
							</div>
						{/each}
					</div>
				</div>
				{/if}
			</div>
		</details>
	{/if}
	{/if}
</main>
