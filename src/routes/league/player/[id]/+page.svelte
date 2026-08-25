<script lang="ts">
	import { onMount } from 'svelte';
	import { PLAYER_TIERS } from '$lib/types/league';

	let { data } = $props();
	let chartCanvas = $state<HTMLCanvasElement | null>(null);
	let bio = $state<string | null>(null);
	let bioLoading = $state(false);

	// H2H search
	let h2hQuery = $state('');
	let h2hSelectedOpp = $state<{ id: string; tag: string } | null>(null);
	let h2hDropdownOpen = $state(false);

	const allOpponents = $derived.by(() => {
		if (!data.stats) return [];
		const opps = new Map<string, { id: string; tag: string; wins: number; losses: number }>();
		for (const m of data.stats.recentMatches) {
			if (m.isDQ) continue;
			const isP1 = m.player1Id === data.stats.player.id;
			const oppId = isP1 ? m.player2Id : m.player1Id;
			const oppTag = isP1 ? m.player2Tag : m.player1Tag;
			const won = m.winnerId === data.stats.player.id;
			const existing = opps.get(oppId) ?? { id: oppId, tag: oppTag, wins: 0, losses: 0 };
			existing.tag = oppTag;
			if (won) existing.wins++;
			else existing.losses++;
			opps.set(oppId, existing);
		}
		return [...opps.values()].sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses));
	});

	const h2hSuggestions = $derived.by(() => {
		if (!h2hQuery.trim() || h2hSelectedOpp) return [];
		const q = h2hQuery.toLowerCase();
		return allOpponents.filter((o) => o.tag.toLowerCase().includes(q)).slice(0, 8);
	});

	const h2hResult = $derived.by(() => {
		if (!h2hSelectedOpp || !data.stats) return null;
		const oppId = h2hSelectedOpp.id;
		const pid = data.stats.player.id;
		const matches = data.stats.recentMatches.filter(
			(m) => !m.isDQ && (m.player1Id === oppId || m.player2Id === oppId)
		);
		if (!matches.length) return null;

		let wins = 0, losses = 0, scoreFor = 0, scoreAgainst = 0;
		for (const m of matches) {
			const isP1 = m.player1Id === pid;
			if (m.winnerId === pid) wins++;
			else losses++;
			scoreFor += isP1 ? m.player1Score : m.player2Score;
			scoreAgainst += isP1 ? m.player2Score : m.player1Score;
		}

		const eventMap = new Map<string, typeof matches>();
		for (const m of matches) {
			const arr = eventMap.get(m.eventSlug) ?? [];
			arr.push(m);
			eventMap.set(m.eventSlug, arr);
		}
		const byEvent = data.stats.matchesByEvent
			.filter((evt) => eventMap.has(evt.slug))
			.map((evt) => ({
				name: evt.name,
				slug: evt.slug,
				date: evt.date,
				eventNumber: evt.eventNumber,
				matches: eventMap.get(evt.slug)!
			}));

		return { wins, losses, scoreFor, scoreAgainst, scoreDiff: scoreFor - scoreAgainst, byEvent, total: matches.length };
	});

	function selectOpponent(opp: { id: string; tag: string }) {
		h2hSelectedOpp = opp;
		h2hQuery = opp.tag;
		h2hDropdownOpen = false;
	}

	function clearH2H() {
		h2hSelectedOpp = null;
		h2hQuery = '';
		h2hDropdownOpen = false;
	}

	function drawChart() {
		if (!chartCanvas || !data.stats) return;
		const history = data.stats.player.rankHistory;
		if (history.length < 2) return;

		const ctx = chartCanvas.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const rect = chartCanvas.getBoundingClientRect();
		chartCanvas.width = rect.width * dpr;
		chartCanvas.height = rect.height * dpr;
		ctx.scale(dpr, dpr);
		const W = rect.width;
		const H = rect.height;
		ctx.clearRect(0, 0, W, H);

		const bonus = data.attendanceBonus ?? 0;
		const cFactor = data.conservativeFactor ?? 0;
		const values = history.map((h, i) => h.points - Math.round(cFactor * h.sigma * 200) + (i + 1) * bonus);
		const minVal = Math.min(...values);
		const maxVal = Math.max(...values);
		const range = maxVal - minVal || 1;
		const pad = { top: 24, bottom: 24, left: 40, right: 16 };

		const isDark = document.documentElement.classList.contains('dark');
		const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
		const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
		const lineColor = isDark ? '#93c5fd' : '#3b82f6';

		const chartW = W - pad.left - pad.right;
		const chartH = H - pad.top - pad.bottom;

		ctx.strokeStyle = gridColor;
		ctx.lineWidth = 0.5;
		for (let i = 0; i <= 4; i++) {
			const y = pad.top + (i / 4) * chartH;
			ctx.beginPath();
			ctx.moveTo(pad.left, y);
			ctx.lineTo(W - pad.right, y);
			ctx.stroke();
			ctx.fillStyle = textColor;
			ctx.font = '10px system-ui';
			ctx.textAlign = 'right';
			ctx.fillText(String(Math.round(maxVal - (i / 4) * range)), pad.left - 6, y + 3);
		}

		ctx.strokeStyle = lineColor;
		ctx.lineWidth = 2;
		ctx.lineJoin = 'round';
		ctx.beginPath();
		for (let i = 0; i < values.length; i++) {
			const x = pad.left + (i / (values.length - 1)) * chartW;
			const y = pad.top + (1 - (values[i] - minVal) / range) * chartH;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();

		for (let i = 0; i < values.length; i++) {
			const x = pad.left + (i / (values.length - 1)) * chartW;
			const y = pad.top + (1 - (values[i] - minVal) / range) * chartH;

			if (i > 0) {
				const prevTier = PLAYER_TIERS.find((t) => values[i - 1] >= t.minPoints);
				const currTier = PLAYER_TIERS.find((t) => values[i] >= t.minPoints);
				if (prevTier && currTier && prevTier.name !== currTier.name) {
					ctx.fillStyle = currTier.color;
					ctx.beginPath();
					ctx.arc(x, y, 5, 0, Math.PI * 2);
					ctx.fill();
					ctx.strokeStyle = isDark ? '#1e293b' : '#ffffff';
					ctx.lineWidth = 1.5;
					ctx.stroke();
					continue;
				}
			}

			ctx.fillStyle = lineColor;
			ctx.beginPath();
			ctx.arc(x, y, 3, 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.fillStyle = textColor;
		ctx.font = '9px system-ui';
		ctx.textAlign = 'center';
		const step = Math.max(1, Math.floor(history.length / 6));
		for (let i = 0; i < history.length; i += step) {
			const x = pad.left + (i / (values.length - 1)) * chartW;
			ctx.fillText(`#${history[i].eventNumber}`, x, H - 4);
		}
		if (history.length > 1) {
			const lastX = pad.left + chartW;
			ctx.fillText(`#${history[history.length - 1].eventNumber}`, lastX, H - 4);
		}
	}

	function loadBio() {
		if (!data.stats || bioLoading) return;
		bioLoading = true;
		fetch(`/api/league/bio?season=${data.seasonId}&playerId=${data.stats.player.id}`)
			.then((r) => r.ok ? r.json() : null)
			.then((d) => { if (d?.bio) bio = d.bio; })
			.finally(() => { bioLoading = false; });
	}

	onMount(() => {
		drawChart();
	});

	function phaseLabel(phase: string): { text: string; classes: string } {
		if (phase === 'swiss') return { text: 'Swiss', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' };
		if (phase === 'winners') return { text: 'Winners', classes: 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' };
		if (phase === 'losers') return { text: 'Losers', classes: 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400' };
		if (phase === 'redemption-winners') return { text: 'Redem. W', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' };
		if (phase === 'redemption-losers') return { text: 'Redem. L', classes: 'bg-orange-100 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400' };
		return { text: phase, classes: 'bg-secondary text-muted-foreground' };
	}
</script>

<svelte:head>
	<title>{data.stats?.player.gamerTag ?? 'Player'} — MSV League</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<div class="border-b border-border bg-card/90 backdrop-blur-md">
		<div class="mx-auto max-w-3xl px-4 py-4">
			<a href="/league?season={data.seasonParam}" class="text-sm text-muted-foreground hover:text-primary transition-colors">
				← Back to rankings
			</a>
		</div>
	</div>

	<div class="mx-auto max-w-3xl px-4 py-6 space-y-6">
		{#if !data.stats}
			<div class="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
				Player not found.
			</div>
		{:else}
			{@const s = data.stats}

			<!-- Player header -->
			<div class="rounded-xl border border-border bg-card p-5">
				<div class="flex items-center gap-3">
					{#if s.characters?.length}
						<div class="flex -space-x-1">
							{#each s.characters.slice(0, 3) as char}
								{#if char.iconUrl}
									<img src={char.iconUrl} alt={char.name} title={char.name} class="h-8 w-8 object-contain" />
								{/if}
							{/each}
						</div>
					{/if}
					<h1 class="text-2xl font-bold text-foreground">{s.player.gamerTag}</h1>
					{#if data.tier}
						<span class="text-xs font-bold uppercase tracking-wider px-2 py-1 rounded"
							style="color: {data.tier.color}; background: {data.tier.color}15;">
							{data.tier.name}
						</span>
					{/if}
				</div>
				{#if s.player.aliases?.length}
					<div class="mt-1 text-sm text-muted-foreground">
						aka {s.player.aliases.join(', ')}
					</div>
				{/if}
				<div class="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
					<div>
						<div class="text-xs text-muted-foreground">Rank</div>
						<div class="text-lg font-bold text-foreground">
							{s.rank}<span class="text-sm font-normal text-muted-foreground"> / {s.totalPlayers}</span>
						</div>
					</div>
					<div>
						<div class="text-xs text-muted-foreground">Points</div>
						<div class="text-lg font-bold text-primary">{data.adjustedPoints}</div>
					</div>
					<div>
						<div class="text-xs text-muted-foreground">Win Rate</div>
						<div class="text-lg font-bold text-foreground">{s.winRate}%</div>
					</div>
					<div>
						<div class="text-xs text-muted-foreground">Events</div>
						<div class="text-lg font-bold text-foreground">{s.tournamentsPlayed}</div>
					</div>
				</div>
				<div class="mt-2 text-xs text-muted-foreground">
					{data.seasonName} · TrueSkill{#if data.seasonStart} · {data.seasonStart} to {data.seasonEnd}{/if}
				</div>
				{#if bio}
					<p class="mt-3 text-sm text-muted-foreground italic">{bio}</p>
				{:else if bioLoading}
					<div class="mt-3 h-4 w-3/4 rounded bg-secondary animate-pulse"></div>
				{:else}
					<button onclick={loadBio}
						class="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors">
						AI season overview
					</button>
				{/if}
			</div>

			<!-- Points History Chart -->
			{#if s.player.rankHistory.length >= 2}
				<div class="rounded-xl border border-border bg-card p-5">
					<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">TrueSkill Rating</h2>
					<canvas bind:this={chartCanvas} class="w-full" style="height: 180px;"></canvas>
				</div>
			{/if}

			<!-- Match Statistics -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
					Match Statistics ({s.matchesPlayed})
				</h2>
				<div class="text-lg font-bold text-foreground mb-3">{s.winRate}% Win Rate</div>
				<div class="space-y-2">
					<div class="flex justify-between text-sm">
						<span class="text-muted-foreground">Win</span>
						<span class="text-success font-medium">{s.matchesWon}</span>
					</div>
					<div class="flex justify-between text-sm">
						<span class="text-muted-foreground">Lose</span>
						<span class="text-destructive font-medium">{s.matchesLost}</span>
					</div>
					<div class="border-t border-border my-2"></div>
					<div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Score</div>
					<div class="flex justify-between text-sm">
						<span class="text-muted-foreground">+</span>
						<span class="font-medium text-foreground">{s.scoreFor}</span>
					</div>
					<div class="flex justify-between text-sm">
						<span class="text-muted-foreground">-</span>
						<span class="font-medium text-foreground">{s.scoreAgainst}</span>
					</div>
					<div class="flex justify-between text-sm">
						<span class="text-muted-foreground">+/-</span>
						<span class="font-medium {s.scoreDiff >= 0 ? 'text-success' : 'text-destructive'}">{s.scoreDiff > 0 ? '+' : ''}{s.scoreDiff}</span>
					</div>
				</div>
			</div>

			<!-- Characters -->
			{#if s.characters?.length}
				<div class="rounded-xl border border-border bg-card p-5">
					<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">Characters Played</h2>
					<div class="flex flex-wrap gap-2">
						{#each s.characters as char}
							<span class="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-sm text-foreground">
								{#if char.iconUrl}
									<img src={char.iconUrl} alt={char.name} class="h-5 w-5 object-contain" />
								{/if}
								{char.name} <span class="text-muted-foreground">×{char.count}</span>
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Tournament Statistics -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
					Tournament Statistics ({s.tournamentsPlayed})
				</h2>
				<div class="space-y-2">
					{#each [
						{ label: '1st', count: s.tournamentStats.top1 },
						{ label: 'Top 3', count: s.tournamentStats.top3 - s.tournamentStats.top1 },
						{ label: 'Top 8', count: s.tournamentStats.top8 - s.tournamentStats.top3 },
						{ label: 'Top 16', count: s.tournamentStats.top16 - s.tournamentStats.top8 },
						{ label: 'Top 32', count: s.tournamentStats.top32 - s.tournamentStats.top16 }
					].filter(p => p.count > 0) as p}
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">{p.label}</span>
							<span class="font-medium text-foreground">{p.count}</span>
						</div>
					{/each}
				</div>
				{#if s.redemptionCount > 0}
					<div class="border-t border-border mt-3 pt-3">
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Went to Redemption</span>
							<span class="font-medium text-foreground">{s.redemptionCount} / {s.tournamentsPlayed}</span>
						</div>
					</div>
				{/if}
			</div>

			<!-- Matchups -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">Matchups</h2>
				<div class="space-y-3">
					{#if s.matchups.nemesis}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Nemesis</div>
								<div class="text-xs text-muted-foreground">Lost {s.matchups.nemesis.losses} sets to</div>
							</div>
							<a href="/league/player/{s.matchups.nemesis.playerId}?season={data.seasonParam}"
								class="text-destructive hover:text-destructive/80 font-medium">{s.matchups.nemesis.tag}</a>
						</div>
					{/if}
					{#if s.matchups.dominated}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Dominated</div>
								<div class="text-xs text-muted-foreground">Won {s.matchups.dominated.wins} sets over</div>
							</div>
							<a href="/league/player/{s.matchups.dominated.playerId}?season={data.seasonParam}"
								class="text-success hover:text-success/80 font-medium">{s.matchups.dominated.tag}</a>
						</div>
					{/if}
					{#if s.matchups.rival}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Rival</div>
								<div class="text-xs text-muted-foreground">{s.matchups.rival.wins}-{s.matchups.rival.losses} in {s.matchups.rival.total} sets</div>
							</div>
							<a href="/league/player/{s.matchups.rival.playerId}?season={data.seasonParam}"
								class="text-primary hover:text-primary/80 font-medium">{s.matchups.rival.tag}</a>
						</div>
					{/if}
					{#if s.matchups.gatekeeper}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Gatekeeper</div>
								<div class="text-xs text-muted-foreground">{s.matchups.gatekeeper.closeGames} close set{s.matchups.gatekeeper.closeGames > 1 ? 's' : ''}, {s.matchups.gatekeeper.wins}-{s.matchups.gatekeeper.losses}</div>
							</div>
							<a href="/league/player/{s.matchups.gatekeeper.playerId}?season={data.seasonParam}"
								class="text-foreground hover:text-primary font-medium">{s.matchups.gatekeeper.tag}</a>
						</div>
					{/if}
					{#if s.matchups.biggestUpset}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Biggest Upset</div>
								<div class="text-xs text-muted-foreground">+{s.matchups.biggestUpset.upsetFactor} pts gap</div>
							</div>
							<a href="/league/player/{s.matchups.biggestUpset.playerId}?season={data.seasonParam}"
								class="text-success hover:text-success/80 font-medium">{s.matchups.biggestUpset.tag}</a>
						</div>
					{/if}
					{#if !s.matchups.nemesis && !s.matchups.dominated && !s.matchups.rival && !s.matchups.gatekeeper && !s.matchups.biggestUpset}
						<div class="text-sm text-muted-foreground">Not enough data yet</div>
					{/if}
				</div>
			</div>

			<!-- Head-to-Head Search -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">Head-to-Head</h2>
				<div class="relative">
					<div class="flex gap-2">
						<div class="relative flex-1">
							<input
								type="text"
								placeholder="Search opponent…"
								class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
								bind:value={h2hQuery}
								onfocus={() => { h2hDropdownOpen = true; }}
								oninput={() => { h2hSelectedOpp = null; h2hDropdownOpen = true; }}
							/>
							{#if h2hDropdownOpen && h2hSuggestions.length > 0}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-lg overflow-hidden"
									onmousedown={(e) => e.preventDefault()}>
									{#each h2hSuggestions as opp}
										<button
											class="w-full px-3 py-2 text-left text-sm hover:bg-secondary transition-colors flex justify-between items-center"
											onclick={() => selectOpponent(opp)}>
											<span class="text-foreground font-medium">{opp.tag}</span>
											<span class="text-xs text-muted-foreground">{opp.wins}-{opp.losses}</span>
										</button>
									{/each}
								</div>
							{/if}
						</div>
						{#if h2hSelectedOpp}
							<button onclick={clearH2H}
								class="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground transition-colors shrink-0">
								✕
							</button>
						{/if}
					</div>

					{#if h2hResult}
						<div class="mt-4 space-y-4">
							<!-- H2H Summary -->
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-2">
									<span class="text-foreground font-medium text-sm">vs</span>
									<a href="/league/player/{h2hSelectedOpp?.id}?season={data.seasonParam}"
										class="text-primary hover:text-primary/80 font-medium text-sm">{h2hSelectedOpp?.tag}</a>
								</div>
								<div class="text-right">
									<div class="text-lg font-bold tabular-nums">
										<span class="text-success">{h2hResult.wins}</span>
										<span class="text-muted-foreground mx-1">-</span>
										<span class="text-destructive">{h2hResult.losses}</span>
									</div>
								</div>
							</div>

							<!-- Game Score -->
							<div class="grid grid-cols-3 gap-2 text-center text-sm">
								<div>
									<div class="text-xs text-muted-foreground">Games +</div>
									<div class="font-medium text-foreground">{h2hResult.scoreFor}</div>
								</div>
								<div>
									<div class="text-xs text-muted-foreground">Games -</div>
									<div class="font-medium text-foreground">{h2hResult.scoreAgainst}</div>
								</div>
								<div>
									<div class="text-xs text-muted-foreground">+/-</div>
									<div class="font-medium {h2hResult.scoreDiff >= 0 ? 'text-success' : 'text-destructive'}">
										{h2hResult.scoreDiff > 0 ? '+' : ''}{h2hResult.scoreDiff}
									</div>
								</div>
							</div>

							<!-- H2H Match History -->
							<div class="border-t border-border pt-3 space-y-3">
								{#each h2hResult.byEvent as evt}
									<div>
										<div class="flex items-center justify-between mb-1">
											<a href="https://www.start.gg/tournament/{evt.slug}" target="_blank" rel="noopener"
												class="text-xs font-semibold text-foreground hover:text-primary transition-colors">
												{evt.name} ↗
											</a>
											<span class="text-[10px] text-muted-foreground">{evt.date}</span>
										</div>
										<div class="space-y-1">
											{#each evt.matches as match}
												{@const isP1 = match.player1Id === s.player.id}
												{@const won = match.winnerId === s.player.id}
												{@const myScore = isP1 ? match.player1Score : match.player2Score}
												{@const oppScore = isP1 ? match.player2Score : match.player1Score}
												{@const pl = phaseLabel(match.phase)}
												<div class="flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm">
													<span class="w-2 h-2 rounded-full shrink-0 {won ? 'bg-green-500' : 'bg-red-500'}"></span>
													<span class="{won ? 'text-success' : 'text-destructive'} font-medium w-10 shrink-0">{won ? 'Win' : 'Lose'}</span>
													<div class="flex items-center gap-1.5 shrink-0 ml-auto">
														<span class="text-xs tabular-nums text-muted-foreground">{myScore > 0 || oppScore > 0 ? `${myScore}-${oppScore}` : ''}</span>
														<span class="text-xs px-1.5 py-0.5 rounded w-16 text-center {pl.classes}">
															{pl.text}
														</span>
													</div>
												</div>
											{/each}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{:else if h2hSelectedOpp}
						<div class="mt-4 text-sm text-muted-foreground text-center py-3">
							No matches found against {h2hSelectedOpp.tag}
						</div>
					{/if}
				</div>
			</div>

			<!-- Best Wins -->
			{#if s.bestWins?.length}
				<div class="rounded-xl border border-border bg-card p-5">
					<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">Best Wins</h2>
					<div class="space-y-2">
						{#each s.bestWins as win}
							<div class="flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm">
								<span class="text-xs font-mono text-muted-foreground w-8 shrink-0">#{win.oppRank}</span>
								<a href="/league/player/{win.oppId}?season={data.seasonParam}"
									class="flex-1 text-foreground hover:text-primary font-medium truncate">{win.oppTag}</a>
								{#if win.score}
									<span class="text-xs text-muted-foreground shrink-0">{win.score}</span>
								{/if}
								<span class="text-[10px] text-muted-foreground shrink-0">{win.oppPoints} pts</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Match History -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
					Match History ({s.matchesPlayed})
				</h2>
				<div class="space-y-4 max-h-[600px] overflow-y-auto">
					{#each s.matchesByEvent as evt, evtIdx}
						{@const histIdx = s.player.rankHistory.findIndex((h) => h.eventNumber === evt.eventNumber)}
						{@const ptsDelta = histIdx > 0 ? s.player.rankHistory[histIdx].points - s.player.rankHistory[histIdx - 1].points : null}
						{@const evtWeight = evt.weight}
						<div>
							<div class="flex items-center justify-between mb-1.5">
								<div class="flex items-center gap-1.5">
									<a href="https://www.start.gg/tournament/{evt.slug}" target="_blank" rel="noopener"
										class="text-xs font-semibold text-foreground hover:text-primary transition-colors">
										{evt.name} ↗
									</a>
									{#if evtWeight != null && evtWeight !== 1.0}
										<span class="text-[10px] font-bold px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">{Math.round(evtWeight * 100)}%</span>
									{/if}
								</div>
								<div class="flex items-center gap-2">
									{#if ptsDelta !== null}
										{#if evtWeight != null && evtWeight !== 1.0}
											{@const unweighted = Math.round(ptsDelta / evtWeight)}
											<span class="text-[10px] font-bold">
												<span class="line-through text-muted-foreground">{unweighted >= 0 ? '+' : ''}{unweighted}</span>
												<span class="text-muted-foreground mx-0.5">×{Math.round(evtWeight * 100)}%=</span>
												<span class="{ptsDelta >= 0 ? 'text-success' : 'text-destructive'}">{ptsDelta >= 0 ? '+' : ''}{ptsDelta} pts</span>
											</span>
										{:else}
											<span class="text-[10px] font-bold {ptsDelta >= 0 ? 'text-success' : 'text-destructive'}">
												{ptsDelta >= 0 ? '+' : ''}{ptsDelta} pts
											</span>
										{/if}
									{/if}
									{#if evt.placement}
										<span class="text-[10px] font-bold text-muted-foreground">#{evt.placement}</span>
									{/if}
									<span class="text-[10px] text-muted-foreground">{evt.date}</span>
								</div>
							</div>
							<div class="space-y-1">
								{#each evt.matches as match}
									{@const isP1 = match.player1Id === s.player.id}
									{@const won = match.winnerId === s.player.id}
									{@const oppTag = isP1 ? match.player2Tag : match.player1Tag}
									{@const oppId = isP1 ? match.player2Id : match.player1Id}
									{@const myScore = isP1 ? match.player1Score : match.player2Score}
									{@const oppScore = isP1 ? match.player2Score : match.player1Score}
									{@const delta = isP1 ? match.p1Delta : match.p2Delta}
									{@const pl = phaseLabel(match.phase)}
									<div class="flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm {match.isDQ ? 'opacity-50' : ''}">
										<span class="w-2 h-2 rounded-full shrink-0 {won ? 'bg-green-500' : 'bg-red-500'}"></span>
										<span class="{won ? 'text-success' : 'text-destructive'} font-medium w-10 shrink-0">{won ? 'Win' : 'Lose'}</span>
										<span class="text-muted-foreground shrink-0">vs</span>
										<a href="/league/player/{oppId}?season={data.seasonParam}"
											class="flex-1 text-foreground hover:text-primary truncate min-w-0">{oppTag}</a>
										<div class="flex items-center gap-1.5 shrink-0 ml-auto">
											{#if match.isDQ}
												<span class="text-[10px] font-bold text-muted-foreground w-12 text-right">DQ</span>
											{:else if delta != null}
												<span class="text-[10px] font-bold tabular-nums w-12 text-right {delta >= 0 ? 'text-success' : 'text-destructive'}">
													{delta >= 0 ? '+' : ''}{delta}
												</span>
											{/if}
											<span class="text-xs tabular-nums text-muted-foreground w-7 text-right">{myScore > 0 || oppScore > 0 ? `${myScore}-${oppScore}` : ''}</span>
											<span class="text-xs px-1.5 py-0.5 rounded w-16 text-center {pl.classes}">
												{pl.text}
											</span>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>
