<script lang="ts">
	import { onMount } from 'svelte';

	interface TOConfig {
		name: string;
		discriminator: string;
		playerId?: number;
		prefix: string;
		autoRegister: boolean;
	}

	interface EventConfig {
		nextEventNumber: number;
		srcTournamentId: number;
		hubIds: string[];
		discordLink: string;
		shortSlug: string;
		tos: TOConfig[];
		lastCreatedTournamentId?: number;
		lastCreatedTournamentSlug?: string;
		updatedAt: number;
	}

	let config = $state<EventConfig | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let message = $state('');

	// Add TO form
	let newName = $state('');
	let newDiscriminator = $state('');
	let newPrefix = $state('');
	let addingTO = $state(false);

	// Swap TO
	let swapRemove = $state('');
	let swapAdd = $state('');
	let swapping = $state(false);
	let swapResult = $state('');

	// Manual trigger
	let triggering = $state(false);
	let triggerResult = $state<{ ok: boolean; steps: { step: string; ok: boolean; detail: string }[] } | null>(null);

	onMount(async () => {
		const res = await fetch('/api/event/config');
		if (res.ok) config = await res.json();
		loading = false;
	});

	async function saveConfig() {
		if (!config) return;
		saving = true;
		message = '';
		const res = await fetch('/api/event/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				nextEventNumber: config.nextEventNumber,
				srcTournamentId: config.srcTournamentId,
				shortSlug: config.shortSlug,
				discordLink: config.discordLink
			})
		});
		if (res.ok) {
			config = await res.json();
			message = 'Saved';
		} else {
			message = 'Save failed';
		}
		saving = false;
	}

	async function addTO() {
		if (!newDiscriminator.trim()) return;
		addingTO = true;
		message = '';
		const res = await fetch('/api/event/tos', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: newName.trim(),
				discriminator: newDiscriminator.trim(),
				prefix: newPrefix.trim(),
				autoRegister: false
			})
		});
		if (res.ok) {
			const data = await res.json();
			if (config) config.tos = data.tos;
			newName = '';
			newDiscriminator = '';
			newPrefix = '';
			message = `Added ${data.to.name}`;
		} else {
			const err = await res.json().catch(() => ({ error: 'Failed' }));
			message = err.error;
		}
		addingTO = false;
	}

	async function removeTO(discriminator: string) {
		if (!confirm('Remove this TO from the pool?')) return;
		const res = await fetch('/api/event/tos', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ discriminator })
		});
		if (res.ok) {
			const data = await res.json();
			if (config) config.tos = data.tos;
			message = 'Removed';
		}
	}

	async function toggleAutoRegister(to: TOConfig) {
		const res = await fetch('/api/event/tos', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: to.name,
				discriminator: to.discriminator,
				prefix: to.prefix,
				autoRegister: !to.autoRegister
			})
		});
		if (res.ok) {
			const data = await res.json();
			if (config) config.tos = data.tos;
		}
	}

	async function swapTO() {
		if (!swapRemove || !swapAdd) return;
		swapping = true;
		swapResult = '';
		const res = await fetch('/api/event/swap-to', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				removeDiscriminator: swapRemove,
				addDiscriminator: swapAdd
			})
		});
		const data = await res.json();
		swapResult = data.results?.join('; ') ?? (data.error || 'Failed');
		swapping = false;
	}

	async function triggerCreateEvent() {
		if (!confirm('Manually trigger event creation? This will create a real event on StartGG.')) return;
		triggering = true;
		triggerResult = null;
		const res = await fetch('/api/event/create-cron', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${prompt('Enter CRON_SECRET:') ?? ''}` }
		});
		triggerResult = await res.json();
		triggering = false;
		// Reload config to get updated state
		const configRes = await fetch('/api/event/config');
		if (configRes.ok) config = await configRes.json();
	}
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<div class="flex items-center gap-3 mb-6">
		<a href="/dashboard" class="text-gray-500 hover:text-violet-400 text-sm">&larr; Dashboard</a>
		<h1 class="text-2xl font-bold text-white">Event Setup</h1>
	</div>

	{#if loading}
		<div class="animate-pulse text-gray-500">Loading...</div>
	{:else if config}

		<!-- Event Config -->
		<section class="rounded-xl border border-gray-800 bg-gray-900 p-5 mb-6">
			<h2 class="text-lg font-semibold text-white mb-4">Event Configuration</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label class="block text-xs font-medium text-gray-400 mb-1">Next Event Number</label>
					<input type="number" bind:value={config.nextEventNumber}
						class="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" />
				</div>
				<div>
					<label class="block text-xs font-medium text-gray-400 mb-1">Template Tournament ID</label>
					<input type="number" bind:value={config.srcTournamentId}
						class="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" />
				</div>
				<div>
					<label class="block text-xs font-medium text-gray-400 mb-1">Short Slug</label>
					<input type="text" bind:value={config.shortSlug}
						class="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" />
				</div>
				<div>
					<label class="block text-xs font-medium text-gray-400 mb-1">Discord Link</label>
					<input type="text" bind:value={config.discordLink}
						class="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" />
				</div>
			</div>

			{#if config.lastCreatedTournamentId}
				<p class="mt-3 text-xs text-gray-500">
					Last created: tournament #{config.lastCreatedTournamentId}
					{#if config.lastCreatedTournamentSlug}
						(<a href="https://start.gg/tournament/{config.lastCreatedTournamentSlug}" target="_blank" class="text-violet-400 hover:text-violet-300">{config.lastCreatedTournamentSlug}</a>)
					{/if}
				</p>
			{/if}

			<div class="mt-4 flex items-center gap-3">
				<button onclick={saveConfig} disabled={saving}
					class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
					{saving ? 'Saving...' : 'Save Config'}
				</button>
				{#if message}
					<span class="text-sm {message === 'Saved' ? 'text-green-400' : 'text-red-400'}">{message}</span>
				{/if}
			</div>
		</section>

		<!-- TO Management -->
		<section class="rounded-xl border border-gray-800 bg-gray-900 p-5 mb-6">
			<h2 class="text-lg font-semibold text-white mb-4">Tournament Organizers</h2>
			<p class="text-sm text-gray-400 mb-4">TOs with auto-register enabled will be automatically added when an event is created.</p>

			<div class="space-y-2 mb-4">
				{#each config.tos as to}
					<div class="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-800/50 px-4 py-3">
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="font-medium text-white">{to.name}</span>
								{#if to.prefix}<span class="text-xs text-gray-500">[{to.prefix}]</span>{/if}
							</div>
							<div class="text-xs text-gray-500 font-mono">{to.discriminator}
								{#if to.playerId}<span class="text-gray-600"> (player {to.playerId})</span>{/if}
							</div>
						</div>
						<button onclick={() => toggleAutoRegister(to)}
							class="rounded-full px-3 py-1 text-xs font-medium transition-colors
								{to.autoRegister
									? 'bg-green-900/50 text-green-400 border border-green-800 hover:bg-green-900'
									: 'bg-gray-800 text-gray-500 border border-gray-700 hover:border-gray-600'}">
							{to.autoRegister ? 'Auto-register' : 'Manual'}
						</button>
						<button onclick={() => removeTO(to.discriminator)}
							class="text-gray-600 hover:text-red-400 text-sm" title="Remove TO">
							&times;
						</button>
					</div>
				{/each}
			</div>

			<!-- Add TO form -->
			<div class="rounded-lg border border-dashed border-gray-700 p-4">
				<p class="text-xs font-medium text-gray-400 mb-3">Add TO</p>
				<div class="grid gap-3 sm:grid-cols-3">
					<input type="text" bind:value={newDiscriminator} placeholder="Discriminator (e.g. 566b1fb5)"
						class="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600" />
					<input type="text" bind:value={newName} placeholder="Name (auto-resolved if blank)"
						class="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600" />
					<input type="text" bind:value={newPrefix} placeholder="Prefix (optional)"
						class="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600" />
				</div>
				<button onclick={addTO} disabled={addingTO || !newDiscriminator.trim()}
					class="mt-3 rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
					{addingTO ? 'Adding...' : 'Add TO'}
				</button>
			</div>
		</section>

		<!-- Swap TO -->
		<section class="rounded-xl border border-gray-800 bg-gray-900 p-5 mb-6">
			<h2 class="text-lg font-semibold text-white mb-2">Swap Registered TO</h2>
			<p class="text-sm text-gray-400 mb-4">Unregister one TO from the current event and register another in their place.</p>

			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label class="block text-xs font-medium text-gray-400 mb-1">Remove TO</label>
					<select bind:value={swapRemove}
						class="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white">
						<option value="">Select TO to remove...</option>
						{#each config.tos as to}
							<option value={to.discriminator}>{to.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label class="block text-xs font-medium text-gray-400 mb-1">Add TO</label>
					<select bind:value={swapAdd}
						class="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white">
						<option value="">Select TO to add...</option>
						{#each config.tos.filter(t => t.discriminator !== swapRemove) as to}
							<option value={to.discriminator}>{to.name}</option>
						{/each}
					</select>
				</div>
			</div>

			<button onclick={swapTO} disabled={swapping || !swapRemove || !swapAdd}
				class="mt-3 rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50">
				{swapping ? 'Swapping...' : 'Swap TO'}
			</button>
			{#if swapResult}
				<p class="mt-2 text-sm text-gray-300">{swapResult}</p>
			{/if}
		</section>

		<!-- Manual Trigger -->
		<section class="rounded-xl border border-gray-800 bg-gray-900 p-5">
			<h2 class="text-lg font-semibold text-white mb-2">Manual Event Creation</h2>
			<p class="text-sm text-gray-400 mb-4">
				Events are auto-created every Tuesday at 9 AM PST via QStash.
				Use this to manually trigger the flow if the schedule missed.
			</p>

			<button onclick={triggerCreateEvent} disabled={triggering}
				class="rounded-lg bg-red-800 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
				{triggering ? 'Creating event...' : 'Trigger Event Creation'}
			</button>

			{#if triggerResult}
				<div class="mt-4 space-y-1">
					{#each triggerResult.steps as s}
						<div class="flex items-start gap-2 text-sm">
							<span class={s.ok ? 'text-green-400' : 'text-red-400'}>{s.ok ? '✓' : '✗'}</span>
							<span class="text-gray-400">{s.step}:</span>
							<span class="text-gray-300 break-all">{s.detail}</span>
						</div>
					{/each}
					<p class="mt-2 text-sm font-medium {triggerResult.ok ? 'text-green-400' : 'text-red-400'}">
						{triggerResult.ok ? 'Event created successfully' : 'Event creation had failures'}
					</p>
				</div>
			{/if}
		</section>
	{/if}
</main>
