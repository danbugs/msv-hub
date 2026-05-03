<script lang="ts">
	import { onMount } from 'svelte';

	let { data } = $props();
	let chartCanvas = $state<HTMLCanvasElement | null>(null);
	let chartMode = $state<'rank' | 'points'>('rank');

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

		const style = getComputedStyle(document.documentElement);
		const borderColor = style.getPropertyValue('--border').trim();
		const mutedColor = style.getPropertyValue('--muted-foreground').trim();
		const primaryColor = style.getPropertyValue('--primary').trim();

		// Grid lines
		ctx.strokeStyle = `oklch(${borderColor})`;
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
			ctx.fillStyle = `oklch(${mutedColor})`;
			ctx.font = '10px system-ui';
			ctx.textAlign = 'right';
			ctx.fillText(String(label), pad.left - 6, y + 3);
		}

		// Data line
		ctx.strokeStyle = `oklch(${primaryColor})`;
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
		ctx.fillStyle = `oklch(${primaryColor})`;
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
		ctx.fillStyle = `oklch(${mutedColor})`;
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
	});

	$effect(() => {
		chartMode;
		drawChart();
	});
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
				<h1 class="text-2xl font-bold text-foreground">{s.player.gamerTag}</h1>
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
							<span class="rounded-full bg-secondary px-3 py-1 text-sm text-foreground">
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
			</div>

			<!-- Matchups -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">Matchups</h2>
				<div class="space-y-2">
					{#if s.matchups.mostWon}
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Most won</span>
							<span>
								<span class="text-success font-medium">{s.matchups.mostWon.count}x</span>
								<span class="text-muted-foreground"> vs </span>
								<a href="/league/player/{s.matchups.mostWon.playerId}?season={data.seasonId}" class="text-foreground hover:text-primary">{s.matchups.mostWon.tag}</a>
							</span>
						</div>
					{/if}
					{#if s.matchups.mostLost}
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Most lost</span>
							<span>
								<span class="text-destructive font-medium">{s.matchups.mostLost.count}x</span>
								<span class="text-muted-foreground"> vs </span>
								<a href="/league/player/{s.matchups.mostLost.playerId}?season={data.seasonId}" class="text-foreground hover:text-primary">{s.matchups.mostLost.tag}</a>
							</span>
						</div>
					{/if}
					{#if s.matchups.mostPlayed}
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Most played</span>
							<span>
								<span class="font-medium text-foreground">{s.matchups.mostPlayed.count}x</span>
								<span class="text-muted-foreground"> vs </span>
								<a href="/league/player/{s.matchups.mostPlayed.playerId}?season={data.seasonId}" class="text-foreground hover:text-primary">{s.matchups.mostPlayed.tag}</a>
							</span>
						</div>
					{/if}
					{#if s.matchups.bestWinRate}
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Best win rate <span class="text-xs">(min 3)</span></span>
							<span>
								<span class="text-success font-medium">{s.matchups.bestWinRate.rate}%</span>
								<span class="text-muted-foreground"> vs </span>
								<a href="/league/player/{s.matchups.bestWinRate.playerId}?season={data.seasonId}" class="text-foreground hover:text-primary">{s.matchups.bestWinRate.tag}</a>
							</span>
						</div>
					{/if}
					{#if s.matchups.worstWinRate}
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Worst win rate <span class="text-xs">(min 3)</span></span>
							<span>
								<span class="text-destructive font-medium">{s.matchups.worstWinRate.rate}%</span>
								<span class="text-muted-foreground"> vs </span>
								<a href="/league/player/{s.matchups.worstWinRate.playerId}?season={data.seasonId}" class="text-foreground hover:text-primary">{s.matchups.worstWinRate.tag}</a>
							</span>
						</div>
					{/if}
				</div>
			</div>

			<!-- Match History -->
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
					Match History ({s.matchesPlayed})
				</h2>
				<div class="space-y-1 max-h-[500px] overflow-y-auto">
					{#each s.recentMatches as match}
						{@const isP1 = match.player1Id === s.player.id}
						{@const won = match.winnerId === s.player.id}
						{@const oppTag = isP1 ? match.player2Tag : match.player1Tag}
						{@const oppId = isP1 ? match.player2Id : match.player1Id}
						{@const myScore = isP1 ? match.player1Score : match.player2Score}
						{@const oppScore = isP1 ? match.player2Score : match.player1Score}
						<div class="flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm">
							<span class="w-2 h-2 rounded-full shrink-0 {won ? 'bg-green-500' : 'bg-red-500'}"></span>
							<span class="{won ? 'text-success' : 'text-destructive'} font-medium w-10 shrink-0">{won ? 'Win' : 'Lose'}</span>
							<span class="text-muted-foreground shrink-0">vs</span>
							<a href="/league/player/{oppId}?season={data.seasonId}"
								class="flex-1 text-foreground hover:text-primary truncate">{oppTag}</a>
							{#if myScore > 0 || oppScore > 0}
								<span class="text-xs text-muted-foreground shrink-0">{myScore}-{oppScore}</span>
							{/if}
							<span class="text-xs text-muted-foreground shrink-0 hidden sm:inline">{match.date}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>
