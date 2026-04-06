<script lang="ts">
	let mode = $state<'micro' | 'macro'>('micro');
	let targetNumber = $state('');
	let seasonStart = $state('');
	let microEnd = $state('');
	let macros = $state('');
	let avoidEvents = $state('');
	let jitter = $state('20');
	let seed = $state('');
	let apply = $state(false);
	let showAdvanced = $state(false);

	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';

	let loading = $state(false);
	let error = $state('');
	let liveLogs = $state<string[]>([]);

	// Step tracking
	let currentStep = $state(1); // 1=Seed, 2=Review/Reorder, 3=Apply, 4=Start Swiss
	let applied = $state(false);

	// Start Swiss setup
	let startingSwiss = $state(false);
	let numStations = $state('16');
	let streamStation = $state('16');

	// Start from existing seeded event
	let eventUrl = $state('');
	let loadingEvent = $state(false);

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

	async function startFromEvent() {
		if (!eventUrl.trim()) return;
		loadingEvent = true;
		error = '';
		const res = await fetch('/api/tournament/from-event', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				eventSlug: eventUrl.trim(),
				numStations: Number(numStations),
				streamStation: Number(streamStation)
			})
		});
		loadingEvent = false;
		if (!res.ok) {
			const data = await res.json();
			error = data.error ?? 'Failed to load event';
		} else {
			goto('/dashboard/tournament/swiss');
		}
	}

	async function startSwiss() {
		if (!result) return;
		startingSwiss = true;
		error = '';
		const slug = result.targetSlug.replace(/\//g, '-');
		const name = result.targetSlug.split('/').pop() ?? slug;
		const res = await fetch('/api/tournament', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name, slug,
				entrants: result.entrants.map((e) => ({ gamerTag: e.gamerTag, initialSeed: e.seedNum })),
				numStations: Number(numStations),
				streamStation: Number(streamStation)
			})
		});
		startingSwiss = false;
		if (!res.ok) {
			const data = await res.json();
			error = data.error ?? 'Failed to create tournament';
		} else {
			goto('/dashboard/tournament/swiss');
		}
	}

	let abortController: AbortController | null = null;
	let result = $state<{
		entrants: { seedNum: number; gamerTag: string; elo: number; jitteredElo: number; isNewcomer: boolean }[];
		pairings: { top: { seedNum: number; gamerTag: string }; bottom: { seedNum: number; gamerTag: string } }[];
		unresolvedCollisions: { top: { gamerTag: string }; bottom: { gamerTag: string } }[];
		targetSlug: string;
		logs: string[];
	} | null>(null);

	function cancelSeeder() { abortController?.abort(); abortController = null; loading = false; }
	onDestroy(() => abortController?.abort());

	async function runSeeder() {
		loading = true; error = ''; result = null; liveLogs = [];
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
					avoidEvents: avoidEvents || undefined, jitter: jitter || 20,
					seed: seed || undefined, apply
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
		if (result) { currentStep = 2; applied = apply; }
	}

	// Manual reorder
	function moveUp(idx: number) {
		if (!result || idx <= 0) return;
		const e = [...result.entrants];
		[e[idx - 1], e[idx]] = [e[idx], e[idx - 1]];
		e.forEach((ent, i) => ent.seedNum = i + 1);
		result = { ...result, entrants: e, pairings: computePairings(e) };
	}

	function moveDown(idx: number) {
		if (!result || idx >= result.entrants.length - 1) return;
		const e = [...result.entrants];
		[e[idx], e[idx + 1]] = [e[idx + 1], e[idx]];
		e.forEach((ent, i) => ent.seedNum = i + 1);
		result = { ...result, entrants: e, pairings: computePairings(e) };
	}

	function computePairings(entrants: NonNullable<typeof result>['entrants']) {
		const n = entrants.length;
		const half = Math.floor(n / 2);
		const pairings = [];
		for (let i = 0; i < half; i++) {
			pairings.push({
				top: { seedNum: entrants[i].seedNum, gamerTag: entrants[i].gamerTag },
				bottom: { seedNum: entrants[i + half].seedNum, gamerTag: entrants[i + half].gamerTag }
			});
		}
		return pairings;
	}

	// Check if a pairing is a collision (rematch from last week)
	function isCollision(top: string, bottom: string): boolean {
		if (!result) return false;
		return result.unresolvedCollisions.some(
			(c) => (c.top.gamerTag === top && c.bottom.gamerTag === bottom) ||
			        (c.top.gamerTag === bottom && c.bottom.gamerTag === top)
		);
	}

	const inputClass = 'mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500';
	const days = [
		{ value: 'mon', label: 'Monday' }, { value: 'tue', label: 'Tuesday' },
		{ value: 'wed', label: 'Wednesday' }, { value: 'thu', label: 'Thursday' },
		{ value: 'fri', label: 'Friday' }, { value: 'sat', label: 'Saturday' },
		{ value: 'sun', label: 'Sunday' }
	];

	onMount(async () => {});
