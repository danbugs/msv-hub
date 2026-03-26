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

	onMount(async () => {
		const res = await fetch('/api/tournament');
		if (res.ok) {
			const t = await res.json();
			if (t?.startggEventSlug) eventUrl = t.startggEventSlug;
		}
	});

	let loading = $state(false);
	let error = $state('');
	let liveLogs = $state<string[]>([]);

	// Start Swiss setup
	let startingSwiss = $state(false);
	let numStations = $state('16');
	let streamStation = $state('16');

	// Start from existing seeded event
	let eventUrl = $state('');
	let loadingEvent = $state(false);

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
				name,
				slug,
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
		entrants: {
			seedNum: number;
			gamerTag: string;
			elo: number;
			jitteredElo: number;
			isNewcomer: boolean;
		}[];
		pairings: { top: { seedNum: number; gamerTag: string }; bottom: { seedNum: number; gamerTag: string } }[];
		unresolvedCollisions: { top: { gamerTag: string }; bottom: { gamerTag: string } }[];
		targetSlug: string;
		logs: string[];
	} | null>(null);

	function cancelSeeder() {
		abortController?.abort();
		abortController = null;
		loading = false;
	}

	onDestroy(() => abortController?.abort());

	async function runSeeder() {
		loading = true;
		error = '';
		result = null;
		liveLogs = [];

		abortController = new AbortController();
		const signal = abortController.signal;

		let res: Response;
		try {
			res = await fetch('/api/seeder', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mode,
					targetNumber,
					seasonStart,
					microEnd: microEnd || undefined,
					macros: macros || undefined,
					avoidEvents: avoidEvents || undefined,
					jitter: jitter || 20,
					seed: seed || undefined,
					apply
				}),
				signal
			});
		} catch (err) {
			if (signal.aborted) return;
			loading = false;
			error = err instanceof Error ? err.message : 'Network error';
			return;
		}

		if (!res.ok || !res.body) {
			loading = false;
			try {
				const body = await res.json();
				error = body.error ?? 'Something went wrong';
			} catch {
				error = `HTTP ${res.status}`;
			}
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
					if (line.startsWith('event: ')) {
						eventType = line.slice(7);
					} else if (line.startsWith('data: ')) {
						const data = JSON.parse(line.slice(6));
						if (eventType === 'log') {
							liveLogs = [...liveLogs, data.message];
						} else if (eventType === 'result') {
							result = data;
						} else if (eventType === 'error') {
							error = data.error;
						}
					}
				}
			}
		} catch (err) {
			if (signal.aborted) return;
			throw err;
		}

		loading = false;
		abortController = null;
	}

	const inputClass = 'mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500';
</script>

