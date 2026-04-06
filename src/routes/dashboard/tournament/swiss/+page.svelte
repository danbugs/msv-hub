<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState, SwissRound, Entrant, SwissMatch } from '$lib/types/tournament';

	let tournament = $state<TournamentState | null>(null);
	let loading = $state(false);
	let error = $state('');

	let showSetup = $state(false);
	let fixingMatchId = $state<string | null>(null);
	let dismissedBanners = $state(new Set<string>());
	let dismissedErrorTs = $state(new Set<number>());
	// Score selection: { matchId, winnerId } — waiting for score pick
	let pendingWinner = $state<{ matchId: string; winnerId: string } | null>(null);
	// Set of match IDs currently being reported (prevents double-clicks)
	let reportingMatches = $state(new Set<string>());

	// Poll briefly while StartGG set IDs are being cached (typically completes in ~1-2s)
	onMount(() => {
		const interval = setInterval(() => {
			if (tournament?.startggSync?.cacheReady === false) loadTournament();
		}, 2000);
		return () => clearInterval(interval);
	});

	onMount(loadTournament);

	async function loadTournament() {
		const res = await fetch('/api/tournament');
		if (res.ok) {
			const data = await res.json();
			tournament = data;
			if (!data) showSetup = true;
		}
	}

	const ANNOUNCE_CHANNELS = [
		{ value: '',               label: 'No announcement' },
		{ value: 'talk-to-balrog', label: '#talk-to-balrog' },
		{ value: 'general',        label: '#general' },
		{ value: 'announcements',  label: '#announcements' }
	];
	let roundAnnounceChannel = $state(
		typeof localStorage !== 'undefined' ? localStorage.getItem('msv-announce-channel') ?? '' : ''
	);
	$effect(() => {
		if (typeof localStorage !== 'undefined') localStorage.setItem('msv-announce-channel', roundAnnounceChannel);
	});

	async function startNextRound(regenerate = false) {
		loading = true;
		error = '';

		const res = await fetch('/api/tournament/round', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ regenerate, announceChannel: roundAnnounceChannel })
		});

		const data = await res.json();
		if (!res.ok) {
			error = data.error ?? 'Failed to start round';
		} else {
			await loadTournament();
		}
		loading = false;
	}

	async function reportMatch(matchId: string, winnerId: string, score: '2-0' | '2-1' | 'DQ', roundNumber?: number) {
		// Prevent double-reports while a report is in flight
		if (reportingMatches.has(matchId)) return;
		reportingMatches = new Set([...reportingMatches, matchId]);

		let topScore: number | undefined;
		let bottomScore: number | undefined;
		let isDQ = false;

		if (score === 'DQ') {
			isDQ = true;
		} else {
			const m = getMatch(matchId);
			if (!m) { reportingMatches = new Set([...reportingMatches].filter(id => id !== matchId)); return; }
			const winnerIsTop = winnerId === m.topPlayerId;
			if (score === '2-0') { topScore = winnerIsTop ? 2 : 0; bottomScore = winnerIsTop ? 0 : 2; }
			else { topScore = winnerIsTop ? 2 : 1; bottomScore = winnerIsTop ? 1 : 2; }
		}

		try {
			const res = await fetch('/api/tournament/round', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ matchId, winnerId, roundNumber, topScore, bottomScore, isDQ })
			});

			const data = await res.json();
			if (!res.ok) {
				error = data.error ?? 'Failed to report match';
			} else {
				fixingMatchId = null;
				pendingWinner = null;
				// StartGG errors are already shown via startggSync.errors boxes — no need
				// to also set the main error banner (which caused duplicate display).
				await loadTournament();
			}
		} finally {
			reportingMatches = new Set([...reportingMatches].filter(id => id !== matchId));
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

	let phaseResetting = $state(false);
	async function confirmPhaseReset() {
		phaseResetting = true;
		const res = await fetch('/api/tournament/phase-reset', { method: 'POST' });
		const data = await res.json();
		if (!res.ok) error = data.error ?? 'Phase reset failed';
		phaseResetting = false;
		await loadTournament();
	}

	async function clearStartggErrors() {
		await fetch('/api/tournament/startgg-sync', { method: 'DELETE' });
		await loadTournament();
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

	function isFinalRoundComplete(): boolean {
		if (!tournament) return false;
		return isRoundComplete() && tournament.currentRound >= tournament.settings.numRounds;
	}

	/** Returns each player's W-L record going INTO the given round (based on rounds before it). */
	function getRecordBefore(playerId: string, roundNumber: number): string {
		let wins = 0, losses = 0;
		for (const r of tournament?.rounds ?? []) {
			if (r.number >= roundNumber) continue;
			if (r.byePlayerId === playerId) { wins++; continue; }
			for (const m of r.matches) {
				if (!m.winnerId) continue;
				if (m.topPlayerId === playerId || m.bottomPlayerId === playerId) {
					if (m.winnerId === playerId) wins++; else losses++;
				}
			}
		}
		return `${wins}-${losses}`;
	}

	/** Group matches in a round by the shared W-L record of the players going in. */
	function groupMatchesByRecord(round: SwissRound): { label: string; matches: SwissMatch[] }[] {
		const groups = new Map<string, SwissMatch[]>();
		for (const m of round.matches) {
			const topRec = getRecordBefore(m.topPlayerId, round.number);
			const botRec = getRecordBefore(m.bottomPlayerId, round.number);
			// Label by best record (or cross-group if different)
			const label = topRec === botRec ? topRec : `${topRec} × ${botRec}`;
			const g = groups.get(label) ?? [];
			g.push(m);
			groups.set(label, g);
		}
		// Sort groups: higher wins first
		return [...groups.entries()]
			.sort((a, b) => {
				const [aw] = a[0].split('-').map(Number);
				const [bw] = b[0].split('-').map(Number);
				return bw - aw;
			})
			.map(([label, matches]) => ({ label, matches }));
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
		<div class="mt-4 flex items-start gap-2 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-400">
			<span class="min-w-0 flex-1">{error}</span>
			<button onclick={() => error = ''} class="shrink-0 text-red-400 hover:text-white leading-none" title="Dismiss">✕</button>
		</div>
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
			<a href="/live/{tournament.slug}" target="_blank" class="ml-auto text-xs text-gray-500 hover:text-violet-400">
				Live: /live/{tournament.slug} ↗
			</a>
		</div>

		{#if tournament.phase === 'swiss'}
			<!-- Round controls -->
			<div class="mt-6 flex flex-wrap items-center gap-3">
				{#if tournament.currentRound === 0 || isRoundComplete()}
					<button onclick={() => startNextRound()} disabled={loading}
						class="rounded-lg bg-violet-600 px-5 py-2 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50">
						{loading ? 'Generating...' : tournament.currentRound === 0 ? 'Start Round 1' : (isSwissComplete() || isFinalRoundComplete()) ? 'Generate Bracket Split →' : `Start Round ${tournament.currentRound + 1}`}
					</button>
					<select bind:value={roundAnnounceChannel}
						class="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 focus:border-violet-500 focus:outline-none">
						{#each ANNOUNCE_CHANNELS as ch}
							<option value={ch.value}>{ch.label}</option>
						{/each}
					</select>
				{/if}
			</div>

			<!-- StartGG sync status -->
			{#if tournament.startggSync?.cacheReady === false && tournament.startggPhase1Groups?.length}
				<div class="mt-4 flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/60 px-4 py-3 text-xs text-gray-400">
					<svg class="h-3 w-3 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 12a9 9 0 1 1-6.219-8.56" />
					</svg>
					<span>Preparing StartGG set IDs (please wait before reporting)...</span>
				</div>
			{/if}

			<!-- Pending phase reset after misreport fix -->
			{#if tournament.startggSync?.pendingPhaseReset}
				{@const pr = tournament.startggSync.pendingPhaseReset}
				<div class="mt-4 rounded-lg border border-amber-700 bg-amber-950/60 px-4 py-3">
					<p class="text-sm text-amber-200">
						<span class="font-semibold">StartGG:</span> Pairings for round {pr.roundNumber} were updated due to a misreport fix.
						Go to StartGG and <strong>reset the Swiss Round {pr.roundNumber} phase</strong>, then click the button below to re-sync.
					</p>
					<div class="mt-2 flex items-center gap-3">
						<button onclick={confirmPhaseReset} disabled={phaseResetting}
							class="rounded-lg bg-amber-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 transition-colors">
							{phaseResetting ? 'Re-syncing...' : 'Phase Reset Done'}
						</button>
					</div>
				</div>
			{/if}

			<!-- StartGG sync banners -->
			{#if tournament.currentRound === 1 && isRoundComplete() && !isFinalRoundComplete() && !dismissedBanners.has('round1-done')}
				<div class="mt-4 flex items-start gap-2 rounded-lg border border-blue-700 bg-blue-950/60 px-4 py-3 text-sm text-blue-200">
					<span class="flex-1">
						<span class="font-semibold">StartGG:</span> Before starting round 2, add all players to
						<strong>Swiss rounds 2–{tournament.settings.numRounds} and Final Standings</strong> phase groups on StartGG.
						This lets result reporting work for all remaining rounds.
					</span>
					<button onclick={() => dismissedBanners = new Set([...dismissedBanners, 'round1-done'])}
						class="shrink-0 text-blue-400 hover:text-blue-200 text-base leading-none" title="Dismiss">✕</button>
				</div>
			{/if}

			{#if isFinalRoundComplete() && !dismissedBanners.has('final-done')}
				<div class="mt-4 flex items-start gap-2 rounded-lg border border-amber-700 bg-amber-950/60 px-4 py-3 text-sm text-amber-200">
					<span class="flex-1">
						<span class="font-semibold">StartGG:</span> Swiss is complete. Click <strong>Generate Bracket Split</strong> to finalize standings
						and sync them to the "Final Standings" phase on StartGG. Then go to StartGG to finalize placements.
					</span>
					<button onclick={() => dismissedBanners = new Set([...dismissedBanners, 'final-done'])}
						class="shrink-0 text-amber-400 hover:text-amber-200 text-base leading-none" title="Dismiss">✕</button>
				</div>
			{/if}

			{#if tournament.startggSync?.errors?.filter(e => !dismissedErrorTs.has(e.ts)).length}
				<div class="mt-4 space-y-1">
					{#each tournament.startggSync.errors.filter(e => !dismissedErrorTs.has(e.ts)) as err}
						<div class="flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-300">
							<span class="shrink-0 font-semibold">StartGG error</span>
							<span class="min-w-0 flex-1 break-words">{err.message}</span>
							<button onclick={() => dismissedErrorTs = new Set([...dismissedErrorTs, err.ts])}
								class="shrink-0 text-red-300 hover:text-white leading-none" title="Dismiss">✕</button>
						</div>
					{/each}
					<button onclick={clearStartggErrors}
						class="text-xs text-gray-500 hover:text-gray-300 px-1">Clear all</button>
				</div>
			{/if}

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

					<div class="space-y-3">
					{#each groupMatchesByRecord(round) as group}
						<div>
							<div class="flex items-center gap-2 mb-1">
								<span class="text-xs font-semibold text-gray-500 uppercase tracking-wide">{group.label}</span>
								<div class="flex-1 border-t border-gray-800"></div>
							</div>
							<div class="space-y-1">
								{#each group.matches as match}
								{@const top = getEntrant(match.topPlayerId)}
								{@const bot = getEntrant(match.bottomPlayerId)}
								{@const isFixing = fixingMatchId === match.id}
								{@const isPending = pendingWinner?.matchId === match.id}
								{@const isReporting = reportingMatches.has(match.id)}
								{@const canInteract = (isCurrent || isFixing) && !isReporting}

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
												{isPending && pendingWinner?.winnerId === match.topPlayerId ? 'bg-violet-900/40 text-violet-200' :
												 isPending ? 'text-gray-500' :
												 match.winnerId === match.topPlayerId ? 'bg-green-900/30 text-green-300 font-medium' :
												 match.winnerId ? 'text-gray-500' :
												 'text-white'}
												{canInteract ? 'hover:bg-gray-800 cursor-pointer' : 'pointer-events-none'}"
											disabled={!canInteract}
											onclick={() => selectWinner(match.id, match.topPlayerId, isCurrent, isFixing)}>
											<span class="text-xs text-gray-500 mr-1">#{top?.initialSeed}</span>
											{top?.gamerTag ?? '?'}
											{#if match.winnerId === match.topPlayerId && match.isDQ}
												<span class="ml-1 text-xs text-orange-400">DQ win</span>
											{:else if match.winnerId === match.topPlayerId && match.topScore !== undefined}
												<span class="ml-1 text-xs text-gray-400">{match.topScore}-{match.bottomScore}</span>
											{/if}
										</button>

										<span class="text-gray-600 text-xs shrink-0">vs</span>

										<!-- Bottom player -->
										<button
											class="flex-1 min-w-0 truncate text-left rounded px-2 py-1 text-sm transition-colors
												{isPending && pendingWinner?.winnerId === match.bottomPlayerId ? 'bg-violet-900/40 text-violet-200' :
												 isPending ? 'text-gray-500' :
												 match.winnerId === match.bottomPlayerId ? 'bg-green-900/30 text-green-300 font-medium' :
												 match.winnerId ? 'text-gray-500' :
												 'text-white'}
												{canInteract ? 'hover:bg-gray-800 cursor-pointer' : 'pointer-events-none'}"
											disabled={!canInteract}
											onclick={() => selectWinner(match.id, match.bottomPlayerId, isCurrent, isFixing)}>
											<span class="text-xs text-gray-500 mr-1">#{bot?.initialSeed}</span>
											{bot?.gamerTag ?? '?'}
											{#if match.winnerId === match.bottomPlayerId && match.isDQ}
												<span class="ml-1 text-xs text-orange-400">DQ win</span>
											{:else if match.winnerId === match.bottomPlayerId && match.bottomScore !== undefined}
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
									{#if isReporting}
										<div class="flex items-center gap-2 px-3 pb-2">
											<span class="text-xs text-gray-400 ml-16 animate-pulse">Reporting...</span>
										</div>
									{:else if isPending}
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
											<button
												onclick={() => reportMatch(match.id, pendingWinner!.winnerId, 'DQ', round.number)}
												class="rounded bg-orange-700 px-3 py-1 text-xs font-medium text-white hover:bg-orange-600"
												title="Opponent did not show up (DQ)">
												DQ Win
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
									<th class="px-2 py-2 text-right w-10">#</th>
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
									.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.initialSeed - b.initialSeed) as entrant, idx}
									<tr class="border-b border-gray-800">
										<td class="px-2 py-1.5 text-right font-mono text-gray-500">{idx + 1}</td>
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
								{#if s.cinderellaBonus > 0}
									<span class="text-yellow-400 text-xs">+{s.cinderellaBonus.toFixed(0)} Cinderella</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
				<!-- 3-2 player in redemption warning -->
				{#each [tournament.finalStandings.filter((s) => s.bracket === 'main')] as mainPlayers}
					{#each [mainPlayers[mainPlayers.length - 1]] as lastMain}
						{#each [tournament.finalStandings.find((s) => s.bracket === 'redemption')] as firstRed}
							{#if lastMain && firstRed && lastMain.wins === firstRed.wins && lastMain.losses === firstRed.losses}
								<div class="mt-4 rounded-lg border border-amber-700 bg-amber-900/20 p-3 text-sm text-amber-300 space-y-2">
									<p><strong>{firstRed.gamerTag}</strong> ({firstRed.wins}-{firstRed.losses}) was placed in Redemption
									despite having the same record as <strong>{lastMain.gamerTag}</strong> ({lastMain.wins}-{lastMain.losses}) in Main.
									The tiebreaker is total points:</p>
									<div class="text-xs text-amber-400 space-y-1 ml-2">
										<p><strong>{lastMain.gamerTag}</strong> — <strong>{lastMain.totalScore.toFixed(0)} pts</strong>
											= {lastMain.wins} wins × 100
											+ {lastMain.basePoints.toFixed(0)} base
											+ {lastMain.winPoints.toFixed(0)} win quality
											+ {lastMain.lossPoints.toFixed(0)} loss quality
											{lastMain.cinderellaBonus > 0 ? `+ ${lastMain.cinderellaBonus.toFixed(0)} Cinderella` : ''}
										</p>
										<p><strong>{firstRed.gamerTag}</strong> — <strong>{firstRed.totalScore.toFixed(0)} pts</strong>
											= {firstRed.wins} wins × 100
											+ {firstRed.basePoints.toFixed(0)} base
											+ {firstRed.winPoints.toFixed(0)} win quality
											+ {firstRed.lossPoints.toFixed(0)} loss quality
											{firstRed.cinderellaBonus > 0 ? `+ ${firstRed.cinderellaBonus.toFixed(0)} Cinderella` : ''}
										</p>
									</div>
								</div>
							{/if}
						{/each}
					{/each}

					<!-- Split recommendation -->
					<div class="mt-4 rounded-lg border border-violet-700 bg-violet-900/20 p-3 text-sm text-violet-300">
						<strong>Next step:</strong> Go to StartGG's Bracket Setup and assign the top {mainPlayers.length} players
						to the <strong>Main Bracket</strong> event and the remaining {tournament.finalStandings.filter(s => s.bracket === 'redemption').length} players
						to the <strong>Redemption Bracket</strong> event. Then go to Brackets below to push seeding and start reporting.
					</div>
				{/each}
				<a href="/dashboard/tournament/brackets" class="mt-4 inline-block text-sm text-violet-400 hover:text-violet-300">
					Go to Brackets &rarr;
				</a>
			</div>
		{/if}
	{/if}
</main>
