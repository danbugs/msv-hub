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

	// ── State ──
	let loading = $state(false);
	let error = $state('');
	let liveLogs = $state<string[]>([]);
	let currentStep = $state(1);
	let startingSwiss = $state(false);
	let numStations = $state('16');
	let streamStation = $state('16');
	let eventUrl = $state('');
	let loadingEvent = $state(false);

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
		const tourneyRes = await fetch('/api/tournament');
		if (tourneyRes.ok) {
			const t = await tourneyRes.json();
			if (t?.startggEventSlug) { eventUrl = t.startggEventSlug; return; }
		}
		const cfgRes = await fetch('/api/discord/config');
		if (cfgRes.ok) {
			const cfg = await cfgRes.json();
			if (cfg?.eventSlug) eventUrl = cfg.eventSlug;
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
					seed: seed || undefined, apply: false
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
		const half = Math.floor(n / 2);
		const pairings = [];
		for (let i = 0; i < half; i++) {
			pairings.push({
				top: { seedNum: entrants[i].seedNum, gamerTag: entrants[i].gamerTag, playerId: entrants[i].playerId },
				bottom: { seedNum: entrants[i + half].seedNum, gamerTag: entrants[i + half].gamerTag, playerId: entrants[i + half].playerId }
			});
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

	async function startFromEvent() {
		if (!eventUrl.trim()) return;
		loadingEvent = true; error = '';
		const res = await fetch('/api/tournament/from-event', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ eventSlug: eventUrl.trim(), numStations: Number(numStations), streamStation: Number(streamStation) })
		});
		loadingEvent = false;
		if (!res.ok) { const data = await res.json(); error = data.error ?? 'Failed'; }
		else goto('/dashboard/tournament/swiss');
	}

	async function startSwiss() {
		if (!result) return;
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
				numStations: Number(numStations), streamStation: Number(streamStation)
			})
		});
		startingSwiss = false;
		if (!res.ok) { const data = await res.json(); error = data.error ?? 'Failed'; }
		else goto('/dashboard/tournament/swiss');
	}

	const inputClass = 'mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500';
</script>

