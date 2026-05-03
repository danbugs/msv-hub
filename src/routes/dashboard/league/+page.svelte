<script lang="ts">
	import { onMount } from 'svelte';

	interface SeasonData {
		id: number;
		name: string;
		startDate: string;
		endDate: string;
		events: { slug: string; name: string; date: string; eventNumber: number; entrantCount: number }[];
		rankings: { playerId: string; gamerTag: string; points: number; rank: number }[];
		totalMatches: number;
	}

	let season = $state<SeasonData | null>(null);
	let loading = $state(false);
	let importing = $state(false);
	let importLogs = $state<string[]>([]);
	let error = $state('');

	const SEASON_ID = 10;

	onMount(async () => {
		loading = true;
		const res = await fetch(`/api/league/season/${SEASON_ID}`);
		if (res.ok) season = await res.json();
		loading = false;
	});

	async function runImport() {
		if (!confirm('Import Season 10 data from StartGG? This fetches all match data for MSV 125-137 and may take a few minutes.')) return;
		importing = true;
		importLogs = [];
		error = '';

		const slugs = [];
		for (let i = 125; i <= 137; i++) {
			slugs.push(`microspacing-vancouver-${i}`);
		}

		try {
			const res = await fetch('/api/league/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					seasonId: SEASON_ID,
					seasonName: 'Season 10',
					startDate: '2026-02-01',
					endDate: '2026-05-12',
					tournamentSlugs: slugs
				})
			});

			const data = await res.json();
			if (res.ok) {
				importLogs = data.logs ?? [];
				const refreshRes = await fetch(`/api/league/season/${SEASON_ID}`);
				if (refreshRes.ok) season = await refreshRes.json();
			} else {
				error = data.error ?? 'Import failed';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Network error';
		}
		importing = false;
	}
</script>

<main class="mx-auto max-w-4xl px-4 py-8">
	<div class="flex items-center justify-between mb-6">
		<div>
			<h1 class="text-2xl font-bold text-foreground">League Management</h1>
			<p class="mt-1 text-muted-foreground">Season 10 — TrueSkill Rankings</p>
		</div>
		<a href="/league" target="_blank"
			class="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
			Public View ↗
		</a>
	</div>

	{#if loading}
		<div class="rounded-lg border border-border bg-card p-8 text-center animate-pulse">
			<div class="h-4 w-48 mx-auto rounded bg-secondary"></div>
		</div>
	{:else if season}
		<div class="grid gap-4 sm:grid-cols-3 mb-6">
			<div class="rounded-lg border border-border bg-card p-4">
				<div class="text-sm text-muted-foreground">Events</div>
				<div class="text-2xl font-bold text-foreground">{season.events.length}</div>
			</div>
			<div class="rounded-lg border border-border bg-card p-4">
				<div class="text-sm text-muted-foreground">Players</div>
				<div class="text-2xl font-bold text-foreground">{season.rankings.length}</div>
			</div>
			<div class="rounded-lg border border-border bg-card p-4">
				<div class="text-sm text-muted-foreground">Matches</div>
				<div class="text-2xl font-bold text-foreground">{season.totalMatches}</div>
			</div>
		</div>

		<div class="mb-6">
			<h2 class="text-sm font-semibold text-muted-foreground mb-2">Events Imported</h2>
			<div class="space-y-1">
				{#each season.events as evt}
					<div class="flex items-center justify-between rounded-lg bg-card px-3 py-2 text-sm">
						<span class="text-foreground">{evt.name}</span>
						<span class="text-muted-foreground">{evt.entrantCount} entrants · {evt.date}</span>
					</div>
				{/each}
			</div>
		</div>

		<button onclick={runImport} disabled={importing}
			class="rounded-lg border border-warning-border bg-warning-muted px-4 py-2 text-sm font-medium text-warning hover:bg-warning-muted/80 transition-colors disabled:opacity-50">
			{importing ? 'Importing...' : 'Re-import from StartGG'}
		</button>
	{:else}
		<div class="rounded-xl border border-dashed border-border p-8 text-center">
			<p class="text-muted-foreground mb-4">No league data yet. Import Season 10 from StartGG to get started.</p>
			<button onclick={runImport} disabled={importing}
				class="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
				{importing ? 'Importing...' : 'Import Season 10'}
			</button>
		</div>
	{/if}

	{#if error}
		<div class="mt-4 rounded-lg border border-destructive-border bg-destructive-muted px-4 py-3 text-sm text-destructive">
			{error}
		</div>
	{/if}

	{#if importLogs.length > 0}
		<div class="mt-4 rounded-lg border border-border bg-card p-4">
			<h3 class="text-sm font-semibold text-muted-foreground mb-2">Import Log</h3>
			<div class="max-h-64 overflow-y-auto space-y-0.5">
				{#each importLogs as log}
					<div class="text-xs text-muted-foreground font-mono">{log}</div>
				{/each}
			</div>
		</div>
	{/if}
</main>
