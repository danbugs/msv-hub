<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';

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
		paused: boolean;
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

	// Template presets
	const TEMPLATES = [
		{ label: 'Micro (default)', url: 'https://www.start.gg/tournament/microspacing-vancouver-test', id: 895482 },
		{ label: 'Macro', url: 'https://www.start.gg/tournament/macrospacing-vancouver-test', id: 915494 },
	] as const;

	// Config template choice (synced from stored srcTournamentId on mount)
	let configTemplateChoice = $state<'micro' | 'macro' | 'custom'>('micro');
	let configCustomUrl = $state('');

	// One-off event overrides
	let useOverrides = $state(false);
	let overrideName = $state('');
	let overrideDate = $state('');
	let overrideHour = $state(18);
	let overrideShortSlug = $state('');
	let overrideTemplateChoice = $state<'micro' | 'macro' | 'custom'>('macro');
	let overrideCustomUrl = $state('');
	let overrideAttendeeCap = $state<32 | 64>(64);
	let skipCounterIncrement = $state(true);
	let skipDiscordSetup = $state(true);
	let resolvingUrl = $state(false);

	async function resolveTemplate(choice: 'micro' | 'macro' | 'custom', customUrl: string): Promise<number | null> {
		if (choice === 'micro') return TEMPLATES[0].id;
		if (choice === 'macro') return TEMPLATES[1].id;
		if (!customUrl.trim()) return null;
		const slug = customUrl.replace(/^https?:\/\/[^/]+\//, '').replace(/\/+$/, '');
		const tournSlug = slug.match(/tournament\/([^/]+)/)?.[1];
		if (!tournSlug) { message = 'Invalid tournament URL'; return null; }
		resolvingUrl = true;
		try {
			const res = await fetch('/api/startgg/resolve-tournament', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ slug: tournSlug })
			});
			const data = await res.json();
			if (!data.id) { message = `Could not find tournament: ${tournSlug}`; return null; }
			return data.id;
		} finally {
			resolvingUrl = false;
		}
	}

	onMount(async () => {
		const res = await fetch('/api/event/config');
		if (res.ok) config = await res.json();
		if (config) {
			const match = TEMPLATES.find(t => t.id === config!.srcTournamentId);
			if (match) {
				configTemplateChoice = match.label.startsWith('Micro') ? 'micro' : 'macro';
			} else {
				configTemplateChoice = 'custom';
			}
		}
		loading = false;
	});

	async function saveConfig() {
		if (!config) return;
		saving = true;
		message = '';
		const templateId = await resolveTemplate(configTemplateChoice, configCustomUrl);
		if (configTemplateChoice === 'custom' && !templateId) { saving = false; return; }
		if (templateId) config.srcTournamentId = templateId;
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

	async function togglePaused() {
		if (!config) return;
		const res = await fetch('/api/event/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ paused: !config.paused })
		});
		if (res.ok) config = await res.json();
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
		const label = useOverrides && overrideName ? overrideName : `Microspacing Vancouver #${config?.nextEventNumber}`;
		if (!confirm(`Create "${label}" on StartGG? This is a real event.`)) return;
		triggering = true;
		triggerResult = null;

		const body: Record<string, unknown> = {};
		if (useOverrides) {
			if (overrideName) body.name = overrideName;
			if (overrideDate) body.startDate = overrideDate;
			body.startHour = overrideHour;
			if (overrideShortSlug) body.shortSlug = overrideShortSlug;
			const templateId = await resolveTemplate(overrideTemplateChoice, overrideCustomUrl);
			if (overrideTemplateChoice === 'custom' && !templateId) { triggering = false; return; }
			if (templateId) body.srcTournamentId = templateId;
			body.attendeeCap = overrideAttendeeCap;
			body.skipCounterIncrement = skipCounterIncrement;
			body.skipDiscordSetup = skipDiscordSetup;
		}

		const res = await fetch('/api/event/create-cron', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		triggerResult = await res.json();
		triggering = false;
		const configRes = await fetch('/api/event/config');
		if (configRes.ok) config = await configRes.json();
	}
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<div class="flex items-center gap-3 mb-6">
		<a href="/dashboard" class="text-muted-foreground hover:text-primary text-sm">&larr; Dashboard</a>
		<h1 class="text-2xl font-bold text-foreground">Event Setup</h1>
	</div>

	{#if loading}
		<div class="animate-pulse text-muted-foreground">Loading...</div>
	{:else if config}

		<!-- Pause Toggle -->
		<section class="rounded-xl border {config.paused ? 'border-warning-border bg-warning-muted' : 'border-success-border bg-success-muted'} p-4 mb-6 flex flex-wrap gap-3 items-center justify-between" style="box-shadow: var(--shadow-card)">
			<div class="min-w-0">
				<p class="font-medium {config.paused ? 'text-warning' : 'text-success'}">
					{config.paused ? 'Event creation paused' : 'Event creation active'}
				</p>
				<p class="text-sm text-muted-foreground mt-0.5">
					{config.paused
						? 'The Tuesday cron will skip event creation until unpaused.'
						: `Next run will create Microspacing Vancouver #${config.nextEventNumber}.`}
				</p>
			</div>
			<Button onclick={togglePaused} variant={config.paused ? 'default' : 'destructive'}>
				{config.paused ? 'Unpause' : 'Pause'}
			</Button>
		</section>

		<!-- Event Config -->
		<section class="rounded-xl border border-border bg-card p-5 mb-6">
			<h2 class="text-lg font-semibold text-foreground mb-4">Event Configuration</h2>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label class="block text-xs font-medium text-muted-foreground mb-1">Next Event Number</label>
					<input type="number" bind:value={config.nextEventNumber}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground" />
				</div>
				<div>
					<label class="block text-xs font-medium text-muted-foreground mb-1">Template</label>
					<select bind:value={configTemplateChoice}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground">
						<option value="micro">Micro (default)</option>
						<option value="macro">Macro</option>
						<option value="custom">Custom URL...</option>
					</select>
				</div>
				{#if configTemplateChoice === 'custom'}
					<div>
						<label class="block text-xs font-medium text-muted-foreground mb-1">Template Tournament URL</label>
						<input type="text" bind:value={configCustomUrl} placeholder="https://www.start.gg/tournament/..."
							class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground" />
					</div>
				{/if}
				<div>
					<label class="block text-xs font-medium text-muted-foreground mb-1">Short Slug</label>
					<input type="text" bind:value={config.shortSlug}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground" />
				</div>
				<div>
					<label class="block text-xs font-medium text-muted-foreground mb-1">Discord Link</label>
					<input type="text" bind:value={config.discordLink}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground" />
				</div>
			</div>

			{#if config.lastCreatedTournamentId}
				<p class="mt-3 text-xs text-muted-foreground">
					Last created: tournament #{config.lastCreatedTournamentId}
					{#if config.lastCreatedTournamentSlug}
						(<a href="https://start.gg/tournament/{config.lastCreatedTournamentSlug}" target="_blank" class="text-primary hover:text-primary/80 break-all">{config.lastCreatedTournamentSlug}</a>)
					{/if}
				</p>
			{/if}

			<div class="mt-4 flex items-center gap-3">
				<button onclick={saveConfig} disabled={saving}
					class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
					{saving ? 'Saving...' : 'Save Config'}
				</button>
				{#if message}
					<span class="text-sm {message === 'Saved' ? 'text-success' : 'text-destructive'}">{message}</span>
				{/if}
			</div>
		</section>

		<!-- TO Management -->
		<section class="rounded-xl border border-border bg-card p-5 mb-6">
			<h2 class="text-lg font-semibold text-foreground mb-4">Tournament Organizers</h2>
			<p class="text-sm text-muted-foreground mb-4">TOs with auto-register enabled will be automatically added when an event is created.</p>

			<div class="space-y-2 mb-4">
				{#each config.tos as to}
					<div class="flex items-center gap-3 rounded-lg border border-border bg-secondary/50 px-4 py-3">
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="font-medium text-foreground truncate">{to.name}</span>
								{#if to.prefix}<span class="text-xs text-muted-foreground">[{to.prefix}]</span>{/if}
							</div>
							<div class="text-xs text-muted-foreground font-mono truncate">{to.discriminator}
								{#if to.playerId}<span class="text-muted-foreground"> (player {to.playerId})</span>{/if}
							</div>
						</div>
						<button onclick={() => toggleAutoRegister(to)}
							class="rounded-full px-3 py-1 text-xs font-medium transition-colors
								{to.autoRegister
									? 'bg-green-900/50 text-success border border-success-border hover:bg-green-900'
									: 'bg-secondary text-muted-foreground border border-border hover:border-primary'}">
							{to.autoRegister ? 'Auto-register' : 'Manual'}
						</button>
						<button onclick={() => removeTO(to.discriminator)}
							class="text-muted-foreground hover:text-destructive text-sm" title="Remove TO">
							&times;
						</button>
					</div>
				{/each}
			</div>

			<!-- Add TO form -->
			<div class="rounded-lg border border-dashed border-border p-4">
				<p class="text-xs font-medium text-muted-foreground mb-3">Add TO</p>
				<div class="grid gap-3 sm:grid-cols-3">
					<input type="text" bind:value={newDiscriminator} placeholder="Discriminator (e.g. 566b1fb5)"
						class="rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground" />
					<input type="text" bind:value={newName} placeholder="Name (auto-resolved if blank)"
						class="rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground" />
					<input type="text" bind:value={newPrefix} placeholder="Prefix (optional)"
						class="rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground" />
				</div>
				<button onclick={addTO} disabled={addingTO || !newDiscriminator.trim()}
					class="mt-3 rounded-lg bg-accent px-4 py-2 text-sm text-foreground hover:bg-accent disabled:opacity-50">
					{addingTO ? 'Adding...' : 'Add TO'}
				</button>
			</div>
		</section>

		<!-- Swap TO -->
		<section class="rounded-xl border border-border bg-card p-5 mb-6">
			<h2 class="text-lg font-semibold text-foreground mb-2">Swap Registered TO</h2>
			<p class="text-sm text-muted-foreground mb-4">Unregister one TO from the current event and register another in their place.</p>

			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label class="block text-xs font-medium text-muted-foreground mb-1">Remove TO</label>
					<select bind:value={swapRemove}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground">
						<option value="">Select TO to remove...</option>
						{#each config.tos as to}
							<option value={to.discriminator}>{to.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label class="block text-xs font-medium text-muted-foreground mb-1">Add TO</label>
					<select bind:value={swapAdd}
						class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground">
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
				<p class="mt-2 text-sm text-foreground">{swapResult}</p>
			{/if}
		</section>

		<!-- Manual Trigger -->
		<section class="rounded-xl border border-border bg-card p-5">
			<h2 class="text-lg font-semibold text-foreground mb-2">Manual Event Creation</h2>
			<p class="text-sm text-muted-foreground mb-4">
				Events are auto-created every Tuesday at 9 AM PST via QStash.
				Use this to manually trigger the flow or create a one-off event.
			</p>

			<!-- One-off toggle -->
			<div class="mb-4">
				<label class="flex items-center gap-2 cursor-pointer">
					<input type="checkbox" bind:checked={useOverrides}
						class="rounded border-input" />
					<span class="text-sm font-medium text-foreground">One-off event (custom name, date, etc.)</span>
				</label>
			</div>

			{#if useOverrides}
				<div class="rounded-lg border border-dashed border-border p-4 mb-4 space-y-3">
					<div class="grid gap-3 sm:grid-cols-2">
						<div>
							<label class="block text-xs font-medium text-muted-foreground mb-1">Event Name</label>
							<input type="text" bind:value={overrideName} placeholder="e.g. Macrospacing Vancouver #7"
								class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground" />
						</div>
						<div>
							<label class="block text-xs font-medium text-muted-foreground mb-1">Event Date</label>
							<input type="date" bind:value={overrideDate}
								class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground" />
						</div>
						<div>
							<label class="block text-xs font-medium text-muted-foreground mb-1">Start Hour (PST, 0-23)</label>
							<input type="number" bind:value={overrideHour} min="0" max="23"
								class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground" />
						</div>
						<div>
							<label class="block text-xs font-medium text-muted-foreground mb-1">Attendee Cap</label>
							<select bind:value={overrideAttendeeCap}
								class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground">
								<option value={32}>32 (Micro)</option>
								<option value={64}>64 (Macro)</option>
							</select>
						</div>
						<div>
							<label class="block text-xs font-medium text-muted-foreground mb-1">Short Slug (optional)</label>
							<input type="text" bind:value={overrideShortSlug} placeholder={config?.shortSlug ?? ''}
								class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground" />
						</div>
						<div>
							<label class="block text-xs font-medium text-muted-foreground mb-1">Template</label>
							<select bind:value={overrideTemplateChoice}
								class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground">
								{#each TEMPLATES as t}
									<option value={t.label.split(' ')[0].toLowerCase()}>{t.label}</option>
								{/each}
								<option value="custom">Custom URL...</option>
							</select>
						</div>
						{#if overrideTemplateChoice === 'custom'}
							<div>
								<label class="block text-xs font-medium text-muted-foreground mb-1">Template Tournament URL</label>
								<input type="text" bind:value={overrideCustomUrl} placeholder="https://www.start.gg/tournament/..."
									class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground" />
							</div>
						{/if}
					</div>
					<div class="space-y-2">
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={skipCounterIncrement}
								class="rounded border-input" />
							<span class="text-sm text-muted-foreground">Don't increment Microspacing event counter</span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={skipDiscordSetup}
								class="rounded border-input" />
							<span class="text-sm text-muted-foreground">Skip Discord pre-tournament setup (don't lock old threads)</span>
						</label>
					</div>
				</div>
			{/if}

			<button onclick={triggerCreateEvent} disabled={triggering || resolvingUrl || (useOverrides && !overrideName)}
				class="rounded-lg bg-red-800 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
				{#if resolvingUrl}
					Resolving template...
				{:else if triggering}
					Creating event...
				{:else if useOverrides && overrideName}
					Create "{overrideName}"
				{:else}
					Trigger Event Creation
				{/if}
			</button>

			{#if triggerResult}
				<div class="mt-4 space-y-1">
					{#each triggerResult.steps as s}
						<div class="flex items-start gap-2 text-sm">
							<span class={s.ok ? 'text-success' : 'text-destructive'}>{s.ok ? '✓' : '✗'}</span>
							<span class="text-muted-foreground">{s.step}:</span>
							<span class="text-foreground break-all">{s.detail}</span>
						</div>
					{/each}
					<p class="mt-2 text-sm font-medium {triggerResult.ok ? 'text-success' : 'text-destructive'}">
						{triggerResult.ok ? 'Event created successfully' : 'Event creation had failures'}
					</p>
				</div>
			{/if}
		</section>
	{/if}
</main>
