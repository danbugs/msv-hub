<script lang="ts">
	let { data } = $props();

	let searchQuery = $state('');
	let showGallery = $state(false);
	let lightboxSeason = $state<number | null>(null);

	const seasons = Array.from({ length: 9 }, (_, i) => i + 1);

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
							{data.season.name}{#if data.season.startDate} · {data.season.startDate} to {data.season.endDate}{/if}
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
							<th class="px-4 py-3 text-right">Points</th>
						</tr>
					</thead>
					<tbody>
						{#each filteredRankings() as player}
							<tr class="border-b border-border last:border-0 hover:bg-accent/50 transition-colors">
								<td class="px-4 py-3 text-muted-foreground font-mono text-xs">{player.rank}</td>
								<td class="px-4 py-3">
									<div class="flex items-center gap-2">
										{#if player.characters?.length}
											<div class="flex -space-x-1 shrink-0">
												{#each player.characters as char}
													{#if char.iconUrl}
														<img src={char.iconUrl} alt={char.name} title={char.name} class="h-5 w-5 object-contain" />
													{/if}
												{/each}
											</div>
										{/if}
										<a href="/league/player/{player.playerId}?season={data.seasonId}"
											class="text-foreground hover:text-primary font-medium transition-colors">
											{player.gamerTag}
										</a>
										<span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
											style="color: {player.tierColor}; background: {player.tierColor}15;">
											{player.tier}
										</span>
									</div>
								</td>
								<td class="px-4 py-3 text-right hidden sm:table-cell">
									<span class="text-success">{player.wins}</span>
									<span class="text-muted-foreground">-</span>
									<span class="text-destructive">{player.losses}</span>
								</td>
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

			{#if data.events?.length}
				<div class="mt-6">
					<div class="flex items-center gap-2 mb-3">
						<h2 class="text-sm font-bold text-foreground uppercase tracking-wider">Events</h2>
						<span class="text-[10px] text-muted-foreground" title="Tiers are based on average player rating of attendees. S = top 20% strongest field, A = top 40%, B = top 60%, C = top 80%, D = bottom 20%.">
							S/A/B/C/D = field strength &#9432;
						</span>
					</div>
					<div class="space-y-1">
						{#each data.events as evt}
							<div class="flex items-center justify-between rounded-lg bg-card border border-border px-3 py-2 text-sm">
								<div class="flex items-center gap-2">
									<span class="text-xs font-bold w-5 text-center" style="color: {evt.color};"
										title="Tier {evt.tier} — based on average attendee rating">{evt.tier}</span>
									<a href="https://www.start.gg/tournament/{evt.slug}" target="_blank" rel="noopener"
										class="text-foreground hover:text-primary transition-colors">{evt.name} ↗</a>
								</div>
								<span class="text-xs text-muted-foreground">{evt.entrantCount} entrants · {evt.date}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- PR Graphics Gallery -->
			<div class="mt-6">
				<button onclick={() => showGallery = !showGallery}
					class="flex items-center gap-2 text-sm font-bold text-foreground uppercase tracking-wider mb-3 hover:text-primary transition-colors">
					<span class="text-xs transition-transform" class:rotate-90={showGallery}>&#9654;</span>
					Past Season Graphics
				</button>
				{#if showGallery}
					<div class="grid grid-cols-3 gap-3">
						{#each seasons as s}
							<button onclick={() => lightboxSeason = s}
								class="rounded-lg border border-border overflow-hidden hover:border-primary transition-colors aspect-[4/3] bg-card">
								<img src="/pr-graphics/season{s}.png" alt="Season {s}" loading="lazy"
									class="w-full h-full object-cover" />
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Tier Legends -->
			<div class="mt-6 rounded-xl border border-border bg-card p-4">
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<div class="text-xs font-bold text-foreground uppercase tracking-wider mb-2">Player Tiers</div>
						<div class="space-y-1">
							{#each [
								{ name: 'Master', color: '#ef4444', req: '7000+ pts' },
								{ name: 'Diamond', color: '#38bdf8', req: '6500+ pts' },
								{ name: 'Platinum', color: '#a3e635', req: '6000+ pts' },
								{ name: 'Gold', color: '#fbbf24', req: '5500+ pts' },
								{ name: 'Silver', color: '#94a3b8', req: '5000+ pts' },
								{ name: 'Bronze', color: '#d97706', req: '4500+ pts' },
								{ name: 'Copper', color: '#b87333', req: '4000+ pts' },
								{ name: 'Iron', color: '#78716c', req: '< 4000 pts' }
							] as t}
								<div class="flex items-center justify-between text-xs">
									<span class="font-bold px-1.5 py-0.5 rounded" style="color: {t.color}; background: {t.color}15;">{t.name}</span>
									<span class="text-muted-foreground">{t.req}</span>
								</div>
							{/each}
						</div>
					</div>
					<div>
						<div class="text-xs font-bold text-foreground uppercase tracking-wider mb-2">Tournament Tiers</div>
						<div class="space-y-1">
							{#each [
								{ tier: 'S', color: '#ef4444', desc: 'Top 20% strongest field' },
								{ tier: 'A', color: '#f87171', desc: 'Top 40%' },
								{ tier: 'B', color: '#fbbf24', desc: 'Top 60%' },
								{ tier: 'C', color: '#a3e635', desc: 'Top 80%' },
								{ tier: 'D', color: '#94a3b8', desc: 'Bottom 20%' }
							] as t}
								<div class="flex items-center justify-between text-xs">
									<span class="font-bold w-5 text-center" style="color: {t.color};">{t.tier}</span>
									<span class="text-muted-foreground">{t.desc}</span>
								</div>
							{/each}
						</div>
						<p class="mt-1.5 text-[10px] text-muted-foreground/60">Based on average TrueSkill rating of attendees</p>
					</div>
				</div>
			</div>

			<div class="mt-4 text-center text-xs text-muted-foreground">
				Powered by TrueSkill — Rankings updated after each event
			</div>
		{/if}
	</div>
</div>

<!-- Lightbox -->
{#if lightboxSeason !== null}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
		role="dialog" aria-modal="true"
		onclick={() => lightboxSeason = null}
		onkeydown={(e) => {
			if (e.key === 'Escape') lightboxSeason = null;
			if (e.key === 'ArrowLeft' && lightboxSeason !== null && lightboxSeason > 1) lightboxSeason--;
			if (e.key === 'ArrowRight' && lightboxSeason !== null && lightboxSeason < 9) lightboxSeason++;
		}}>
		<div class="relative max-w-4xl w-full mx-4" onclick={(e) => e.stopPropagation()}>
			<div class="flex items-center justify-between mb-2">
				<span class="text-white text-sm font-bold">Season {lightboxSeason}</span>
				<div class="flex items-center gap-2">
					<button onclick={() => { if (lightboxSeason! > 1) lightboxSeason!--; }}
						disabled={lightboxSeason === 1}
						class="text-white/70 hover:text-white disabled:text-white/30 text-lg px-2">&#8592;</button>
					<span class="text-white/50 text-xs">{lightboxSeason} / 9</span>
					<button onclick={() => { if (lightboxSeason! < 9) lightboxSeason!++; }}
						disabled={lightboxSeason === 9}
						class="text-white/70 hover:text-white disabled:text-white/30 text-lg px-2">&#8594;</button>
					<button onclick={() => lightboxSeason = null}
						class="text-white/70 hover:text-white text-xl px-2 ml-2">&#10005;</button>
				</div>
			</div>
			<img src="/pr-graphics/season{lightboxSeason}.png" alt="Season {lightboxSeason}"
				class="w-full rounded-lg shadow-2xl" />
		</div>
	</div>
{/if}