<main class="mx-auto max-w-4xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Seed Event</h1>
	<p class="mt-1 text-gray-400">Generate Elo-based seedings for Swiss pairings.</p>

	{#if error}
		<div class="mt-4 flex items-start gap-2 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-400">
			<span class="flex-1">{error}</span>
			<button onclick={() => error = ''} class="shrink-0 text-red-400 hover:text-white">✕</button>
		</div>
	{/if}

	<div class="mt-8 space-y-0">

	<!-- ═══ Step 1: Generate Seeding ═══ -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border
				{currentStep >= 1 ? 'border-violet-700 bg-violet-900/40 text-violet-300' : 'border-gray-700 bg-gray-900 text-gray-500'}
				text-xs font-bold">1</div>
			<div class="mt-1 w-px flex-1 bg-gray-800"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Generate Seeding</p>

			<form onsubmit={(e) => { e.preventDefault(); runSeeder(); }} class="space-y-4">
				<div>
					<label for="target" class="block text-sm font-medium text-gray-300">Event number</label>
					<input id="target" type="number"
						value={targetNumber}
						oninput={(e) => onTargetChange((e.target as HTMLInputElement).value)}
						required placeholder="e.g. 134" class="mt-1 w-48 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none" />
					<p class="mt-1 text-xs text-gray-500">Uses the previous 10 events for Elo history.</p>
				</div>

				<button type="button" onclick={() => showAdvanced = !showAdvanced}
					class="text-sm text-gray-400 hover:text-violet-400 transition-colors">
					{showAdvanced ? '▾' : '▸'} Advanced
				</button>

				{#if showAdvanced}
					<div class="grid gap-4 sm:grid-cols-2 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
						<div>
							<label for="mode" class="block text-sm font-medium text-gray-300">Mode</label>
							<select id="mode" bind:value={mode} class={inputClass}>
								<option value="micro">Micro</option>
								<option value="macro">Macro</option>
							</select>
						</div>
						<div>
							<label for="season-start" class="block text-sm font-medium text-gray-300">Season Start</label>
							<p class="text-xs text-gray-500 mb-1">First event # for Elo. Default: target - 10.</p>
							<input id="season-start" type="number" bind:value={seasonStart} placeholder="auto" class={inputClass} />
						</div>
						<div>
							<label for="jitter" class="block text-sm font-medium text-gray-300">Jitter (default 5)</label>
							<p class="text-xs text-gray-500 mb-1">Max Elo noise. Lower = more stable seeds.</p>
							<input id="jitter" type="number" step="0.1" bind:value={jitter} class={inputClass} />
						</div>
						<div>
							<label for="micro-end" class="block text-sm font-medium text-gray-300">Micro End</label>
							<input id="micro-end" type="number" bind:value={microEnd} placeholder="auto" class={inputClass} />
						</div>
						<div>
							<label for="rng-seed" class="block text-sm font-medium text-gray-300">RNG Seed</label>
							<input id="rng-seed" type="number" bind:value={seed} placeholder="random" class={inputClass} />
						</div>
						<div>
							<label for="macros" class="block text-sm font-medium text-gray-300">Macros to include</label>
							<input id="macros" type="text" bind:value={macros} placeholder="e.g. 6,7" class={inputClass} />
						</div>
						{#if mode === 'macro'}
						<div>
							<label for="avoid" class="block text-sm font-medium text-gray-300">Avoid Events</label>
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
							class="rounded-lg bg-violet-600 px-6 py-2 font-medium text-white hover:bg-violet-500 disabled:opacity-50">
							Generate Seeding
						</button>
					{/if}
				</div>
			</form>

			{#if loading && liveLogs.length > 0}
				<div class="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
					<div class="flex items-center gap-2 mb-2">
						<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>
						<span class="text-sm font-medium text-gray-300">Progress</span>
					</div>
					<div class="max-h-32 overflow-y-auto">
						{#each liveLogs as msg}
							<div class="text-xs text-gray-400 font-mono py-0.5">{msg}</div>
						{/each}
					</div>
				</div>
			{:else if loading}
				<div class="mt-4 flex items-center gap-2 text-gray-400">
					<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>Starting...
				</div>
			{/if}
		</div>
	</div>

	<!-- ═══ Step 2: Review & Reorder ═══ -->
	{#if result}
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">2</div>
			<div class="mt-1 w-px flex-1 bg-gray-800"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Review & Reorder</p>
			<p class="mb-3 text-xs text-gray-500">Drag rows to reorder seeds. Rematches from last week are highlighted in red.</p>

			<div class="grid gap-6 lg:grid-cols-2">
				<!-- Seeding table with drag -->
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">Seeding — {result.entrants.length} players</h3>
					<div class="max-h-[28rem] overflow-y-auto rounded-lg border border-gray-800">
						<table class="w-full text-sm">
							<thead class="sticky top-0 bg-gray-900 z-10">
								<tr class="border-b border-gray-700 text-left text-gray-400">
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
										class="border-b border-gray-800 cursor-grab active:cursor-grabbing transition-colors
											{dragOverIdx === i ? 'bg-violet-900/30 border-violet-600' : 'hover:bg-gray-800/50'}
											{dragIdx === i ? 'opacity-40' : ''}">
										<td class="px-2 py-1.5 text-right font-mono text-gray-400">{e.seedNum}</td>
										<td class="px-2 py-1.5 text-white">
											{e.gamerTag}
											{#if e.isNewcomer}<span class="ml-1 text-xs text-yellow-400">*</span>{/if}
										</td>
										<td class="px-2 py-1.5 text-right font-mono text-gray-400">{e.elo.toFixed(0)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="mt-1 text-xs text-gray-600">* = newcomer (Elo estimated from external results)</p>
				</div>

				<!-- R1 Pairings -->
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">R1 Pairings</h3>
					<div class="space-y-1 max-h-[28rem] overflow-y-auto">
						{#each result.pairings as { top, bottom }}
							<div class="flex items-center gap-2 rounded px-3 py-1.5 text-sm
								{isCollision(top.playerId, bottom.playerId) ? 'bg-red-900/30 border border-red-800' : 'bg-gray-900'}">
								<span class="w-6 text-right font-mono text-xs text-gray-500">{top.seedNum}</span>
								<span class="flex-1 text-white truncate">{top.gamerTag}</span>
								<span class="text-gray-600 text-xs">vs</span>
								<span class="flex-1 text-right text-white truncate">{bottom.gamerTag}</span>
								<span class="w-6 font-mono text-xs text-gray-500">{bottom.seedNum}</span>
								{#if isCollision(top.playerId, bottom.playerId)}
									<span class="text-xs text-red-400" title="Rematch from last week">⚠</span>
								{/if}
							</div>
						{/each}
						{#if result.entrants.length % 2 === 1}
							{@const bye = result.entrants[result.entrants.length - 1]}
							<div class="flex items-center gap-2 rounded bg-gray-900 px-3 py-1.5 text-sm">
								<span class="w-6 text-right font-mono text-xs text-gray-500">{bye.seedNum}</span>
								<span class="text-white">{bye.gamerTag}</span>
								<span class="text-yellow-500 text-xs ml-auto">BYE</span>
							</div>
						{/if}
					</div>
					{#if collisionCount > 0}
						<div class="mt-3 rounded-lg border border-yellow-700 bg-yellow-900/20 p-3 text-xs text-yellow-400">
							⚠ {collisionCount} rematch{collisionCount > 1 ? 'es' : ''} from last week — drag seeds to resolve
						</div>
					{/if}
				</div>
			</div>

			<details class="mt-3 rounded-lg border border-gray-800 bg-gray-900">
				<summary class="cursor-pointer px-4 py-2 text-xs text-gray-500">Full Log ({result.logs.length})</summary>
				<pre class="max-h-48 overflow-y-auto px-4 py-2 text-xs text-gray-600">{result.logs.join('\n')}</pre>
			</details>
		</div>
	</div>

	<!-- ═══ Step 3: Apply & Start Swiss ═══ -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border
				{currentStep >= 3 ? 'border-violet-700 bg-violet-900/40 text-violet-300' : 'border-gray-700 bg-gray-900 text-gray-500'}
				text-xs font-bold">3</div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Apply & Start Swiss</p>
			<p class="mb-3 text-xs text-gray-500">Creates the tournament from the seeding above. Seeding will be applied to StartGG automatically.</p>

			<div class="flex items-end gap-3 flex-wrap">
				<div>
					<label for="num-stations" class="block text-xs text-gray-400">Stations</label>
					<input id="num-stations" type="number" bind:value={numStations} min="1"
						class="mt-1 w-24 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white focus:border-violet-500 focus:outline-none" />
				</div>
				<div>
					<label for="stream-stn" class="block text-xs text-gray-400">Stream station #</label>
					<input id="stream-stn" type="number" bind:value={streamStation} min="1"
						class="mt-1 w-24 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white focus:border-violet-500 focus:outline-none" />
				</div>
				<button onclick={startSwiss} disabled={startingSwiss || !numStations}
					class="rounded-lg bg-violet-600 px-5 py-2 font-medium text-white hover:bg-violet-500 disabled:opacity-50">
					{startingSwiss ? 'Creating...' : 'Apply & Start Swiss →'}
				</button>
			</div>
		</div>
	</div>
	{/if}

	<!-- ═══ Tools: Quick Start ═══ -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">∞</div>
		</div>
		<div class="pb-2 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Quick Start</p>
			<div class="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
				<p class="text-sm font-medium text-gray-300">Start from existing seeded event</p>
				<p class="mt-0.5 text-xs text-gray-500">Skip Elo seeding — use the current StartGG seedings directly.</p>
				<div class="mt-3 flex flex-wrap items-end gap-3">
					<div class="flex-1 min-w-48">
						<label for="event-url" class="block text-xs text-gray-400">StartGG event URL</label>
						<input id="event-url" type="text" bind:value={eventUrl}
							placeholder="tournament/micro-134/event/singles" class={inputClass} />
					</div>
					<div>
						<label for="fe-stations" class="block text-xs text-gray-400">Stations</label>
						<input id="fe-stations" type="number" bind:value={numStations} min="1"
							class="mt-1 w-20 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white focus:border-violet-500 focus:outline-none" />
					</div>
					<div>
						<label for="fe-stream" class="block text-xs text-gray-400">Stream</label>
						<input id="fe-stream" type="number" bind:value={streamStation} min="1"
							class="mt-1 w-20 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white focus:border-violet-500 focus:outline-none" />
					</div>
					<button onclick={startFromEvent} disabled={loadingEvent || !eventUrl.trim()}
						class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
						{loadingEvent ? 'Loading…' : 'Start Swiss →'}
					</button>
				</div>
			</div>
		</div>
	</div>

	</div>
</main>
