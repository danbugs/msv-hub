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
		plannedSlugs: string[];
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
	let awards = $state<{ title: string; description: string; playerId?: string; playerTag?: string; secondPlayerId?: string; secondPlayerTag?: string; value: string; candidates?: { playerId: string; playerTag: string; value: string }[] }[]>([]);
	let awardsMinEvents = $state('');
	let seasonsList = $state<{ id: number; name: string }[]>([]);
	let currentSeasonId = $state(10);
	let showCreateSeason = $state(false);
	let newSeasonId = $state('');
	let newSeasonStart = $state('');
	let newSeasonEnd = $state('');
	let newSeasonMacros = $state('');
	let newSeasonPlanOnly = $state(false);
	let adminMinEvents = $state(7);
	let adminPreview = $state<{ playerId: string; gamerTag: string; points: number; rank: number }[]>([]);

	function getSeasonId() { return currentSeasonId; }

	onMount(async () => {
		loading = true;
		const seasonsRes = await fetch('/api/league/seasons');
		if (seasonsRes.ok) {
			seasonsList = (await seasonsRes.json()).sort((a: { id: number }, b: { id: number }) => a.id - b.id);
			if (seasonsList.length > 0) currentSeasonId = seasonsList[seasonsList.length - 1].id;
		}
		await loadSeason();
		loading = false;
	});

	async function loadSeason() {
		const sid = getSeasonId();
		const [seasonRes, mergeRes, configRes, awardsRes] = await Promise.all([
			fetch(`/api/league/season/${sid}`),
			fetch('/api/league/merge'),
			fetch('/api/league/config'),
			fetch(`/api/league/awards?season=${sid}`)
		]);
		if (seasonRes.ok) season = await seasonRes.json();
		else season = null;
		if (mergeRes.ok) merges = await mergeRes.json();
		if (awardsRes.ok) awards = await awardsRes.json();
		if (configRes.ok) {
			const cfg = await configRes.json();
			minEvents = cfg.minEvents ?? 2;
			attendanceBonus = cfg.attendanceBonus ?? 50;
		}
		adminPreview = [];
	}

	function getNextEventNumber(): number {
		if (!season?.events.length) return 1;
		return Math.max(...season.events.map((e) => e.eventNumber)) + 1;
	}

	async function runImportWithSlugs(slugs: string[], forceRefetch = false) {
		const sid = getSeasonId();
		importing = true;
		importLogs = [];
		error = '';

		try {
			const res = await fetch('/api/league/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					seasonId: sid,
					seasonName: `Season ${sid}`,
					startDate: '',
					endDate: '',
					tournamentSlugs: slugs,
					forceRefetch
				})
			});

			const data = await res.json();
			if (res.ok) {
				importLogs = data.logs ?? [];
				const [refreshRes] = await Promise.all([
					fetch(`/api/league/season/${sid}`),
					fetchAwards(awardsMinEvents || undefined)
				]);
				if (refreshRes.ok) season = await refreshRes.json();
				const seasonsRes = await fetch('/api/league/seasons');
				if (seasonsRes.ok) seasonsList = (await seasonsRes.json()).sort((a: { id: number }, b: { id: number }) => a.id - b.id);
			} else {
				error = data.error ?? 'Import failed';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Network error';
		}
		importing = false;
	}

	async function fetchAwards(minEventsOverride?: string) {
		const sid = getSeasonId();
		const params = new URLSearchParams({ season: String(sid) });
		if (minEventsOverride) params.set('minEvents', minEventsOverride);
		const res = await fetch(`/api/league/awards?${params}`);
		if (res.ok) awards = await res.json();
		return res;
	}

	async function fetchAdminPreview() {
		const sid = getSeasonId();
		const res = await fetch(`/api/league/season/${sid}?minEvents=${adminMinEvents}`);
		if (res.ok) {
			const data = await res.json();
			adminPreview = data.rankings ?? [];
		}
	}

	function getAllSeasonSlugs(): string[] {
		if (!season?.events.length) return [];
		return season.events.map((e) => e.slug);
	}

	async function importSlug(slug: string) {
		const allSlugs = [...getAllSeasonSlugs(), slug];
		const unique = [...new Set(allSlugs)];
		if (!confirm(`Add ${slug} to Season ${getSeasonId()}? This will re-process ratings with the new event included.`)) return;
		await runImportWithSlugs(unique);
	}

	async function addEvent() {
		const input = addEventNumber.trim();
		if (!input) { error = 'Enter an event slug or number'; return; }

		const slug = /^\d+$/.test(input) ? `microspacing-vancouver-${input}` : input;
		addEventNumber = '';
		await importSlug(slug);
	}

	async function createSeason() {
		const newId = parseInt(newSeasonId, 10);
		if (isNaN(newId) || newId < 1) { error = 'Enter a valid season number'; return; }
		if (seasonsList.some((s) => s.id === newId)) { error = `Season ${newId} already exists`; return; }

		const start = parseInt(newSeasonStart, 10);
		const end = parseInt(newSeasonEnd, 10);
		const hasRange = !isNaN(start) && !isNaN(end) && end > start;

		if (!hasRange && (newSeasonStart || newSeasonEnd)) {
			error = 'Enter valid start/end event numbers (end is exclusive), or leave both blank';
			return;
		}

		const slugs: string[] = [];
		if (hasRange) {
			for (let i = start; i < end; i++) slugs.push(`microspacing-vancouver-${i}`);
			const macroNums = newSeasonMacros.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
			for (const n of macroNums) slugs.push(`macrospacing-vancouver-${n}`);
		}

		const action = newSeasonPlanOnly ? 'plan' : 'import';
		const label = hasRange
			? `MSV ${start}-${end - 1}${slugs.length > (end - start) ? ` + macros` : ''}, ${slugs.length} events (${action})`
			: 'empty (add events later)';
		if (!confirm(`Create Season ${newId} (${label})?`)) return;

		currentSeasonId = newId;
		showCreateSeason = false;
		const planOnly = newSeasonPlanOnly;
		newSeasonId = '';
		newSeasonStart = '';
		newSeasonEnd = '';
		newSeasonMacros = '';
		newSeasonPlanOnly = false;

		if (!planOnly && slugs.length > 0) {
			await runImportWithSlugs(slugs);
		} else {
			loading = true;
			error = '';
			try {
				const res = await fetch('/api/league/seasons', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						seasonId: newId,
						seasonName: `Season ${newId}`,
						plannedSlugs: slugs.length > 0 ? slugs : undefined
					})
				});
				if (!res.ok) { error = (await res.json()).error ?? 'Failed to create season'; }
				const seasonsRes = await fetch('/api/league/seasons');
				if (seasonsRes.ok) seasonsList = (await seasonsRes.json()).sort((a: { id: number }, b: { id: number }) => a.id - b.id);
				await loadSeason();
			} catch (e) {
				error = e instanceof Error ? e.message : 'Network error';
			}
			loading = false;
		}
	}

	async function fullReimport() {
		if (!season?.events.length) return;
		if (!confirm('Force re-import all events from StartGG? This re-fetches ALL match data (ignoring cache) and may take a few minutes.')) return;
		await runImportWithSlugs(getAllSeasonSlugs(), true);
	}

	async function initialImport() {
		showCreateSeason = true;
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
		if (!confirm(`Merge "${mergePlayer2.tag}" into "${mergePlayer1.tag}"? This applies across all seasons and will re-import the current season.`)) return;

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
		const sid = getSeasonId();
		importing = true;
		importLogs = [];
		error = '';
		try {
			const res = await fetch('/api/league/event', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ seasonId: sid, eventSlug: slug })
			});
			const data = await res.json();
			if (res.ok) {
				importLogs = data.logs ?? [];
				const [refreshRes] = await Promise.all([
					fetch(`/api/league/season/${sid}`),
					fetchAwards(awardsMinEvents || undefined)
				]);
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
			<div class="mt-1 flex items-center gap-2">
				{#if seasonsList.length > 1}
					<select bind:value={currentSeasonId}
						onchange={() => { loading = true; loadSeason().then(() => { loading = false; }); }}
						class="rounded-lg border border-input bg-secondary px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none">
						{#each seasonsList as s}
							<option value={s.id}>{s.name}</option>
						{/each}
					</select>
				{:else}
					<span class="text-muted-foreground">Season {currentSeasonId}</span>
				{/if}
				<span class="text-muted-foreground">— TrueSkill Rankings</span>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<button onclick={() => showCreateSeason = !showCreateSeason}
				class="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
				+ New Season
			</button>
			<a href="/league?season={currentSeasonId}" target="_blank"
				class="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
				Public View ↗
			</a>
		</div>
	</div>

	{#if showCreateSeason}
		<div class="rounded-xl border border-border bg-card p-5 mb-6">
			<h2 class="text-sm font-bold text-foreground mb-3">Create New Season</h2>
			<div class="flex flex-col sm:flex-row gap-3 items-start sm:items-end flex-wrap">
				<div>
					<label class="text-xs text-muted-foreground">Season #</label>
					<input bind:value={newSeasonId} type="number" placeholder="9" min="1"
						class="mt-1 w-20 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
				</div>
				<div>
					<label class="text-xs text-muted-foreground">First Micro #</label>
					<input bind:value={newSeasonStart} type="number" placeholder="112"
						class="mt-1 w-24 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
				</div>
				<div>
					<label class="text-xs text-muted-foreground">Up to Micro # (excl.)</label>
					<input bind:value={newSeasonEnd} type="number" placeholder="126"
						class="mt-1 w-24 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none" />
				</div>
				<div>
					<label class="text-xs text-muted-foreground">Macros (optional)</label>
					<input bind:value={newSeasonMacros} type="text" placeholder="e.g. 6"
						class="mt-1 w-28 rounded-lg border border-input bg-secondary px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none" />
				</div>
				<button onclick={createSeason} disabled={importing || loading}
					class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
					{importing ? 'Importing...' : newSeasonPlanOnly ? 'Create Season' : 'Create & Import'}
				</button>
			</div>
			<div class="mt-2 flex items-center gap-4">
				<label class="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
					<input type="checkbox" bind:checked={newSeasonPlanOnly}
						class="rounded border-input" />
					Plan only (don't import yet)
				</label>
			</div>
			<p class="mt-1 text-xs text-muted-foreground">
				{newSeasonPlanOnly
					? 'Events will be saved as planned — import them one at a time later.'
					: 'All events will be imported from StartGG immediately. Leave event numbers blank for an empty season.'}
			</p>
		</div>
	{/if}

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
				<div class="flex items-center gap-3 mb-2">
					<h2 class="text-sm font-semibold text-muted-foreground">Season Awards (not yet public)</h2>
					<div class="flex items-center gap-1.5">
						<label class="text-[10px] text-muted-foreground">Min events:</label>
						<input bind:value={awardsMinEvents} type="number" min="1" max="20"
							placeholder="auto"
							onchange={() => fetchAwards(awardsMinEvents || undefined)}
							class="w-14 rounded border border-input bg-secondary px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none" />
					</div>
				</div>
				<div class="grid gap-3 sm:grid-cols-2 items-start">
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
							{#if award.candidates?.length}
								<div class="mt-2 border-t border-border pt-2">
									<div class="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1">Runners-up</div>
									{#each award.candidates as c}
										<div class="flex justify-between text-[11px] text-muted-foreground">
											<span>{c.playerTag}</span>
											<span>{c.value}</span>
										</div>
									{/each}
								</div>
							{/if}
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

		<!-- Admin Ranking Preview (not public) -->
		<div class="rounded-xl border border-border bg-card p-5 mb-6">
			<div class="flex items-center justify-between mb-3">
				<h2 class="text-sm font-bold text-foreground">Ranking Preview (admin only)</h2>
				<div class="flex items-center gap-2">
					<label class="text-xs text-muted-foreground">Min events:</label>
					<input bind:value={adminMinEvents} type="number" min="1" max="20"
						class="w-14 rounded border border-input bg-secondary px-1.5 py-0.5 text-xs text-foreground focus:border-ring focus:outline-none" />
					<button onclick={fetchAdminPreview}
						class="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
						Preview
					</button>
				</div>
			</div>
			{#if adminPreview.length > 0}
				<div class="max-h-[530px] overflow-y-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-xs text-muted-foreground">
								<th class="px-2 py-1 w-10">#</th>
								<th class="px-2 py-1">Player</th>
								<th class="px-2 py-1 text-right">Points</th>
							</tr>
						</thead>
						<tbody>
							{#each adminPreview as p}
								<tr class="border-t border-border">
									<td class="px-2 py-1 text-muted-foreground font-mono text-xs">{p.rank}</td>
									<td class="px-2 py-1 text-foreground">{p.gamerTag}</td>
									<td class="px-2 py-1 text-right font-mono text-foreground">{p.points}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="mt-2 text-xs text-muted-foreground">{adminPreview.length} players with {adminMinEvents}+ events. This does not affect the public view.</p>
			{:else}
				<p class="text-xs text-muted-foreground">Click Preview to see rankings with custom min events filter.</p>
			{/if}
		</div>

		<div class="mb-6">
			<h2 class="text-sm font-semibold text-muted-foreground mb-2">Events</h2>
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
				{#each (season.plannedSlugs ?? []).filter((s) => !season!.events.some((e) => e.slug === s)) as slug}
					<div class="flex items-center justify-between rounded-lg bg-card/50 border border-dashed border-border px-3 py-2 text-sm">
						<span class="text-muted-foreground">{slug}</span>
						<button onclick={() => importSlug(slug)} disabled={importing}
							class="text-xs text-primary hover:text-primary/80 disabled:opacity-50">Import</button>
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

		<div class="flex gap-2">
			<button onclick={fullReimport} disabled={importing}
				class="rounded-lg border border-warning-border bg-warning-muted px-4 py-2 text-sm font-medium text-warning hover:bg-warning-muted/80 transition-colors disabled:opacity-50">
				{importing ? 'Importing...' : 'Re-import all from StartGG'}
			</button>
			<button onclick={async () => {
				if (!confirm('Clear all cached AI bios for this season? They will regenerate on next profile view.')) return;
				await fetch(`/api/league/bio?season=${getSeasonId()}`, { method: 'DELETE' });
			}}
				class="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
				Clear bios
			</button>
		</div>
	{:else}
		<div class="rounded-xl border border-dashed border-border p-8 text-center">
			<p class="text-muted-foreground mb-4">No league data for this season. Create a new season or switch to an existing one.</p>
			<button onclick={() => showCreateSeason = true}
				class="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
				Create Season
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
