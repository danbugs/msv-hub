<script lang="ts">
	import { onMount } from 'svelte';
	import type { UsageSummary, TrackedPage } from '$lib/server/analytics';

	const PAGES: { key: TrackedPage; label: string; color: string }[] = [
		{ key: 'league', label: 'Rankings', color: 'var(--color-primary)' },
		{ key: 'league-player', label: 'Player pages', color: 'var(--color-warning)' },
		{ key: 'ranker', label: 'Tier list maker', color: 'var(--color-success)' }
	];
	const CHART_DAYS = 14;
	const TOP_PLAYERS = 10;

	let usage = $state<UsageSummary | null>(null);
	let failed = $state(false);
	let range = $state<'7' | '30'>('7');
	let open = $state(true);
	let showAllPlayers = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/analytics/usage');
			if (!res.ok) throw new Error(String(res.status));
			usage = await res.json();
		} catch {
			failed = true;
		}
	});

	const playerViews = $derived(usage?.players?.[range] ?? []);
	const shownPlayers = $derived(showAllPlayers ? playerViews : playerViews.slice(0, TOP_PLAYERS));
	const topViews = $derived(Math.max(1, playerViews[0]?.views ?? 0));
	const chartDays = $derived(usage?.days.slice(-CHART_DAYS) ?? []);
	const chartMax = $derived(Math.max(1, ...chartDays.map((d) => PAGES.reduce((n, p) => n + d.pages[p.key].visitors, 0))));

	function shortDate(iso: string): string {
		const [, m, d] = iso.split('-').map(Number);
		return `${m}/${d}`;
	}
</script>

<section class="mb-6 rounded-lg border border-border bg-card p-4">
	<div class="flex items-center justify-between gap-2">
		<button onclick={() => (open = !open)} class="flex items-center gap-2 text-sm font-bold text-foreground">
			<span class="text-xs text-muted-foreground transition-transform" class:rotate-90={open}>&#9654;</span>
			Public page usage
		</button>
		{#if open && usage}
			<div class="flex gap-1">
				{#each ['7', '30'] as r (r)}
					<button onclick={() => (range = r as '7' | '30')}
						class="rounded-md px-2 py-0.5 text-xs font-medium {range === r ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}">
						{r} days
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if open}
		{#if failed}
			<p class="mt-3 text-sm text-muted-foreground">Couldn't load usage stats.</p>
		{:else if !usage}
			<div class="mt-3 h-24 animate-pulse rounded bg-secondary"></div>
		{:else}
			<div class="mt-3 grid gap-3 sm:grid-cols-3">
				{#each PAGES as p (p.key)}
					{@const t = usage.totals[range][p.key]}
					<div class="rounded-md border border-border p-3">
						<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
							<span class="h-2 w-2 rounded-full" style="background:{p.color}"></span>{p.label}
						</div>
						<div class="mt-1 text-2xl font-bold text-foreground">{t.visitors}</div>
						<div class="text-xs text-muted-foreground">
							visitor{t.visitors === 1 ? '' : 's'} · {t.views} view{t.views === 1 ? '' : 's'}{#if p.key === 'ranker'}{' · '}{t.exports} export{t.exports === 1 ? '' : 's'}{/if}
						</div>
					</div>
				{/each}
			</div>

			<!-- Daily unique visitors, stacked by page -->
			<div class="mt-4">
				<div class="mb-1 text-xs text-muted-foreground">Daily visitors, last {CHART_DAYS} days</div>
				<div class="flex h-24 items-end gap-1">
					{#each chartDays as d (d.date)}
						{@const total = PAGES.reduce((n, p) => n + d.pages[p.key].visitors, 0)}
						<div class="flex h-full min-w-0 flex-1 flex-col justify-end"
							title="{d.date}: {PAGES.map((p) => `${p.label} ${d.pages[p.key].visitors}`).join(', ')}">
							<div class="flex flex-col-reverse overflow-hidden rounded-sm" style="height:{(total / chartMax) * 100}%">
								{#each PAGES as p (p.key)}
									{#if d.pages[p.key].visitors}
										<div style="background:{p.color}; flex-grow:{d.pages[p.key].visitors}"></div>
									{/if}
								{/each}
							</div>
						</div>
					{/each}
				</div>
				<div class="mt-1 flex gap-1 text-[9px] text-muted-foreground">
					{#each chartDays as d, i (d.date)}
						<span class="min-w-0 flex-1 text-center">{i % 2 === 0 ? shortDate(d.date) : ''}</span>
					{/each}
				</div>
			</div>
			<div class="mt-5">
				<div class="mb-2 flex items-baseline justify-between gap-2">
					<div class="text-xs font-semibold text-foreground">Most-viewed player pages</div>
					<div class="text-xs text-muted-foreground">{playerViews.length} player{playerViews.length === 1 ? '' : 's'} viewed · last {range} days</div>
				</div>
				{#if playerViews.length}
					<ol class="space-y-1">
						{#each shownPlayers as pl, i (pl.id)}
							<li class="relative flex items-center gap-2 overflow-hidden rounded px-2 py-1 text-sm">
								<!-- Bar behind the row, scaled to the most-viewed player -->
								<span class="absolute inset-y-0 left-0 rounded bg-warning/15" style="width:{(pl.views / topViews) * 100}%"></span>
								<span class="relative w-6 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
								<a href="/league/player/{pl.id}?season=all-time" target="_blank" rel="noopener"
									class="relative min-w-0 flex-1 truncate font-medium text-foreground hover:text-primary hover:underline">{pl.tag}</a>
								<span class="relative shrink-0 text-xs tabular-nums text-muted-foreground">{pl.views} view{pl.views === 1 ? '' : 's'}</span>
							</li>
						{/each}
					</ol>
					{#if playerViews.length > TOP_PLAYERS}
						<button onclick={() => (showAllPlayers = !showAllPlayers)} class="mt-2 text-xs font-medium text-primary hover:underline">
							{showAllPlayers ? 'Show top 10' : `Show all ${playerViews.length}`}
						</button>
					{/if}
				{:else}
					<p class="text-sm text-muted-foreground">No player pages viewed yet.</p>
				{/if}
			</div>

			<p class="mt-3 text-[11px] text-muted-foreground">
				Anonymous counts; visits while logged in as a TO aren't included. Days are Vancouver time.
			</p>
		{/if}
	{/if}
</section>