</script>

<main class="mx-auto max-w-4xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Seed Event</h1>
	<p class="mt-1 text-gray-400">Elo-based seeding with configurable jitter.</p>

	{#if error}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">{error}</div>
	{/if}

	<!-- ── Timeline ── -->
	<div class="mt-8 space-y-0">

	<!-- ── Step 1: Seed ── -->
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
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label for="mode" class="block text-sm font-medium text-gray-300">Mode</label>
						<select id="mode" bind:value={mode} class={inputClass}>
							<option value="micro">Micro</option>
							<option value="macro">Macro</option>
						</select>
					</div>
					<div>
						<label for="target" class="block text-sm font-medium text-gray-300"># <span class="text-red-400">*</span></label>
						<input id="target" type="number" bind:value={targetNumber} required placeholder="e.g. 134" class={inputClass} />
					</div>
					<div>
						<label for="season-start" class="block text-sm font-medium text-gray-300">Season Start <span class="text-red-400">*</span></label>
						<input id="season-start" type="number" bind:value={seasonStart} required placeholder="e.g. 120" class={inputClass} />
					</div>
					<div>
						<label for="jitter" class="block text-sm font-medium text-gray-300">Jitter</label>
						<input id="jitter" type="number" step="0.1" bind:value={jitter} class={inputClass} />
					</div>
				</div>

				<button type="button" onclick={() => showAdvanced = !showAdvanced}
					class="text-sm text-gray-400 hover:text-violet-400 transition-colors">
					{showAdvanced ? '▾' : '▸'} Advanced options
				</button>

				{#if showAdvanced}
					<div class="grid gap-4 sm:grid-cols-2 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
						<div>
							<label for="micro-end" class="block text-sm font-medium text-gray-300">Micro End</label>
							<input id="micro-end" type="number" bind:value={microEnd} placeholder="auto" class={inputClass} />
						</div>
						<div>
							<label for="rng-seed" class="block text-sm font-medium text-gray-300">RNG Seed</label>
							<input id="rng-seed" type="number" bind:value={seed} placeholder="random" class={inputClass} />
						</div>
						<div>
							<label for="macros" class="block text-sm font-medium text-gray-300">Macros</label>
							<input id="macros" type="text" bind:value={macros} placeholder="e.g. 6,7" class={inputClass} />
						</div>
						{#if mode === 'macro'}
						<div>
							<label for="avoid" class="block text-sm font-medium text-gray-300">Avoid Events</label>
							<input id="avoid" type="text" bind:value={avoidEvents} placeholder="tournament/slug/event/name" class={inputClass} />
						</div>
						{/if}
					</div>
				{/if}

				<div class="flex items-center gap-4">
					{#if loading}
						<button type="button" onclick={cancelSeeder}
							class="rounded-lg bg-red-600 px-6 py-2 font-medium text-white hover:bg-red-500">Cancel</button>
					{:else}
						<button type="submit" disabled={!targetNumber || !seasonStart}
							class="rounded-lg bg-violet-600 px-6 py-2 font-medium text-white hover:bg-violet-500 disabled:opacity-50">
							Generate Seeding
						</button>
					{/if}
					<label class="flex items-center gap-2 text-sm text-gray-400">
						<input type="checkbox" bind:checked={apply}
							class="rounded border-gray-600 bg-gray-800 text-violet-600 focus:ring-violet-500" />
						Also apply to StartGG
					</label>
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

	<!-- ── Step 2: Review & Reorder ── -->
	{#if result}
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border
				{currentStep >= 2 ? 'border-violet-700 bg-violet-900/40 text-violet-300' : 'border-gray-700 bg-gray-900 text-gray-500'}
				text-xs font-bold">2</div>
			<div class="mt-1 w-px flex-1 bg-gray-800"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Review & Reorder</p>

			<div class="grid gap-6 lg:grid-cols-2">
				<!-- Seeding table -->
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">Seeding</h3>
					<div class="max-h-96 overflow-y-auto rounded-lg border border-gray-800">
						<table class="w-full text-sm">
							<thead class="sticky top-0 bg-gray-900">
								<tr class="border-b border-gray-700 text-left text-gray-400">
									<th class="px-2 py-1.5 text-right w-12">Seed</th>
									<th class="px-2 py-1.5">Tag</th>
									<th class="px-2 py-1.5 text-right w-16">Elo</th>
									<th class="px-2 py-1.5 w-16"></th>
								</tr>
							</thead>
							<tbody>
								{#each result.entrants as e, i}
									<tr class="border-b border-gray-800 hover:bg-gray-800/50">
										<td class="px-2 py-1 text-right font-mono text-gray-400">{e.seedNum}</td>
										<td class="px-2 py-1 text-white">
											{e.gamerTag}
											{#if e.isNewcomer}<span class="ml-1 text-xs text-yellow-400">new</span>{/if}
										</td>
										<td class="px-2 py-1 text-right font-mono text-gray-400">{e.elo.toFixed(0)}</td>
										<td class="px-2 py-1">
											<div class="flex gap-0.5">
												<button onclick={() => moveUp(i)} disabled={i === 0}
													class="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:text-white hover:bg-gray-700 disabled:opacity-20">▲</button>
												<button onclick={() => moveDown(i)} disabled={i === result.entrants.length - 1}
													class="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:text-white hover:bg-gray-700 disabled:opacity-20">▼</button>
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>

				<!-- R1 Pairings -->
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">R1 Pairings</h3>
					<div class="space-y-1">
						{#each result.pairings as { top, bottom }}
							<div class="flex items-center gap-2 rounded px-3 py-1.5 text-sm
								{isCollision(top.gamerTag, bottom.gamerTag) ? 'bg-red-900/30 border border-red-800' : 'bg-gray-900'}">
								<span class="w-6 text-right font-mono text-xs text-gray-500">{top.seedNum}</span>
								<span class="flex-1 text-white">{top.gamerTag}</span>
								<span class="text-gray-600 text-xs">vs</span>
								<span class="flex-1 text-right text-white">{bottom.gamerTag}</span>
								<span class="w-6 font-mono text-xs text-gray-500">{bottom.seedNum}</span>
								{#if isCollision(top.gamerTag, bottom.gamerTag)}
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

					{#if result.unresolvedCollisions.length > 0}
						<div class="mt-3 rounded-lg border border-yellow-700 bg-yellow-900/20 p-3 text-xs text-yellow-400">
							{result.unresolvedCollisions.length} rematch{result.unresolvedCollisions.length > 1 ? 'es' : ''} from last week — reorder seeds to resolve.
						</div>
					{/if}
				</div>
			</div>

			{#if applied}
				<div class="mt-3 rounded-lg border border-green-700 bg-green-900/20 p-3 text-sm text-green-400">
					Seeding applied to StartGG.
				</div>
			{/if}

			<details class="mt-3 rounded-lg border border-gray-800 bg-gray-900">
				<summary class="cursor-pointer px-4 py-2 text-xs text-gray-500">Full Log ({result.logs.length})</summary>
				<pre class="max-h-48 overflow-y-auto px-4 py-2 text-xs text-gray-600">{result.logs.join('\n')}</pre>
			</details>
		</div>
	</div>

	<!-- ── Step 3: Start Swiss ── -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border
				{currentStep >= 3 ? 'border-violet-700 bg-violet-900/40 text-violet-300' : 'border-gray-700 bg-gray-900 text-gray-500'}
				text-xs font-bold">3</div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
			<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Start Swiss</p>

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
					{startingSwiss ? 'Creating...' : 'Start Swiss →'}
				</button>
			</div>
		</div>
	</div>
	{/if}

	<!-- ── Tools ── -->
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