<main class="mx-auto max-w-5xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Seed Event</h1>
	<p class="mt-1 text-gray-400">Elo-based seeding with configurable jitter.</p>

	<!-- Quick-start from an already-seeded StartGG event -->
	<div class="mt-6 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
		<h2 class="text-sm font-semibold text-gray-300">Start from existing seeded event</h2>
		<p class="mt-0.5 text-xs text-gray-500">Paste a StartGG event URL or slug to use its current seedings directly.</p>
		<div class="mt-3 flex flex-wrap items-end gap-3">
			<div class="flex-1 min-w-48">
				<label for="event-url" class="block text-xs text-gray-400">StartGG event URL or slug</label>
				<input id="event-url" type="text" bind:value={eventUrl}
					placeholder="tournament/micro-132/event/singles"
					class={inputClass} />
			</div>
			<div>
				<label for="fe-stations" class="block text-xs text-gray-400">Stations</label>
				<input id="fe-stations" type="number" bind:value={numStations} min="1"
					class="mt-1 w-20 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white focus:border-violet-500 focus:outline-none" />
			</div>
			<div>
				<label for="fe-stream" class="block text-xs text-gray-400">Stream stn</label>
				<input id="fe-stream" type="number" bind:value={streamStation} min="1"
					class="mt-1 w-20 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white focus:border-violet-500 focus:outline-none" />
			</div>
			<button type="button" onclick={startFromEvent} disabled={loadingEvent || !eventUrl.trim()}
				class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
				{loadingEvent ? 'Loading…' : 'Start Swiss →'}
			</button>
		</div>
	</div>

	<div class="mt-6 flex items-center gap-3 text-xs text-gray-600">
		<div class="flex-1 border-t border-gray-800"></div>
		<span>OR seed a new event</span>
		<div class="flex-1 border-t border-gray-800"></div>
	</div>

	<form onsubmit={(e) => { e.preventDefault(); runSeeder(); }} class="mt-4 space-y-4">
		<div class="grid gap-4 sm:grid-cols-2">
			<div>
				<label for="mode" class="block text-sm font-medium text-gray-300">
					Mode <span class="text-red-400">*</span>
				</label>
				<select id="mode" bind:value={mode} class={inputClass}>
					<option value="micro">Micro</option>
					<option value="macro">Macro</option>
				</select>
			</div>

			<div>
				<label for="target" class="block text-sm font-medium text-gray-300">
					{mode === 'micro' ? 'Microspacing' : 'Macrospacing'} # <span class="text-red-400">*</span>
				</label>
				<input id="target" type="number" bind:value={targetNumber} required
					placeholder="e.g. 133" class={inputClass} />
			</div>

			<div>
				<label for="season-start" class="block text-sm font-medium text-gray-300">
					Season Start (first micro #) <span class="text-red-400">*</span>
				</label>
				<input id="season-start" type="number" bind:value={seasonStart} required
					placeholder="e.g. 120" class={inputClass} />
			</div>

			<div>
				<label for="jitter" class="block text-sm font-medium text-gray-300">
					Jitter <span class="text-gray-500">(max Elo noise, default 20)</span>
				</label>
				<input id="jitter" type="number" step="0.1" bind:value={jitter} class={inputClass} />
			</div>
		</div>

		<!-- Advanced options -->
		<button type="button"
			onclick={() => showAdvanced = !showAdvanced}
			class="text-sm text-gray-400 hover:text-violet-400 transition-colors">
			{showAdvanced ? '▾' : '▸'} Advanced options
		</button>

		{#if showAdvanced}
			<div class="grid gap-4 sm:grid-cols-2 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
				<div>
					<label for="micro-end" class="block text-sm font-medium text-gray-300">
						Micro End
					</label>
					<p class="text-xs text-gray-500 mb-1">Last micro # for Elo history. Defaults to target - 1. Use to exclude recent events.</p>
					<input id="micro-end" type="number" bind:value={microEnd}
						placeholder="auto" class={inputClass} />
				</div>

				<div>
					<label for="rng-seed" class="block text-sm font-medium text-gray-300">
						RNG Seed
					</label>
					<p class="text-xs text-gray-500 mb-1">Set for reproducible jitter. Leave empty for random.</p>
					<input id="rng-seed" type="number" bind:value={seed}
						placeholder="random" class={inputClass} />
				</div>

				<div>
					<label for="macros" class="block text-sm font-medium text-gray-300">
						Macros to include
					</label>
					<p class="text-xs text-gray-500 mb-1">Comma-separated macro numbers to include in Elo history.</p>
					<input id="macros" type="text" bind:value={macros}
						placeholder="e.g. 6,7" class={inputClass} />
				</div>

				{#if mode === 'macro'}
					<div>
						<label for="avoid" class="block text-sm font-medium text-gray-300">
							Avoid Events
						</label>
						<p class="text-xs text-gray-500 mb-1">Comma-separated event slugs for matchup avoidance.</p>
						<input id="avoid" type="text" bind:value={avoidEvents}
							placeholder="tournament/slug/event/event-name" class={inputClass} />
					</div>
				{/if}
			</div>
		{/if}

		<div class="flex items-center gap-4">
			{#if loading}
				<button type="button" onclick={cancelSeeder}
					class="rounded-lg bg-red-600 px-6 py-2 font-medium text-white transition-colors hover:bg-red-500">
					Cancel
				</button>
			{:else}
				<button type="submit" disabled={!targetNumber || !seasonStart}
					class="rounded-lg bg-violet-600 px-6 py-2 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50">
					Preview Seeding
				</button>
			{/if}
			<label class="flex items-center gap-4 text-sm text-gray-400">
				<input type="checkbox" bind:checked={apply}
					class="rounded border-gray-600 bg-gray-800 text-violet-600 focus:ring-violet-500" />
				Apply to StartGG
			</label>
		</div>
	</form>

	{#if error}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">
			{error}
		</div>
	{/if}

	{#if loading && liveLogs.length > 0}
		<div class="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
			<div class="flex items-center gap-2 mb-2">
				<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>
				<span class="text-sm font-medium text-gray-300">Progress</span>
			</div>
			<div class="max-h-48 overflow-y-auto">
				{#each liveLogs as msg}
					<div class="text-xs text-gray-400 font-mono py-0.5">{msg}</div>
				{/each}
			</div>
		</div>
	{:else if loading}
		<div class="mt-6 flex items-center gap-2 text-gray-400">
			<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>
			Starting...
		</div>
	{/if}

	{#if result}
		<div class="mt-8 space-y-6">
			<div>
				<h2 class="text-lg font-semibold text-white">Seeding — {result.targetSlug}</h2>
				<div class="mt-3 overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-gray-700 text-left text-gray-400">
								<th class="px-3 py-2 text-right">Seed</th>
								<th class="px-3 py-2">Tag</th>
								<th class="px-3 py-2 text-right">Elo</th>
								<th class="px-3 py-2 text-right">Jittered</th>
								<th class="px-3 py-2 text-center">New?</th>
							</tr>
						</thead>
						<tbody>
							{#each result.entrants as e}
								<tr class="border-b border-gray-800 hover:bg-gray-800/50">
									<td class="px-3 py-2 text-right font-mono text-gray-300">{e.seedNum}</td>
									<td class="px-3 py-2 text-white">{e.gamerTag}</td>
									<td class="px-3 py-2 text-right font-mono text-gray-300">{e.elo.toFixed(1)}</td>
									<td class="px-3 py-2 text-right font-mono text-gray-300">{e.jitteredElo.toFixed(1)}</td>
									<td class="px-3 py-2 text-center">{e.isNewcomer ? '*' : ''}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>

			<div>
				<h2 class="text-lg font-semibold text-white">Predicted Swiss R1 Pairings</h2>
				<div class="mt-3 space-y-1">
					{#each result.pairings as { top, bottom }}
						<div class="flex items-center gap-2 rounded bg-gray-900 px-3 py-2 text-sm">
							<span class="w-20 text-right font-mono text-gray-400">Seed {top.seedNum}</span>
							<span class="text-white">{top.gamerTag}</span>
							<span class="text-gray-500">vs</span>
							<span class="w-20 text-right font-mono text-gray-400">Seed {bottom.seedNum}</span>
							<span class="text-white">{bottom.gamerTag}</span>
						</div>
					{/each}
					{#if result.entrants.length % 2 === 1}
						{@const bye = result.entrants[result.entrants.length - 1]}
						<div class="flex items-center gap-2 rounded bg-gray-900 px-3 py-2 text-sm">
							<span class="w-20 text-right font-mono text-gray-400">Seed {bye.seedNum}</span>
							<span class="text-white">{bye.gamerTag}</span>
							<span class="text-yellow-500">→ BYE</span>
						</div>
					{/if}
				</div>
			</div>

			{#if result.unresolvedCollisions.length > 0}
				<div class="rounded-lg border border-yellow-700 bg-yellow-900/20 p-4">
					<h3 class="font-semibold text-yellow-400">Unresolved R1 Collisions</h3>
					<ul class="mt-2 space-y-1 text-sm text-yellow-300">
						{#each result.unresolvedCollisions as { top, bottom }}
							<li>{top.gamerTag} vs {bottom.gamerTag}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<details class="rounded-lg border border-gray-800 bg-gray-900">
				<summary class="cursor-pointer px-4 py-2 text-sm text-gray-400">Full Log ({result.logs.length} entries)</summary>
				<pre class="max-h-64 overflow-y-auto px-4 py-2 text-xs text-gray-500">{result.logs.join('\n')}</pre>
			</details>

			{#if apply && !error}
				<div class="rounded-lg border border-green-700 bg-green-900/20 p-4 text-sm text-green-400">
					Seeding has been applied to StartGG.
				</div>
			{/if}

			<!-- Start Swiss from these results -->
			<div class="rounded-lg border border-violet-800 bg-violet-900/20 p-4">
				<h3 class="font-semibold text-violet-300">Start Swiss with these results</h3>
				<p class="mt-1 text-xs text-gray-400">Creates the tournament using this seeding as seeds 1–N. You can re-seed and restart if needed.</p>
				<div class="mt-3 flex items-end gap-3 flex-wrap">
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
						class="rounded-lg bg-violet-600 px-5 py-2 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50">
						{startingSwiss ? 'Creating...' : 'Start Swiss →'}
					</button>
				</div>
			</div>
		</div>
	{/if}
</main>
