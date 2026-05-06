<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';

	// ── Config ──
	let mode = $state<'micro' | 'macro'>('micro');
	let targetNumber = $state('');
	let seasonStart = $state('');
	let microEnd = $state('');
	let macros = $state('');
	let avoidEvents = $state('');
	let jitter = $state('5');
	let seed = $state('');
	let showAdvanced = $state(false);
	let leagueSeasons = $state<{ id: number; name: string }[]>([]);
	let leagueSeasonId = $state('');

	// ── State ──
	let loading = $state(false);
	let error = $state('');
	let liveLogs = $state<string[]>([]);
	let currentStep = $state(1);
	let startingSwiss = $state(false);
	let numStations = $state('16');
	let swissRounds = $state('');  // empty = auto (calculated from player count + stations)
	let eventUrl = $state('');
	let loadingEvent = $state(false);
	let tournamentMode = $state<'default' | 'gauntlet' | 'experimental1'>('default');
	let showModeInfo = $state(false);

	// Drag state
	let dragIdx = $state<number | null>(null);
	let dragOverIdx = $state<number | null>(null);

	let abortController: AbortController | null = null;
	let result = $state<{
		entrants: { seedNum: number; gamerTag: string; elo: number; jitteredElo: number; isNewcomer: boolean; playerId?: number }[];
		pairings: { top: { seedNum: number; gamerTag: string; playerId?: number }; bottom: { seedNum: number; gamerTag: string; playerId?: number } }[];
		unresolvedCollisions: { top: { gamerTag: string }; bottom: { gamerTag: string } }[];
		avoidPairs: string[];
		targetSlug: string;
		logs: string[];
	} | null>(null);

	onMount(async () => {
		const [tourneyRes, seasonsRes] = await Promise.all([
			fetch('/api/tournament'),
			fetch('/api/league/seasons')
		]);
		if (tourneyRes.ok) {
			const t = await tourneyRes.json();
			if (t?.startggEventSlug) { eventUrl = t.startggEventSlug; }
		}
		if (!eventUrl) {
			const cfgRes = await fetch('/api/discord/config');
			if (cfgRes.ok) {
				const cfg = await cfgRes.json();
				if (cfg?.eventSlug) eventUrl = cfg.eventSlug;
			}
		}
		if (seasonsRes.ok) {
			const seasons = await seasonsRes.json();
			leagueSeasons = seasons;
			if (seasons.length) leagueSeasonId = String(seasons[seasons.length - 1].id);
		}
	});

	// Auto-compute seasonStart when targetNumber changes (last 10 events)
	function onTargetChange(val: string) {
		targetNumber = val;
		if (!showAdvanced && val) {
			const n = Number(val);
			if (n > 10) seasonStart = String(n - 10);
		}
	}

	function cancelSeeder() { abortController?.abort(); abortController = null; loading = false; }
	onDestroy(() => abortController?.abort());

	async function runSeeder() {
		loading = true; error = ''; result = null; liveLogs = [];
		// Auto-set seasonStart if not manually set
		if (!seasonStart && targetNumber) {
			const n = Number(targetNumber);
			seasonStart = String(n > 10 ? n - 10 : 1);
		}
		abortController = new AbortController();
		const signal = abortController.signal;
		let res: Response;
		try {
			res = await fetch('/api/seeder', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode, targetNumber, seasonStart,
					microEnd: microEnd || undefined, macros: macros || undefined,
					avoidEvents: avoidEvents || undefined, jitter: jitter || 5,
					seed: seed || undefined, apply: false,
					leagueSeasonId: leagueSeasonId || undefined
				}),
				signal
			});
		} catch (err) {
			if (signal.aborted) return;
			loading = false; error = err instanceof Error ? err.message : 'Network error'; return;
		}
		if (!res.ok || !res.body) {
			loading = false;
			try { const body = await res.json(); error = body.error ?? 'Something went wrong'; }
			catch { error = `HTTP ${res.status}`; }
			return;
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) eventType = line.slice(7);
					else if (line.startsWith('data: ')) {
						const data = JSON.parse(line.slice(6));
						if (eventType === 'log') liveLogs = [...liveLogs, data.message];
						else if (eventType === 'result') result = data;
						else if (eventType === 'error') error = data.error;
					}
				}
			}
		} catch (err) { if (signal.aborted) return; throw err; }
		loading = false; abortController = null;
		if (result) currentStep = 2;
	}

	// ── Drag & drop reorder ──
	function onDragStart(idx: number) { dragIdx = idx; }
	function onDragOver(idx: number, e: DragEvent) { e.preventDefault(); dragOverIdx = idx; }
	function onDragLeave() { dragOverIdx = null; }
	function onDrop(targetIdx: number) {
		if (dragIdx === null || dragIdx === targetIdx || !result) { dragIdx = null; dragOverIdx = null; return; }
		const e = [...result.entrants];
		const [moved] = e.splice(dragIdx, 1);
		e.splice(targetIdx, 0, moved);
		e.forEach((ent, i) => ent.seedNum = i + 1);
		result = { ...result, entrants: e, pairings: computePairings(e) };
		dragIdx = null; dragOverIdx = null;
	}
	function onDragEnd() { dragIdx = null; dragOverIdx = null; }

	function computePairings(entrants: NonNullable<typeof result>['entrants']) {
		const n = entrants.length;
		const pairings = [];
		if (n % 2 === 1) {
			const half = (n + 1) / 2;
			for (let i = 0; i < half - 1; i++) {
				pairings.push({
					top: { seedNum: entrants[i].seedNum, gamerTag: entrants[i].gamerTag, playerId: entrants[i].playerId },
					bottom: { seedNum: entrants[i + half].seedNum, gamerTag: entrants[i + half].gamerTag, playerId: entrants[i + half].playerId }
				});
			}
		} else {
			const half = n / 2;
			for (let i = 0; i < half; i++) {
				pairings.push({
					top: { seedNum: entrants[i].seedNum, gamerTag: entrants[i].gamerTag, playerId: entrants[i].playerId },
					bottom: { seedNum: entrants[i + half].seedNum, gamerTag: entrants[i + half].gamerTag, playerId: entrants[i + half].playerId }
				});
			}
		}
		return pairings;
	}

	/** Check if a pairing is a rematch from last week using the full avoidance set */
	function isCollision(topPlayerId: number | undefined, bottomPlayerId: number | undefined): boolean {
		if (!result?.avoidPairs?.length || !topPlayerId || !bottomPlayerId) return false;
		const k1 = `${Math.min(topPlayerId, bottomPlayerId)}:${Math.max(topPlayerId, bottomPlayerId)}`;
		return result.avoidPairs.includes(k1);
	}

	/** Count current collisions in pairings */
	let collisionCount = $derived.by(() => {
		if (!result) return 0;
		return result.pairings.filter((p) => isCollision(p.top.playerId, p.bottom.playerId)).length;
	});

	let syncStatus = $state('');

	async function runInitialSync(eventSlug?: string) {
		syncStatus = 'Syncing players to StartGG...';
		const body: Record<string, string> = {};
		if (eventSlug) body.eventSlug = eventSlug;
		const syncRes = await fetch('/api/tournament/startgg-initial-sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const syncData = await syncRes.json().catch(() => ({}));
		if (!syncRes.ok) {
			syncStatus = '';
			error = `StartGG sync: ${(syncData as { error?: string }).error ?? 'failed'}`;
			return false;
		}
		const { moved, cleaned, failed: syncFailed, seedingResult } = syncData as { moved: number; cleaned: number; failed: number; seedingResult?: string };
		syncStatus = `Synced ${moved} players${cleaned ? ` (${cleaned} moved)` : ''}${syncFailed ? `, ${syncFailed} failed` : ''}`;
		if (seedingResult && seedingResult.includes('failed')) {
			error = `StartGG seeding: ${seedingResult}`;
		}
		return true;
	}

	async function startFromEvent() {
		if (!eventUrl.trim()) return;
		if (tournamentMode !== 'gauntlet' && swissRounds !== '' && (Number(swissRounds) < 1 || Number(swissRounds) > 5)) { error = 'Swiss rounds must be between 1 and 5'; return; }
		loadingEvent = true; error = '';
		const res = await fetch('/api/tournament/from-event', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				eventSlug: eventUrl.trim(), numStations: Number(numStations), streamStation: 16,
				numRounds: tournamentMode !== 'gauntlet' && swissRounds ? Number(swissRounds) : undefined,
				mode: tournamentMode
			})
		});
		if (!res.ok) { loadingEvent = false; const data = await res.json(); error = data.error ?? 'Failed'; return; }

		const ok = await runInitialSync();
		loadingEvent = false;
		if (ok) goto(tournamentMode === 'gauntlet' ? '/dashboard/tournament/brackets' : '/dashboard/tournament/swiss');
	}

	async function startSwiss() {
		if (!result) return;
		if (tournamentMode !== 'gauntlet' && swissRounds !== '' && (Number(swissRounds) < 1 || Number(swissRounds) > 5)) { error = 'Swiss rounds must be between 1 and 5'; return; }
		startingSwiss = true; error = '';

		// Step 1: Apply seeding to StartGG
		const applyRes = await fetch('/api/seeder/apply', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ targetSlug: result.targetSlug, entrants: result.entrants })
		});
		if (!applyRes.ok) {
			const data = await applyRes.json();
			error = `Failed to apply seeding: ${data.error ?? 'Unknown error'}`;
			startingSwiss = false;
			return;
		}

		// Step 2: Create the tournament
		const slug = result.targetSlug.replace(/\//g, '-');
		const name = result.targetSlug.split('/').pop() ?? slug;
		const res = await fetch('/api/tournament', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name, slug,
				entrants: result.entrants.map((e) => ({ gamerTag: e.gamerTag, initialSeed: e.seedNum })),
				numStations: Number(numStations), streamStation: 16,
				numRounds: tournamentMode !== 'gauntlet' && swissRounds ? Number(swissRounds) : undefined,
				mode: tournamentMode
			})
		});
		if (!res.ok) { startingSwiss = false; const data = await res.json(); error = data.error ?? 'Failed'; return; }

		// Step 3: Sync players on StartGG
		const ok = await runInitialSync(result.targetSlug);
		startingSwiss = false;
		if (ok) goto(tournamentMode === 'gauntlet' ? '/dashboard/tournament/brackets' : '/dashboard/tournament/swiss');
	}

	const inputClass = 'mt-1 block w-full rounded-lg border border-input bg-secondary px-3 py-2 text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring';
