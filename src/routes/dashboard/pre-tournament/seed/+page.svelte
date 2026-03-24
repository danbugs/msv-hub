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

	let loading = $state(false);
	let error = $state('');
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

	async function runSeeder() {
		loading = true;
		error = '';
		result = null;

		const res = await fetch('/api/seeder', {
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
			})
		});

		loading = false;
		if (!res.ok) {
			const body = await res.json();
			error = body.error ?? 'Something went wrong';
			return;
		}

		result = await res.json();
	}
</script>

<main class="mx-auto max-w-5xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Seed Event</h1>
	<p class="mt-1 text-gray-400">Elo-based seeding with configurable jitter — ported from <code>seeder.py</code>.</p>

	<form onsubmit={(e) => { e.preventDefault(); runSeeder(); }} class="mt-6 space-y-4">
		<div class="grid gap-4 sm:grid-cols-2">
			<!-- Mode -->
			<div>
				<label for="mode" class="block text-sm font-medium text-gray-300">Mode</label>
				<select id="mode" bind:value={mode}
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white">
					<option value="micro">Micro</option>
					<option value="macro">Macro</option>
				</select>
			</div>

			<!-- Target number -->
			<div>
				<label for="target" class="block text-sm font-medium text-gray-300">
					{mode === 'micro' ? 'Microspacing' : 'Macrospacing'} #
				</label>
				<input id="target" type="number" bind:value={targetNumber} required
					placeholder="e.g. 133"
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500" />
			</div>

			<!-- Season start -->
			<div>
				<label for="season-start" class="block text-sm font-medium text-gray-300">Season Start (first micro #)</label>
				<input id="season-start" type="number" bind:value={seasonStart} required
					placeholder="e.g. 120"
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500" />
			</div>

			<!-- Micro end -->
			<div>
				<label for="micro-end" class="block text-sm font-medium text-gray-300">
					Micro End
					<span class="text-gray-500">(defaults to target - 1 for micro)</span>
				</label>
				<input id="micro-end" type="number" bind:value={microEnd}
					placeholder="auto"
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500" />
			</div>

			<!-- Macros to include -->
			<div>
				<label for="macros" class="block text-sm font-medium text-gray-300">
					Macros to include
					<span class="text-gray-500">(comma-separated #s)</span>
				</label>
				<input id="macros" type="text" bind:value={macros}
					placeholder="e.g. 6,7"
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500" />
			</div>

			<!-- Jitter -->
			<div>
				<label for="jitter" class="block text-sm font-medium text-gray-300">
					Jitter (max Elo noise)
				</label>
				<input id="jitter" type="number" step="0.1" bind:value={jitter}
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white" />
			</div>

			<!-- RNG Seed -->
			<div>
				<label for="rng-seed" class="block text-sm font-medium text-gray-300">
					RNG Seed
					<span class="text-gray-500">(optional, for reproducibility)</span>
				</label>
				<input id="rng-seed" type="number" bind:value={seed}
					placeholder="random"
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500" />
			</div>

			{#if mode === 'macro'}
				<!-- Avoid events (macro only) -->
				<div class="sm:col-span-2">
					<label for="avoid" class="block text-sm font-medium text-gray-300">
						Avoid Events
						<span class="text-gray-500">(comma-separated slugs)</span>
					</label>
					<input id="avoid" type="text" bind:value={avoidEvents}
						placeholder="tournament/slug/event/event-name"
						class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500" />
				</div>
			{/if}
		</div>

		<div class="flex items-center gap-4">
			<button type="submit" disabled={loading || !targetNumber || !seasonStart}
				class="rounded-lg bg-violet-600 px-6 py-2 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50">
				{loading ? 'Running...' : 'Preview Seeding'}
			</button>
			<label class="flex items-center gap-2 text-sm text-gray-400">
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

	{#if loading}
		<div class="mt-6 text-gray-400">
			This may take a few minutes — fetching historical tournament data from StartGG...
		</div>
	{/if}

	{#if result}
		<div class="mt-8 space-y-6">
			<!-- Seed table -->
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

			<!-- Predicted R1 pairings -->
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

			<!-- Warnings -->
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

			<!-- Logs -->
			<details class="rounded-lg border border-gray-800 bg-gray-900">
				<summary class="cursor-pointer px-4 py-2 text-sm text-gray-400">Execution Log ({result.logs.length} entries)</summary>
				<pre class="max-h-64 overflow-y-auto px-4 py-2 text-xs text-gray-500">{result.logs.join('\n')}</pre>
			</details>

			{#if apply && !error}
				<div class="rounded-lg border border-green-700 bg-green-900/20 p-4 text-sm text-green-400">
					Seeding has been applied to StartGG.
				</div>
			{/if}
		</div>
	{/if}
</main>
