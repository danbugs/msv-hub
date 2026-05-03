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
	let mergeSearch1 = $state('');
	let mergeSearch2 = $state('');
	let mergePlayer1 = $state<{ id: string; tag: string } | null>(null);
	let mergePlayer2 = $state<{ id: string; tag: string } | null>(null);
	let merges = $state<Record<string, string>>({});
	let mergeError = $state('');
	let minEvents = $state(2);
	let attendanceBonus = $state(50);
	let awards = $state<{ title: string; description: string; playerId?: string; playerTag?: string; secondPlayerId?: string; secondPlayerTag?: string; value: string }[]>([]);

	const SEASON_ID = 10;
	const SEASON_START = 125;

	onMount(async () => {
		loading = true;
		const [seasonRes, mergeRes, configRes, awardsRes] = await Promise.all([
			fetch(`/api/league/season/${SEASON_ID}`),
			fetch('/api/league/merge'),
			fetch('/api/league/config'),
			fetch(`/api/league/awards?season=${SEASON_ID}`)
		]);
		if (seasonRes.ok) season = await seasonRes.json();
		if (mergeRes.ok) merges = await mergeRes.json();
		if (awardsRes.ok) awards = await awardsRes.json();
		if (configRes.ok) {
			const cfg = await configRes.json();
			minEvents = cfg.minEvents ?? 2;
			attendanceBonus = cfg.attendanceBonus ?? 50;
		}
		loading = false;
	});

	function getNextEventNumber(): number {
		if (!season?.events.length) return SEASON_START;
		return Math.max(...season.events.map((e) => e.eventNumber)) + 1;
	}

	async function runImportWithSlugs(slugs: string[]) {
		importing = true;
		importLogs = [];
		error = '';

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

	function getAllSeasonSlugs(): string[] {
		if (!season?.events.length) return [];
		return season.events.map((e) => e.slug);
	}

	async function addEvent() {
		const input = addEventNumber.trim();
		if (!input) { error = 'Enter an event slug or number'; return; }

		let newSlug: string;
		if (/^\d+$/.test(input)) {
			newSlug = `microspacing-vancouver-${input}`;
		} else {
			newSlug = input;
		}

		const allSlugs = [...getAllSeasonSlugs(), newSlug];
		const unique = [...new Set(allSlugs)];

		if (!confirm(`Add ${newSlug} to Season 10? This will re-process ratings with the new event included.`)) return;
		addEventNumber = '';
		await runImportWithSlugs(unique);
	}

	async function fullReimport() {
		if (!season?.events.length) return;
		if (!confirm('Re-import all events from StartGG? This re-fetches all match data and may take a few minutes.')) return;
		await runImportWithSlugs(getAllSeasonSlugs());
	}

	async function initialImport() {
		if (!confirm('Import Season 10 data from StartGG? This fetches all match data for MSV 125-137 and may take a few minutes.')) return;
		const slugs = [];
		for (let i = 125; i <= 137; i++) slugs.push(`microspacing-vancouver-${i}`);
		await runImportWithSlugs(slugs);
	}

	function searchPlayers(query: string): { id: string; tag: string }[] {
		if (!season || !query.trim()) return [];
		const q = query.toLowerCase();
		return season.rankings
			.filter((r: { gamerTag: string }) => r.gamerTag.toLowerCase().includes(q))
			.slice(0, 5)
			.map((r: { playerId: string; gamerTag: string }) => ({ id: r.playerId, tag: r.gamerTag }));
	}

	async function submitMerge() {
		mergeError = '';
		if (!mergePlayer1 || !mergePlayer2) { mergeError = 'Select both players'; return; }
		if (mergePlayer1.id === mergePlayer2.id) { mergeError = 'Cannot merge a player with themselves'; return; }
		if (!confirm(`Merge "${mergePlayer2.tag}" into "${mergePlayer1.tag}"? This will re-import the season with the merge applied.`)) return;

		const res = await fetch('/api/league/merge', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ primaryId: mergePlayer1.id, secondaryId: mergePlayer2.id })
		});
		if (res.ok) {
			merges = { ...merges, [mergePlayer2.id]: mergePlayer1.id };
			mergePlayer1 = null;
			mergePlayer2 = null;
			mergeSearch1 = '';
			mergeSearch2 = '';
			const slugs = getAllSeasonSlugs();
			if (slugs.length > 0) await runImportWithSlugs(slugs);
		} else {
			mergeError = (await res.json()).error ?? 'Merge failed';
		}
	}

	async function undoMerge(secondaryId: string) {
		const res = await fetch('/api/league/merge', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ secondaryId })
		});
		if (res.ok) {
			const updated = { ...merges };
			delete updated[secondaryId];
			merges = updated;
		}
	}

	async function deleteEvent(slug: string) {
		if (!confirm(`Delete ${slug} from the season? This will re-process ratings without it.`)) return;
		importing = true;
		importLogs = [];
		error = '';
		try {
			const res = await fetch('/api/league/event', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ seasonId: SEASON_ID, eventSlug: slug })
			});
			const data = await res.json();
			if (res.ok) {
				importLogs = data.logs ?? [];
				const refreshRes = await fetch(`/api/league/season/${SEASON_ID}`);
				if (refreshRes.ok) season = await refreshRes.json();
			} else {
				error = data.error ?? 'Delete failed';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Network error';
		}
		importing = false;
	}

	async function saveConfig() {
		await fetch('/api/league/config', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ minEvents, attendanceBonus })
		});
	}

	function playerTag(id: string): string {
		if (!season) return id;
		const r = season.rankings.find((r: { playerId: string }) => r.playerId === id);
		return r?.gamerTag ?? id;
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

		<!-- Season Awards (admin only) -->
		{#if awards.length > 0}
			<div class="mb-6">
				<h2 class="text-sm font-semibold text-muted-foreground mb-2">Season Awards (not yet public)</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					{#each awards as award}
						<div class="rounded-xl border border-border bg-card p-4" title={award.description}>
							<div class="text-xs text-muted-foreground uppercase tracking-wider">{award.title}</div>
							<div class="mt-1">
								{#if award.playerTag}
									<span class="text-foreground font-bold">{award.playerTag}</span>
								{/if}
								{#if award.secondPlayerTag}
									<span class="text-muted-foreground mx-1">vs</span>
									<span class="text-foreground font-bold">{award.secondPlayerTag}</span>
								{/if}
							</div>
							<div class="mt-1 text-xs text-muted-foreground">{award.value}</div>
							<div class="mt-1 text-[10px] text-muted-foreground/60 italic">{award.description}</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Ranking Settings -->
		<div class="rounded-xl border border-border bg-card p-5 mb-6">
			<h2 class="text-sm font-bold text-foreground mb-3">Ranking Settings</h2>
			<div class="flex flex-col sm:flex-row gap-4">
				<div>
					<label class="text-xs text-muted-foreground">Min events to qualify</label>
					<input bind:value={minEvents} type="number" min="0" max="20"
						onchange={saveConfig}
						class="mt-1 w-20 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
				</div>
				<div>
					<label class="text-xs text-muted-foreground">Attendance bonus (pts/event)</label>
					<input bind:value={attendanceBonus} type="number" min="0" max="200"
						onchange={saveConfig}
						class="mt-1 w-20 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
				</div>
			</div>
			<p class="mt-2 text-xs text-muted-foreground">
				Min events filters the public rankings. Attendance bonus adds points per event attended to reward showing up.
			</p>
		</div>

		<div class="mb-6">
			<h2 class="text-sm font-semibold text-muted-foreground mb-2">Events Imported</h2>
			<div class="space-y-1">
				{#each season.events as evt}
					<div class="flex items-center justify-between rounded-lg bg-card px-3 py-2 text-sm">
						<span class="text-foreground">{evt.name}</span>
						<div class="flex items-center gap-3">
							<span class="text-muted-foreground">{evt.entrantCount} entrants · {evt.date}</span>
							<button onclick={() => deleteEvent(evt.slug)} disabled={importing}
								class="text-xs text-destructive hover:text-destructive/80 disabled:opacity-50">Remove</button>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Add Event -->
		<div class="rounded-xl border border-border bg-card p-5 mb-4">
			<h2 class="text-sm font-bold text-foreground mb-3">Add Event</h2>
			<div class="flex gap-2 items-center">
				<input
					bind:value={addEventNumber}
					placeholder={String(getNextEventNumber()) + ' or full slug'}
					type="text"
					class="flex-1 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
				<button onclick={addEvent} disabled={importing}
					class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
					{importing ? 'Importing...' : 'Add'}
				</button>
			</div>
			<p class="mt-2 text-xs text-muted-foreground">
				Enter a number (e.g., 138) for microspacing, or a full slug (e.g., macrospacing-vancouver-7). Existing events use cached data.
			</p>
		</div>

		<!-- Merge Players -->
		<div class="rounded-xl border border-border bg-card p-5 mb-4">
			<h2 class="text-sm font-bold text-foreground mb-3">Merge Players</h2>
			<p class="text-xs text-muted-foreground mb-3">Link two StartGG accounts that belong to the same person. The secondary player's matches are attributed to the primary on next import.</p>
			<div class="flex flex-col sm:flex-row gap-2 items-start sm:items-center mb-2">
				<div class="relative flex-1 w-full">
					<input bind:value={mergeSearch1} placeholder="Primary player..."
						oninput={() => { mergePlayer1 = null; }}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
					{#if mergeSearch1 && !mergePlayer1}
						<div class="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-lg">
							{#each searchPlayers(mergeSearch1) as p}
								<button onclick={() => { mergePlayer1 = p; mergeSearch1 = p.tag; }}
									class="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-accent/50">
									{p.tag} <span class="text-xs text-muted-foreground">({p.id})</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<span class="text-xs text-muted-foreground">←</span>
				<div class="relative flex-1 w-full">
					<input bind:value={mergeSearch2} placeholder="Secondary (merged into primary)..."
						oninput={() => { mergePlayer2 = null; }}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
					{#if mergeSearch2 && !mergePlayer2}
						<div class="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-lg">
							{#each searchPlayers(mergeSearch2) as p}
								<button onclick={() => { mergePlayer2 = p; mergeSearch2 = p.tag; }}
									class="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-accent/50">
									{p.tag} <span class="text-xs text-muted-foreground">({p.id})</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
				<button onclick={submitMerge}
					class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors shrink-0">
					Merge
				</button>
			</div>
			{#if mergeError}
				<p class="text-xs text-destructive">{mergeError}</p>
			{/if}
			{#if Object.keys(merges).length > 0}
				<div class="mt-3 space-y-1">
					<div class="text-xs font-semibold text-muted-foreground mb-1">Active Merges</div>
					{#each Object.entries(merges) as [secondaryId, primaryId]}
						<div class="flex items-center justify-between rounded-lg bg-secondary px-3 py-1.5 text-sm">
							<span>
								<span class="text-muted-foreground">{playerTag(secondaryId)}</span>
								<span class="text-xs text-muted-foreground mx-1">→</span>
								<span class="text-foreground font-medium">{playerTag(primaryId)}</span>
							</span>
							<button onclick={() => undoMerge(secondaryId)}
								class="text-xs text-destructive hover:text-destructive/80">Remove</button>
						</div>
					{/each}
				</div>
			{/if}
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
