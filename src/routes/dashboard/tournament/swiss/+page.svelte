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

	// No polling needed — preview IDs work for first report, real IDs cached instantly after.

	let pushingToBrackets = $state(false);
	let pushError = $state('');

	let syncingFromStartGG = $state(false);
	let syncResult = $state('');

	async function syncFromStartGG() {
		if (!confirm('Sync Swiss rounds from StartGG? This overwrites MSV Hub match results with StartGG\'s current state.')) return;
		syncingFromStartGG = true;
		syncResult = '';
		const res = await fetch('/api/tournament/swiss/sync-from-startgg', { method: 'POST' });
		const data = await res.json();
		if (res.ok) {
			const dbg = data.debug ? `\n\n${data.debug.join('\n')}` : '';
			syncResult = `Synced ${data.synced} matches (${data.skipped} skipped)${dbg}`;
		} else error = data.error ?? 'Sync failed';
		syncingFromStartGG = false;
		await loadTournament();
	}

	async function pushAndGoToBrackets() {
		pushingToBrackets = true;
		pushError = '';
		const res = await fetch('/api/tournament/startgg-sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ announceChannel: roundAnnounceChannel })
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok) {
			window.location.href = '/dashboard/tournament/brackets';
		} else {
			pushError = (data as { error?: string }).error ?? 'Failed to push bracket to StartGG';
			pushingToBrackets = false;
		}
	}

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
				if (pendingWinner?.matchId === matchId) pendingWinner = null;
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
	<a href="/dashboard" class="text-sm text-primary hover:text-primary/80">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-foreground">Run Swiss</h1>

	{#if error}
		<div class="mt-4 flex items-start gap-2 rounded-lg border border-destructive-border bg-destructive-muted px-4 py-3 text-sm text-destructive">
			<span class="min-w-0 flex-1">{error}</span>
			<button onclick={() => error = ''} class="shrink-0 text-destructive hover:text-foreground leading-none" title="Dismiss">✕</button>
		</div>
	{/if}

	{#if showSetup && !tournament}
		<div class="mt-6 rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
			No active tournament.
			<a href="/dashboard/pre-tournament/seed" class="block mt-2 text-primary hover:text-primary/80">
				Run the seeder first, then click "Start Swiss →" &larr;
			</a>
		</div>

	{:else if tournament}
		<!-- Header -->
		<div class="mt-2 flex flex-wrap items-center gap-3">
			<h2 class="text-lg text-foreground">{tournament.name}</h2>
			<span class="rounded-full bg-secondary px-3 py-0.5 text-xs font-medium text-primary">
				{tournament.phase === 'swiss' ? `Swiss — Round ${tournament.currentRound}/${tournament.settings.numRounds}` : tournament.phase}
			</span>
			<span class="text-xs text-muted-foreground">{tournament.entrants.length} players · {tournament.settings.numStations} stations</span>
			<a href="/live/{tournament.slug}" target="_blank" class="ml-auto text-xs text-muted-foreground hover:text-primary">
				Live: /live/{tournament.slug} ↗
			</a>
		</div>

		{#if tournament.phase === 'swiss'}
			<!-- Round controls -->
			<div class="mt-6 flex flex-wrap items-center gap-3">
				{#if tournament.currentRound === 0 || isRoundComplete()}
					<button onclick={() => startNextRound()} disabled={loading}
						class="rounded-lg bg-primary px-5 py-2 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
						{loading ? 'Generating...' : tournament.currentRound === 0 ? 'Start Round 1' : (isSwissComplete() || isFinalRoundComplete()) ? 'Generate Bracket Split →' : `Start Round ${tournament.currentRound + 1}`}
					</button>
					<select bind:value={roundAnnounceChannel}
						class="rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none">
						{#each ANNOUNCE_CHANNELS as ch}
							<option value={ch.value}>{ch.label}</option>
						{/each}
					</select>
				{/if}
				{#if tournament.currentRound > 0}
					<button onclick={syncFromStartGG} disabled={syncingFromStartGG}
						class="ml-auto rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
						title="Sync from StartGG — pulls results and overwrites MSV Hub's Swiss state">
						{syncingFromStartGG ? 'Syncing...' : 'Sync from StartGG'}
					</button>
					{#if syncResult}<pre class="text-xs text-success whitespace-pre-wrap">{syncResult}</pre>{/if}
				{/if}
			</div>

			<!-- Banner removed — no wait needed. Preview IDs work for first report. -->

			<!-- Pending phase reset after misreport fix -->
			{#if tournament.startggSync?.pendingPhaseReset}
				{@const pr = tournament.startggSync.pendingPhaseReset}
				<div class="mt-4 rounded-lg border border-warning-border bg-warning-muted px-4 py-3">
					<p class="text-sm text-warning">
						<span class="font-semibold">StartGG:</span> Pairings for round {pr.roundNumber} were updated due to a misreport fix.
						Click below to restart the phase on StartGG and re-sync pairings.
					</p>
					<div class="mt-2 flex items-center gap-3">
						<button onclick={confirmPhaseReset} disabled={phaseResetting}
							class="rounded-lg bg-amber-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 transition-colors">
							{phaseResetting ? 'Restarting & re-syncing...' : 'Restart & Re-sync'}
						</button>
					</div>
				</div>
			{/if}

			<!-- StartGG sync banners -->
			{#if isFinalRoundComplete() && !dismissedBanners.has('final-done')}
				<div class="mt-4 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-muted px-4 py-3 text-sm text-warning">
					<span class="flex-1">
						<span class="font-semibold">StartGG:</span> Swiss is complete. Click <strong>Generate Bracket Split</strong> to finalize standings
						and sync them to the "Final Standings" phase on StartGG. Then go to StartGG to finalize placements.
					</span>
					<button onclick={() => dismissedBanners = new Set([...dismissedBanners, 'final-done'])}
						class="shrink-0 text-warning hover:text-warning text-base leading-none" title="Dismiss">✕</button>
				</div>
			{/if}

			{#if tournament.startggSync?.errors?.filter(e => !dismissedErrorTs.has(e.ts)).length}
				<div class="mt-4 space-y-1">
					{#each tournament.startggSync.errors.filter(e => !dismissedErrorTs.has(e.ts)) as err}
						<div class="flex items-start gap-2 rounded-lg border border-destructive-border bg-destructive-muted px-3 py-2 text-xs text-destructive">
							<span class="shrink-0 font-semibold">StartGG error</span>
							<span class="min-w-0 flex-1 break-words">{err.message}</span>
							<button onclick={() => dismissedErrorTs = new Set([...dismissedErrorTs, err.ts])}
								class="shrink-0 text-destructive hover:text-foreground leading-none" title="Dismiss">✕</button>
						</div>
					{/each}
					<button onclick={clearStartggErrors}
						class="text-xs text-muted-foreground hover:text-foreground px-1">Clear all</button>
				</div>
			{/if}

			<!-- Rounds (most recent first) -->
			{#each [...tournament.rounds].reverse() as round}
				{@const isCurrent = round.status === 'active'}
				<div class="mt-6">
					<div class="flex items-center gap-3 mb-3">
						<h3 class="text-lg font-semibold text-foreground">Round {round.number}</h3>
						<span class="rounded-full px-2 py-0.5 text-xs font-medium {isCurrent ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}">
							{round.status}
						</span>
						{#if round.byePlayerId}
							<span class="text-xs text-warning">BYE: {getEntrant(round.byePlayerId)?.gamerTag}</span>
						{/if}
					</div>

					<div class="space-y-3">
					{#each groupMatchesByRecord(round) as group}
						<div>
							<div class="flex items-center gap-2 mb-1">
								<span class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{group.label}</span>
								<div class="flex-1 border-t border-border"></div>
							</div>
							<div class="space-y-1">
								{#each group.matches as match}
								{@const top = getEntrant(match.topPlayerId)}
								{@const bot = getEntrant(match.bottomPlayerId)}
								{@const isFixing = fixingMatchId === match.id}
								{@const isPending = pendingWinner?.matchId === match.id}
								{@const isReporting = reportingMatches.has(match.id)}
								{@const canInteract = (isCurrent || isFixing) && !isReporting}

								<div class="rounded-lg bg-card {match.isStream ? 'border border-primary' : 'border border-transparent'}">
									<!-- Match row -->
									<div class="flex items-center gap-2 px-3 py-2">
										<!-- Station label -->
										<span class="w-16 shrink-0 text-right text-xs font-mono {match.isStream ? 'text-primary' : 'text-muted-foreground'}">
											{match.isStream ? 'STREAM' : `Stn ${match.station}`}
										</span>

										<!-- Top player -->
										<button
											class="flex-1 min-w-0 truncate text-left rounded px-2 py-1 text-sm transition-colors
												{isPending && pendingWinner?.winnerId === match.topPlayerId ? 'bg-primary/10 text-primary' :
												 isPending ? 'text-muted-foreground' :
												 match.winnerId === match.topPlayerId ? 'bg-success-muted text-success font-medium' :
												 match.winnerId ? 'text-muted-foreground' :
												 'text-foreground'}
												{canInteract ? 'hover:bg-accent cursor-pointer' : 'pointer-events-none'}"
											disabled={!canInteract}
											onclick={() => selectWinner(match.id, match.topPlayerId, isCurrent, isFixing)}>
											<span class="text-xs text-muted-foreground mr-1">#{top?.initialSeed}</span>
											{top?.gamerTag ?? '?'}
											{#if match.winnerId === match.topPlayerId && match.isDQ}
												<span class="ml-1 text-xs text-orange-400">DQ win</span>
											{:else if match.winnerId === match.topPlayerId && match.topScore !== undefined}
												<span class="ml-1 text-xs text-muted-foreground">{match.topScore}-{match.bottomScore}</span>
											{/if}
										</button>

										<span class="text-muted-foreground text-xs shrink-0">vs</span>

										<!-- Bottom player -->
										<button
											class="flex-1 min-w-0 truncate text-left rounded px-2 py-1 text-sm transition-colors
												{isPending && pendingWinner?.winnerId === match.bottomPlayerId ? 'bg-primary/10 text-primary' :
												 isPending ? 'text-muted-foreground' :
												 match.winnerId === match.bottomPlayerId ? 'bg-success-muted text-success font-medium' :
												 match.winnerId ? 'text-muted-foreground' :
												 'text-foreground'}
												{canInteract ? 'hover:bg-accent cursor-pointer' : 'pointer-events-none'}"
											disabled={!canInteract}
											onclick={() => selectWinner(match.id, match.bottomPlayerId, isCurrent, isFixing)}>
											<span class="text-xs text-muted-foreground mr-1">#{bot?.initialSeed}</span>
											{bot?.gamerTag ?? '?'}
											{#if match.winnerId === match.bottomPlayerId && match.isDQ}
												<span class="ml-1 text-xs text-orange-400">DQ win</span>
											{:else if match.winnerId === match.bottomPlayerId && match.bottomScore !== undefined}
												<span class="ml-1 text-xs text-muted-foreground">{match.topScore}-{match.bottomScore}</span>
											{/if}
										</button>

										<!-- Actions -->
										<div class="flex items-center gap-1 shrink-0">
											{#if isReporting}
												<svg class="animate-spin h-3.5 w-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="none">
													<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
													<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
												</svg>
											{/if}
											{#if isCurrent && !match.isStream}
												<button onclick={() => setStreamMatch(match.id)}
													class="text-xs px-1.5 py-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors inline-flex items-center"
													title="Set as stream match">
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
														<rect x="2" y="3" width="20" height="14" rx="2" />
														<path d="M8 21h8" /><path d="M12 17v4" />
													</svg>
												</button>
											{/if}
											{#if round.status === 'completed' && match.winnerId}
												<button onclick={() => { fixingMatchId = isFixing ? null : match.id; pendingWinner = null; }}
													class="text-xs px-2 py-1 rounded {isFixing ? 'bg-warning-muted text-warning' : 'text-muted-foreground hover:text-warning'}">
													{isFixing ? 'Cancel' : 'Fix'}
												</button>
											{/if}
										</div>
									</div>

									{#if isPending}
										<div class="flex items-center gap-2 px-3 pb-2">
											<span class="text-xs text-muted-foreground ml-16">Score:</span>
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
												class="text-xs text-muted-foreground hover:text-foreground px-2">Cancel</button>
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
				<details class="mt-8 rounded-lg border border-border bg-card">
					<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">Current Standings</summary>
					<div class="px-4 pb-4">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-border text-left text-muted-foreground">
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
									<tr class="border-b border-border">
										<td class="px-2 py-1.5 text-right font-mono text-muted-foreground">{idx + 1}</td>
										<td class="px-2 py-1.5 text-foreground">{entrant.gamerTag}</td>
										<td class="px-2 py-1.5 text-right font-mono text-muted-foreground">#{entrant.initialSeed}</td>
										<td class="px-2 py-1.5 text-right font-mono text-success">{entrant.wins}</td>
										<td class="px-2 py-1.5 text-right font-mono text-destructive">{entrant.losses}</td>
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
				<h3 class="text-lg font-semibold text-foreground">Swiss Complete — Final Standings</h3>
				<div class="mt-3 grid gap-6 sm:grid-cols-2">
					<div>
						<h4 class="text-sm font-medium text-primary mb-2">Main Bracket ({tournament.finalStandings.filter((s) => s.bracket === 'main').length} players)</h4>
						{#each tournament.finalStandings.filter((s) => s.bracket === 'main') as s}
							<div class="flex items-center gap-2 text-sm py-0.5">
								<span class="w-6 text-right font-mono text-muted-foreground">{s.rank}.</span>
								<span class="text-foreground">{s.gamerTag}</span>
								<span class="text-muted-foreground">{s.wins}-{s.losses}</span>
								{#if s.cinderellaBonus > 0}
									<span class="text-warning text-xs">+{s.cinderellaBonus.toFixed(0)} Cinderella</span>
								{/if}
							</div>
						{/each}
					</div>
					<div>
						<h4 class="text-sm font-medium text-destructive mb-2">Redemption Bracket ({tournament.finalStandings.filter((s) => s.bracket === 'redemption').length} players)</h4>
						{#each tournament.finalStandings.filter((s) => s.bracket === 'redemption') as s}
							<div class="flex items-center gap-2 text-sm py-0.5">
								<span class="w-6 text-right font-mono text-muted-foreground">{s.rank}.</span>
								<span class="text-foreground">{s.gamerTag}</span>
								<span class="text-muted-foreground">{s.wins}-{s.losses}</span>
								{#if s.cinderellaBonus > 0}
									<span class="text-warning text-xs">+{s.cinderellaBonus.toFixed(0)} Cinderella</span>
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
								{@const rawDiff = lastMain.totalScore - firstRed.totalScore}
								{@const reason = (() => {
									// Determine the actual dominant reason — don't accumulate
									if (Math.abs(rawDiff) >= 0.5) {
										// Actual point difference — figure out main driver
										if (lastMain.winPoints > firstRed.winPoints + 0.1) return 'beat higher-seeded opponents (more win points)';
										if (lastMain.lossPoints > firstRed.lossPoints + 0.1) return 'lost to stronger players (more loss points)';
										if (lastMain.cinderellaBonus > firstRed.cinderellaBonus + 0.1) return 'overperformed their seed (Cinderella bonus)';
										return 'had a slight points edge';
									}
									// Points effectively tied — falls to initial seed tiebreaker
									if (lastMain.initialSeed < firstRed.initialSeed) return `had a higher initial seed (#${lastMain.initialSeed} vs #${firstRed.initialSeed})`;
									return 'tiebreaker';
								})()}
								{@const diffLabel = Math.abs(rawDiff) >= 0.5 ? `${rawDiff.toFixed(1)} more points` : 'tied on points'}
								<div class="mt-4 rounded-lg border border-warning-border bg-warning-muted p-3 text-sm text-warning space-y-2">
									<p><strong>{firstRed.gamerTag}</strong> ({firstRed.wins}-{firstRed.losses}, seed #{firstRed.initialSeed}) was placed in Redemption
									over <strong>{lastMain.gamerTag}</strong> ({lastMain.wins}-{lastMain.losses}, seed #{lastMain.initialSeed}) who made Main.</p>
									<p class="text-xs text-warning">
										Both went {lastMain.wins}-{lastMain.losses}. <strong>{lastMain.gamerTag}</strong> {diffLabel} — {reason}.
									</p>
									<p class="text-xs text-muted-foreground">
										Score: {lastMain.gamerTag} {lastMain.totalScore.toFixed(1)} pts vs {firstRed.gamerTag} {firstRed.totalScore.toFixed(1)} pts
									</p>
								</div>
							{/if}
						{/each}
					{/each}

					<!-- Split recommendation -->
					<div class="mt-4 rounded-lg border border-primary bg-primary/10 p-3 text-sm text-primary">
						<strong>Next step:</strong> Click below to push the bracket split to StartGG
						({mainPlayers.length} players to Main, {tournament.finalStandings.filter(s => s.bracket === 'redemption').length} to Redemption) and start bracket reporting.
					</div>
				{/each}
				<div class="mt-4 flex flex-wrap items-center gap-3">
					<button onclick={pushAndGoToBrackets} disabled={pushingToBrackets}
						class="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
						{pushingToBrackets ? 'Pushing to StartGG…' : 'Push to StartGG & Start Brackets →'}
					</button>
					<select bind:value={roundAnnounceChannel}
						class="rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none"
						title="Channel to announce bracket start">
						{#each ANNOUNCE_CHANNELS as ch}
							<option value={ch.value}>{ch.label}</option>
						{/each}
					</select>
				</div>
				{#if pushError}
					<p class="mt-2 text-sm text-destructive">{pushError}</p>
				{/if}
			</div>
		{/if}
	{/if}
</main>