</script>

<main class="mx-auto max-w-4xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-primary hover:text-primary/80">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-foreground">Seed Event</h1>
	<p class="mt-1 text-muted-foreground">Generate seedings for Swiss pairings from league rankings or Elo history.</p>

	{#if error}
		<div class="mt-4 flex items-start gap-2 rounded-lg border border-destructive-border bg-destructive-muted px-4 py-3 text-sm text-destructive">
			<span class="flex-1">{error}</span>
			<button onclick={() => error = ''} class="shrink-0 text-destructive hover:text-foreground">✕</button>
		</div>
	{/if}

	<div class="mt-8 space-y-0">

	<!-- ═══ Step 1: Generate Seeding ═══ -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border
				{currentStep >= 1 ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}
				text-xs font-bold">1</div>
			<div class="mt-1 w-px flex-1 bg-secondary"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Generate Seeding</p>

			<form onsubmit={(e) => { e.preventDefault(); runSeeder(); }} class="space-y-4">
				<div>
					<label for="target" class="block text-sm font-medium text-foreground">Event number</label>
					<input id="target" type="number"
						value={targetNumber}
						oninput={(e) => onTargetChange((e.target as HTMLInputElement).value)}
						required placeholder="e.g. 134" class="mt-1 w-48 rounded-lg border border-input bg-secondary px-3 py-2 text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none" />
				</div>

				{#if leagueSeasons.length}
					<div>
						<label for="league-season" class="block text-sm font-medium text-foreground">Rating source</label>
						<select id="league-season" bind:value={leagueSeasonId} class="mt-1 w-64 rounded-lg border border-input bg-secondary px-3 py-2 text-foreground focus:border-ring focus:outline-none">
							<option value="">Elo (compute from history)</option>
							{#each leagueSeasons as s}
								<option value={String(s.id)}>{s.name} (TrueSkill)</option>
							{/each}
						</select>
						<p class="mt-1 text-xs text-muted-foreground">
							{leagueSeasonId ? 'Uses league rankings for known players, estimates newcomers from StartGG history.' : 'Computes Elo from the previous 10 events.'}
						</p>
					</div>
				{/if}

				<button type="button" onclick={() => showAdvanced = !showAdvanced}
					class="text-sm text-muted-foreground hover:text-primary transition-colors">
					{showAdvanced ? '▾' : '▸'} Advanced
				</button>

				{#if showAdvanced}
					<div class="grid gap-4 sm:grid-cols-2 rounded-lg border border-border bg-card/50 p-4">
						<div>
							<label for="mode" class="block text-sm font-medium text-foreground">Mode</label>
							<select id="mode" bind:value={mode} class={inputClass}>
								<option value="micro">Micro</option>
								<option value="macro">Macro</option>
							</select>
						</div>
						<div>
							<label for="season-start" class="block text-sm font-medium text-foreground">Season Start</label>
							<p class="text-xs text-muted-foreground mb-1">First event # for Elo. Default: target - 10.</p>
							<input id="season-start" type="number" bind:value={seasonStart} placeholder="auto" class={inputClass} />
						</div>
						<div>
							<label for="jitter" class="block text-sm font-medium text-foreground">Jitter (default 5)</label>
							<p class="text-xs text-muted-foreground mb-1">Max Elo noise. Lower = more stable seeds.</p>
							<input id="jitter" type="number" step="0.1" bind:value={jitter} class={inputClass} />
						</div>
						<div>
							<label for="micro-end" class="block text-sm font-medium text-foreground">Micro End</label>
							<input id="micro-end" type="number" bind:value={microEnd} placeholder="auto" class={inputClass} />
						</div>
						<div>
							<label for="rng-seed" class="block text-sm font-medium text-foreground">RNG Seed</label>
							<input id="rng-seed" type="number" bind:value={seed} placeholder="random" class={inputClass} />
						</div>
						<div>
							<label for="macros" class="block text-sm font-medium text-foreground">Macros to include</label>
							<input id="macros" type="text" bind:value={macros} placeholder="e.g. 6,7" class={inputClass} />
						</div>
						{#if mode === 'macro'}
						<div>
							<label for="avoid" class="block text-sm font-medium text-foreground">Avoid Events</label>
							<input id="avoid" type="text" bind:value={avoidEvents} placeholder="tournament/slug" class={inputClass} />
						</div>
						{/if}
					</div>
				{/if}

				<div class="flex items-center gap-4">
					{#if loading}
						<button type="button" onclick={cancelSeeder}
							class="rounded-lg bg-red-600 px-6 py-2 font-medium text-white hover:bg-red-500">Cancel</button>
					{:else}
						<button type="submit" disabled={!targetNumber}
							class="rounded-lg bg-primary px-6 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
							Generate Seeding
						</button>
					{/if}
				</div>
			</form>

			{#if loading && liveLogs.length > 0}
				<div class="mt-4 rounded-lg border border-border bg-card p-4">
					<div class="flex items-center gap-2 mb-2">
						<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>
						<span class="text-sm font-medium text-foreground">Progress</span>
					</div>
					<div class="max-h-32 overflow-y-auto">
						{#each liveLogs as msg}
							<div class="text-xs text-muted-foreground font-mono py-0.5">{msg}</div>
						{/each}
					</div>
				</div>
			{:else if loading}
				<div class="mt-4 flex items-center gap-2 text-muted-foreground">
					<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>Starting...
				</div>
			{/if}
		</div>
	</div>

	<!-- ═══ Step 2: Review & Reorder ═══ -->
	{#if result}
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary bg-primary/10 text-xs font-bold text-primary">2</div>
			<div class="mt-1 w-px flex-1 bg-secondary"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Review & Reorder</p>
			<p class="mb-3 text-xs text-muted-foreground">Drag rows to reorder seeds. Rematches from last week are highlighted in red.</p>

			<div class="grid gap-6 lg:grid-cols-2">
				<!-- Seeding table with drag -->
				<div>
					<h3 class="text-sm font-medium text-foreground mb-2">Seeding — {result.entrants.length} players</h3>
					<div class="max-h-[28rem] overflow-auto rounded-lg border border-border">
						<table class="w-full text-sm">
							<thead class="sticky top-0 bg-card z-10">
								<tr class="border-b border-border text-left text-muted-foreground">
									<th class="px-2 py-1.5 text-right w-12">Seed</th>
									<th class="px-2 py-1.5">Tag</th>
									<th class="px-2 py-1.5 text-right w-16">Elo</th>
								</tr>
							</thead>
							<tbody>
								{#each result.entrants as e, i}
									<tr
										draggable="true"
										ondragstart={() => onDragStart(i)}
										ondragover={(ev) => onDragOver(i, ev)}
										ondragleave={onDragLeave}
										ondrop={() => onDrop(i)}
										ondragend={onDragEnd}
										class="border-b border-border cursor-grab active:cursor-grabbing transition-colors
											{dragOverIdx === i ? 'bg-violet-900/30 border-violet-600' : 'hover:bg-secondary/50'}
											{dragIdx === i ? 'opacity-40' : ''}">
										<td class="px-2 py-1.5 text-right font-mono text-muted-foreground">{e.seedNum}</td>
										<td class="px-2 py-1.5 text-foreground truncate max-w-[10rem]">
											{e.gamerTag}
											{#if e.isNewcomer}<span class="ml-1 text-xs text-warning">*</span>{/if}
										</td>
										<td class="px-2 py-1.5 text-right font-mono text-muted-foreground">{e.elo.toFixed(0)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="mt-1 text-xs text-muted-foreground">* = newcomer (Elo estimated from external results)</p>
				</div>

				<!-- R1 Pairings -->
				<div>
					<h3 class="text-sm font-medium text-foreground mb-2">R1 Pairings</h3>
					<div class="space-y-1 max-h-[28rem] overflow-y-auto">
						{#each result.pairings as { top, bottom }}
							<div class="flex items-center gap-2 rounded px-3 py-1.5 text-sm
								{isCollision(top.playerId, bottom.playerId) ? 'bg-destructive-muted border border-destructive-border' : 'bg-card'}">
								<span class="w-6 text-right font-mono text-xs text-muted-foreground">{top.seedNum}</span>
								<span class="flex-1 text-foreground truncate">{top.gamerTag}</span>
								<span class="text-muted-foreground text-xs">vs</span>
								<span class="flex-1 text-right text-foreground truncate">{bottom.gamerTag}</span>
								<span class="w-6 font-mono text-xs text-muted-foreground">{bottom.seedNum}</span>
								{#if isCollision(top.playerId, bottom.playerId)}
									<span class="text-xs text-destructive" title="Rematch from last week">⚠</span>
								{/if}
							</div>
						{/each}
						{#if result.entrants.length % 2 === 1}
							{@const bye = result.entrants[Math.floor(result.entrants.length / 2)]}
							<div class="flex items-center gap-2 rounded bg-card px-3 py-1.5 text-sm">
								<span class="w-6 text-right font-mono text-xs text-muted-foreground">{bye.seedNum}</span>
								<span class="text-foreground">{bye.gamerTag}</span>
								<span class="text-warning text-xs ml-auto">BYE</span>
							</div>
						{/if}
					</div>
					{#if collisionCount > 0}
						<div class="mt-3 rounded-lg border border-warning-border bg-warning-muted p-3 text-xs text-warning">
							⚠ {collisionCount} rematch{collisionCount > 1 ? 'es' : ''} from last week — drag seeds to resolve
						</div>
					{/if}
				</div>
			</div>

			<details class="mt-3 rounded-lg border border-border bg-card">
				<summary class="cursor-pointer px-4 py-2 text-xs text-muted-foreground">Full Log ({result.logs.length})</summary>
				<pre class="max-h-48 overflow-y-auto px-4 py-2 text-xs text-muted-foreground whitespace-pre-wrap">{result.logs.join('\n')}</pre>
			</details>
		</div>
	</div>

	<!-- ═══ Step 3: Apply & Start ═══ -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border
				{currentStep >= 3 ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}
				text-xs font-bold">3</div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Apply & Start</p>
			<p class="mb-3 text-xs text-muted-foreground">Creates the tournament from the seeding above. Seeding will be applied to StartGG automatically.</p>

			<!-- Mode selector -->
			<div class="mb-4">
				<div class="flex items-center gap-2 mb-1.5">
					<span class="text-xs text-muted-foreground">Format</span>
					<button type="button" onclick={() => showModeInfo = !showModeInfo}
						class="text-muted-foreground hover:text-foreground transition-colors" title="What are these modes?">
						<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"/><path stroke-width="2" d="M12 16v-4m0-4h.01"/></svg>
					</button>
				</div>
				{#if showModeInfo}
					<div class="mb-3 rounded-lg border border-border bg-card/50 p-3 text-xs text-muted-foreground space-y-2">
						<p><strong class="text-foreground">Micro Default</strong> — Swiss rounds to seed players, then split into Main + Redemption brackets based on record.</p>
						<p><strong class="text-foreground">Macro Default</strong> — All players enter one Main bracket (DE). Players eliminated early with 0-2 or 1-2 records are placed into a Redemption bracket once all early losers are known. Redemption is seeded by bracket performance + initial seed with rematch avoidance.</p>
						<p><strong class="text-foreground">Experimental #1</strong> — 3 Swiss rounds seed all players into one Main bracket (DE). Losers with 0-2 or 1-2 bracket records go to Redemption (like Macro Default). Combines Swiss seeding quality with single-bracket play.</p>
					</div>
				{/if}
				<div class="flex gap-2 flex-wrap">
					<button type="button" onclick={() => tournamentMode = 'default'}
						class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors {tournamentMode === 'default' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
						Micro Default
					</button>
					<button type="button" onclick={() => tournamentMode = 'gauntlet'}
						class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors {tournamentMode === 'gauntlet' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
						Macro Default
					</button>
					<button type="button" onclick={() => tournamentMode = 'experimental1'}
						class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors {tournamentMode === 'experimental1' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
						Experimental #1
					</button>
				</div>
			</div>

			<div class="flex items-end gap-3 flex-wrap">
				<div>
					<label for="num-stations" class="block text-xs text-muted-foreground">Stations</label>
					<input id="num-stations" type="number" bind:value={numStations} min="1"
						class="mt-1 w-24 rounded-lg border border-input bg-secondary px-3 py-2 text-foreground focus:border-ring focus:outline-none" />
				</div>
				{#if tournamentMode !== 'gauntlet'}
					<div>
						<label for="swiss-rounds" class="block text-xs text-muted-foreground">Swiss rounds</label>
						<input id="swiss-rounds" type="number" bind:value={swissRounds} min="1" max="5"
							placeholder="auto"
							class="mt-1 w-24 rounded-lg border border-input bg-secondary px-3 py-2 text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none" />
					</div>
				{/if}
				<button onclick={startSwiss} disabled={startingSwiss || !numStations}
					class="rounded-lg bg-primary px-5 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
					{startingSwiss ? (syncStatus || 'Creating...') : tournamentMode === 'gauntlet' ? 'Apply & Start Macro Default →' : tournamentMode === 'experimental1' ? 'Apply & Start Experimental #1 →' : 'Apply & Start Swiss →'}
				</button>
			</div>
		</div>
	</div>
	{/if}

	<!-- ═══ Tools: Quick Start ═══ -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-bold text-muted-foreground">∞</div>
		</div>
		<div class="pb-2 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quick Start</p>
			<div class="rounded-lg border border-border bg-card/50 p-4">
				<p class="text-sm font-medium text-foreground">Start from StartGG tournament</p>
				<p class="mt-0.5 text-xs text-muted-foreground">Skip Elo seeding — auto-discovers the right event and uses its seedings directly.</p>

				<!-- Mode selector (same state as Step 3) -->
				<div class="mt-3 mb-3">
					<div class="flex items-center gap-2 mb-1.5">
						<span class="text-xs text-muted-foreground">Format</span>
						<button type="button" onclick={() => showModeInfo = !showModeInfo}
							class="text-muted-foreground hover:text-foreground transition-colors" title="What are these modes?">
							<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"/><path stroke-width="2" d="M12 16v-4m0-4h.01"/></svg>
						</button>
					</div>
					{#if showModeInfo}
						<div class="mb-3 rounded-lg border border-border bg-card/80 p-3 text-xs text-muted-foreground space-y-2">
							<p><strong class="text-foreground">Micro Default</strong> — Swiss rounds to seed players, then split into Main + Redemption brackets based on record.</p>
							<p><strong class="text-foreground">Macro Default</strong> — All players enter one Main bracket (DE). Players eliminated early with 0-2 or 1-2 records are placed into a Redemption bracket once all early losers are known. Redemption is seeded by bracket performance + initial seed with rematch avoidance.</p>
						</div>
					{/if}
					<div class="flex gap-2 flex-wrap">
						<button type="button" onclick={() => tournamentMode = 'default'}
							class="rounded-lg px-3 py-1 text-xs font-medium transition-colors {tournamentMode === 'default' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
							Micro Default
						</button>
						<button type="button" onclick={() => tournamentMode = 'gauntlet'}
							class="rounded-lg px-3 py-1 text-xs font-medium transition-colors {tournamentMode === 'gauntlet' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
							Macro Default
						</button>
						<button type="button" onclick={() => tournamentMode = 'experimental1'}
							class="rounded-lg px-3 py-1 text-xs font-medium transition-colors {tournamentMode === 'experimental1' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}">
							Experimental #1
						</button>
					</div>
				</div>

				<div class="flex flex-wrap items-end gap-3">
					<div class="flex-1 min-w-48">
						<label for="event-url" class="block text-xs text-muted-foreground">StartGG tournament URL</label>
						<input id="event-url" type="text" bind:value={eventUrl}
							placeholder="start.gg/tournament/micro-134" class={inputClass} />
					</div>
					<div>
						<label for="fe-stations" class="block text-xs text-muted-foreground">Stations</label>
						<input id="fe-stations" type="number" bind:value={numStations} min="1"
							class="mt-1 w-20 rounded-lg border border-input bg-secondary px-3 py-2 text-foreground focus:border-ring focus:outline-none" />
					</div>
					{#if tournamentMode !== 'gauntlet'}
						<div>
							<label for="fe-rounds" class="block text-xs text-muted-foreground">Swiss rounds</label>
							<input id="fe-rounds" type="number" bind:value={swissRounds} min="1" max="5"
								placeholder={tournamentMode === 'experimental1' ? '3' : 'auto'}
								class="mt-1 w-20 rounded-lg border border-input bg-secondary px-3 py-2 text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none" />
						</div>
					{/if}
					<button onclick={startFromEvent} disabled={loadingEvent || !eventUrl.trim()}
						class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
						{loadingEvent ? (syncStatus || 'Loading…') : tournamentMode === 'gauntlet' ? 'Start Macro Default →' : tournamentMode === 'experimental1' ? 'Start Experimental #1 →' : 'Start Swiss →'}
					</button>
				</div>
			</div>
		</div>
	</div>

	</div>
</main>
