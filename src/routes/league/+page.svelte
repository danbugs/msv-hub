<script lang="ts">
	let { data } = $props();

	let searchQuery = $state('');

	function filteredRankings() {
		if (!searchQuery.trim()) return data.rankings;
		const q = searchQuery.toLowerCase();
		return data.rankings.filter((r: { gamerTag: string; aliases?: string[] }) =>
			r.gamerTag.toLowerCase().includes(q) ||
			(r.aliases ?? []).some((a: string) => a.toLowerCase().includes(q))
		);
	}
</script>

<svelte:head>
	<title>{data.season?.name ?? 'League'} — MSV League</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<div class="border-b border-border bg-card/90 backdrop-blur-md">
		<div class="mx-auto max-w-3xl px-4 py-5">
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-xl font-bold text-primary">MSV League</h1>
					{#if data.season}
						<p class="text-sm text-muted-foreground">
							{data.season.name} · {data.season.startDate} to {data.season.endDate}
						</p>
					{/if}
				</div>
				<div class="text-right">
					{#if data.season}
						<div class="text-xs text-muted-foreground">
							{data.rankings.length} players · {data.season.eventCount} events
						</div>
						<div class="text-xs text-muted-foreground mt-0.5">TrueSkill Rating</div>
					{/if}
				</div>
			</div>
		</div>
	</div>

	<div class="mx-auto max-w-3xl px-4 py-6">
		{#if !data.season}
			<div class="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
				No league data available. Check back later.
			</div>
		{:else}
			<div class="mb-4">
				<input
					bind:value={searchQuery}
					placeholder="Search player..."
					class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none" />
			</div>

			<div class="rounded-xl border border-border bg-card overflow-hidden">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border text-left text-xs text-muted-foreground">
							<th class="px-4 py-3 w-12">#</th>
							<th class="px-4 py-3">Player</th>
							<th class="px-4 py-3 text-right hidden sm:table-cell">W-L</th>
							<th class="px-4 py-3 text-right hidden sm:table-cell">Events</th>
							<th class="px-4 py-3 text-right">Points</th>
						</tr>
					</thead>
					<tbody>
						{#each filteredRankings() as player}
							<tr class="border-b border-border last:border-0 hover:bg-accent/50 transition-colors">
								<td class="px-4 py-3 text-muted-foreground font-mono text-xs">{player.rank}</td>
								<td class="px-4 py-3">
									<a href="/league/player/{player.playerId}?season={data.seasonId}"
										class="text-foreground hover:text-primary font-medium transition-colors">
										{player.gamerTag}
									</a>
								</td>
								<td class="px-4 py-3 text-right hidden sm:table-cell">
									<span class="text-success">{player.wins}</span>
									<span class="text-muted-foreground">-</span>
									<span class="text-destructive">{player.losses}</span>
								</td>
								<td class="px-4 py-3 text-right text-muted-foreground hidden sm:table-cell">{player.events}</td>
								<td class="px-4 py-3 text-right font-mono font-semibold text-foreground">{player.points}</td>
							</tr>
						{/each}
						{#if filteredRankings().length === 0}
							<tr>
								<td colspan="5" class="px-4 py-8 text-center text-muted-foreground">No players found</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>

			<div class="mt-4 text-center text-xs text-muted-foreground">
				Powered by TrueSkill — Rankings updated after each event
			</div>
		{/if}
	</div>
</div>
