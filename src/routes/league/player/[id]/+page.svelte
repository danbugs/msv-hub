<script lang="ts">
	import { onMount } from 'svelte';

	let { data } = $props();
	let chartCanvas = $state<HTMLCanvasElement | null>(null);
	let chartMode = $state<'rank' | 'points'>('rank');
	let bio = $state<string | null>(null);
	let bioLoading = $state(false);

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

		const values = history.map((h) => chartMode === 'rank' ? h.rank : h.points);
		const minVal = Math.min(...values);
		const maxVal = Math.max(...values);
		const range = maxVal - minVal || 1;
		const pad = { top: 24, bottom: 24, left: 40, right: 16 };

		const isDark = document.documentElement.classList.contains('dark');
		const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
		const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
		const lineColor = isDark ? '#93c5fd' : '#3b82f6';

		// Grid lines
		ctx.strokeStyle = gridColor;
		ctx.lineWidth = 0.5;
		const gridSteps = 4;
		for (let i = 0; i <= gridSteps; i++) {
			const y = pad.top + (i / gridSteps) * (H - pad.top - pad.bottom);
			ctx.beginPath();
			ctx.moveTo(pad.left, y);
			ctx.lineTo(W - pad.right, y);
			ctx.stroke();

			const label = chartMode === 'rank'
				? Math.round(minVal + (i / gridSteps) * range)
				: Math.round(maxVal - (i / gridSteps) * range);
			ctx.fillStyle = textColor;
			ctx.font = '10px system-ui';
			ctx.textAlign = 'right';
			ctx.fillText(String(label), pad.left - 6, y + 3);
		}

		// Data line
		ctx.strokeStyle = lineColor;
		ctx.lineWidth = 2;
		ctx.lineJoin = 'round';
		ctx.beginPath();

		const chartW = W - pad.left - pad.right;
		const chartH = H - pad.top - pad.bottom;

		for (let i = 0; i < values.length; i++) {
			const x = pad.left + (i / (values.length - 1)) * chartW;
			const normalized = (values[i] - minVal) / range;
			const y = chartMode === 'rank'
				? pad.top + normalized * chartH
				: pad.top + (1 - normalized) * chartH;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();

		// Dots
		ctx.fillStyle = lineColor;
		for (let i = 0; i < values.length; i++) {
			const x = pad.left + (i / (values.length - 1)) * chartW;
			const normalized = (values[i] - minVal) / range;
			const y = chartMode === 'rank'
				? pad.top + normalized * chartH
				: pad.top + (1 - normalized) * chartH;
			ctx.beginPath();
			ctx.arc(x, y, 3, 0, Math.PI * 2);
			ctx.fill();
		}

		// X-axis labels (event numbers)
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

	onMount(() => {
		drawChart();
		if (data.stats) {
			bioLoading = true;
			fetch(`/api/league/bio?season=${data.seasonId}&playerId=${data.stats.player.id}`)
				.then((r) => r.ok ? r.json() : null)
				.then((d) => { if (d?.bio) bio = d.bio; })
				.finally(() => { bioLoading = false; });
		}
	});

	$effect(() => {
		chartMode;
		drawChart();
	});

	function phaseLabel(phase: string): { text: string; classes: string } {
		if (phase === 'swiss') return { text: 'Swiss', classes: 'bg-blue-500/10 text-blue-400' };
		if (phase === 'winners') return { text: 'Winners', classes: 'bg-green-500/10 text-green-400' };
		if (phase === 'losers') return { text: 'Losers', classes: 'bg-red-500/10 text-red-400' };
		if (phase === 'redemption-winners') return { text: 'Redem. W', classes: 'bg-amber-500/10 text-amber-400' };
		if (phase === 'redemption-losers') return { text: 'Redem. L', classes: 'bg-orange-500/10 text-orange-400' };
		return { text: phase, classes: 'bg-secondary text-muted-foreground' };
	}
</script>

<svelte:head>
	<title>{data.stats?.player.gamerTag ?? 'Player'} — MSV League</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<div class="border-b border-border bg-card/90 backdrop-blur-md">
		<div class="mx-auto max-w-3xl px-4 py-4">
			<a href="/league?season={data.seasonId}" class="text-sm text-muted-foreground hover:text-primary transition-colors">
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
						<div class="text-lg font-bold text-primary">{s.player.points}</div>
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
					{data.seasonName} · TrueSkill · {data.seasonStart} to {data.seasonEnd}
				</div>
				{#if bio}
					<p class="mt-3 text-sm text-muted-foreground italic">{bio}</p>
				{:else if bioLoading}
					<div class="mt-3 h-4 w-3/4 rounded bg-secondary animate-pulse"></div>
				{/if}
			</div>

			<!-- Ranking History Chart -->
			{#if s.player.rankHistory.length >= 2}
				<div class="rounded-xl border border-border bg-card p-5">
					<div class="flex items-center justify-between mb-3">
						<h2 class="text-sm font-bold text-foreground uppercase tracking-wider">Ranking History</h2>
						<div class="flex gap-1">
							<button
								onclick={() => { chartMode = 'rank'; }}
								class="rounded px-2 py-1 text-xs {chartMode === 'rank' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}">
								Rank
							</button>
							<button
								onclick={() => { chartMode = 'points'; }}
								class="rounded px-2 py-1 text-xs {chartMode === 'points' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}">
								Points
							</button>
						</div>
					</div>
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
						{ label: 'Top 32', count: s.tournamentStats.top32 - s.tournamentStats.top16 },
						{ label: '32+', count: s.tournamentsPlayed - s.tournamentStats.top32 }
					].filter(p => p.count > 0) as p}
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">{p.label}</span>
							<span class="font-medium text-foreground">{p.count}</span>
						</div>
					{/each}
				</div>
				{#if s.redemptionStats.top1 > 0 || s.redemptionStats.top3 > 0 || s.redemptionStats.top8 > 0}
					<div class="border-t border-border mt-3 pt-3">
						<div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Redemption Bracket</div>
						<div class="space-y-2">
							{#each [
								{ label: '1st', count: s.redemptionStats.top1 },
								{ label: 'Top 3', count: s.redemptionStats.top3 - s.redemptionStats.top1 },
								{ label: 'Top 8', count: s.redemptionStats.top8 - s.redemptionStats.top3 }
							].filter(p => p.count > 0) as p}
								<div class="flex justify-between text-sm">
									<span class="text-muted-foreground">{p.label}</span>
									<span class="font-medium text-foreground">{p.count}</span>
								</div>
							{/each}
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
							<a href="/league/player/{s.matchups.nemesis.playerId}?season={data.seasonId}"
								class="text-destructive hover:text-destructive/80 font-medium">{s.matchups.nemesis.tag}</a>
						</div>
					{/if}
					{#if s.matchups.dominated}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Dominated</div>
								<div class="text-xs text-muted-foreground">Won {s.matchups.dominated.wins} sets over</div>
							</div>
							<a href="/league/player/{s.matchups.dominated.playerId}?season={data.seasonId}"
								class="text-success hover:text-success/80 font-medium">{s.matchups.dominated.tag}</a>
						</div>
					{/if}
					{#if s.matchups.rival}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Rival</div>
								<div class="text-xs text-muted-foreground">{s.matchups.rival.wins}-{s.matchups.rival.losses} in {s.matchups.rival.total} sets</div>
							</div>
							<a href="/league/player/{s.matchups.rival.playerId}?season={data.seasonId}"
								class="text-primary hover:text-primary/80 font-medium">{s.matchups.rival.tag}</a>
						</div>
					{/if}
					{#if s.matchups.gatekeeper}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Gatekeeper</div>
								<div class="text-xs text-muted-foreground">{s.matchups.gatekeeper.closeGames} close set{s.matchups.gatekeeper.closeGames > 1 ? 's' : ''}, {s.matchups.gatekeeper.wins}-{s.matchups.gatekeeper.losses}</div>
							</div>
							<a href="/league/player/{s.matchups.gatekeeper.playerId}?season={data.seasonId}"
								class="text-foreground hover:text-primary font-medium">{s.matchups.gatekeeper.tag}</a>
						</div>
					{/if}
					{#if s.matchups.biggestUpset}
						<div class="flex justify-between text-sm">
							<div>
								<div class="text-foreground font-medium">Biggest Upset</div>
								<div class="text-xs text-muted-foreground">+{s.matchups.biggestUpset.upsetFactor} pts gap</div>
							</div>
							<a href="/league/player/{s.matchups.biggestUpset.playerId}?season={data.seasonId}"
								class="text-success hover:text-success/80 font-medium">{s.matchups.biggestUpset.tag}</a>
						</div>
					{/if}
					{#if !s.matchups.nemesis && !s.matchups.dominated && !s.matchups.rival && !s.matchups.gatekeeper && !s.matchups.biggestUpset}
						<div class="text-sm text-muted-foreground">Not enough data yet</div>
					{/if}
				</div>
			</div>

			<!-- Match History -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
					Match History ({s.matchesPlayed})
				</h2>
				<div class="space-y-4 max-h-[600px] overflow-y-auto">
					{#each s.matchesByEvent as evt}
						<div>
							<div class="flex items-center justify-between mb-1.5">
								<span class="text-xs font-semibold text-foreground">{evt.name}</span>
								<div class="flex items-center gap-2">
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
									{@const pl = phaseLabel(match.phase)}
									<div class="flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm">
										<span class="w-2 h-2 rounded-full shrink-0 {won ? 'bg-green-500' : 'bg-red-500'}"></span>
										<span class="{won ? 'text-success' : 'text-destructive'} font-medium w-10 shrink-0">{won ? 'Win' : 'Lose'}</span>
										<span class="text-muted-foreground shrink-0">vs</span>
										<a href="/league/player/{oppId}?season={data.seasonId}"
											class="flex-1 text-foreground hover:text-primary truncate">{oppTag}</a>
										{#if myScore > 0 || oppScore > 0}
											<span class="text-xs text-muted-foreground shrink-0">{myScore}-{oppScore}</span>
										{/if}
										<span class="text-xs px-1.5 py-0.5 rounded shrink-0 hidden sm:inline {pl.classes}">
											{pl.text}
										</span>
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
