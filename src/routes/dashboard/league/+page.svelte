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
	let addEventNumber = $state('');

	const SEASON_ID = 10;
	const SEASON_START = 125;

	onMount(async () => {
		loading = true;
		const res = await fetch(`/api/league/season/${SEASON_ID}`);
		if (res.ok) season = await res.json();
		loading = false;
	});

	function getNextEventNumber(): number {
		if (!season?.events.length) return SEASON_START;
		return Math.max(...season.events.map((e) => e.eventNumber)) + 1;
	}

	async function runImport(slugStart: number, slugEnd: number) {
		importing = true;
		importLogs = [];
		error = '';

		const slugs = [];
		for (let i = slugStart; i <= slugEnd; i++) {
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

	async function addEvent() {
		const num = parseInt(addEventNumber.trim(), 10);
		if (isNaN(num) || num < 1) { error = 'Enter a valid event number'; return; }

		const allSlugs: string[] = [];
		if (season?.events.length) {
			for (const evt of season.events) {
				allSlugs.push(evt.slug);
			}
		}
		allSlugs.push(`microspacing-vancouver-${num}`);
		allSlugs.sort((a, b) => {
			const na = parseInt(a.match(/(\d+)$/)?.[1] ?? '0', 10);
			const nb = parseInt(b.match(/(\d+)$/)?.[1] ?? '0', 10);
			return na - nb;
		});

		const min = parseInt(allSlugs[0].match(/(\d+)$/)?.[1] ?? '0', 10);
		const max = parseInt(allSlugs[allSlugs.length - 1].match(/(\d+)$/)?.[1] ?? '0', 10);

		if (!confirm(`Add MSV #${num} to Season 10? This will re-process ratings with the new event included.`)) return;
		addEventNumber = '';
		await runImport(min, max);
	}

	async function fullReimport() {
		if (!season?.events.length) return;
		if (!confirm('Re-import all events from StartGG? This re-fetches all match data and may take a few minutes.')) return;
		const min = Math.min(...season.events.map((e) => e.eventNumber));
		const max = Math.max(...season.events.map((e) => e.eventNumber));
		await runImport(min, max);
	}

	async function initialImport() {
		if (!confirm('Import Season 10 data from StartGG? This fetches all match data for MSV 125-137 and may take a few minutes.')) return;
		await runImport(125, 137);
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

		<!-- Add Event -->
		<div class="rounded-xl border border-border bg-card p-5 mb-4">
			<h2 class="text-sm font-bold text-foreground mb-3">Add Event</h2>
			<div class="flex gap-2 items-center">
				<span class="text-sm text-muted-foreground shrink-0">MSV #</span>
				<input
					bind:value={addEventNumber}
					placeholder={String(getNextEventNumber())}
					type="number"
					class="w-24 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
				<button onclick={addEvent} disabled={importing}
					class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
					{importing ? 'Importing...' : 'Add'}
				</button>
			</div>
			<p class="mt-2 text-xs text-muted-foreground">
				Only the new event will be fetched from StartGG. Existing events use cached data. Ratings are re-computed with the new event included.
			</p>
		</div>

		<button onclick={fullReimport} disabled={importing}
			class="rounded-lg border border-warning-border bg-warning-muted px-4 py-2 text-sm font-medium text-warning hover:bg-warning-muted/80 transition-colors disabled:opacity-50">
			{importing ? 'Importing...' : 'Re-import all from StartGG'}
		</button>
	{:else}
		<div class="rounded-xl border border-dashed border-border p-8 text-center">
			<p class="text-muted-foreground mb-4">No league data yet. Import Season 10 from StartGG to get started.</p>
			<button onclick={initialImport} disabled={importing}
				class="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
				{importing ? 'Importing...' : 'Import Season 10 (MSV 125-137)'}
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
