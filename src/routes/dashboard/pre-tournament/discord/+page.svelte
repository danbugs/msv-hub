<script lang="ts">
	import { onMount } from 'svelte';

	// ---------------------------------------------------------------------------
	// Config state
	// ---------------------------------------------------------------------------

	interface DiscordConfig {
		eventSlug: string;
		attendeeCap: 32 | 64;
		registrationDay: string;
		registrationHour: number;
		registrationMinute: number;
		announcementTemplate: string;
		paused: boolean;
		waitlistCreated: boolean;
		updatedAt: number;
	}

	let config = $state<DiscordConfig>({
		eventSlug: '',
		attendeeCap: 32,
		registrationDay: 'wed',
		registrationHour: 8,
		registrationMinute: 30,
		announcementTemplate: '',
		paused: false,
		waitlistCreated: false,
		updatedAt: 0
	});

	const SEND_CHANNELS = [
		{ value: 'general',          label: '#general' },
		{ value: 'announcements',    label: '#announcements' },
		{ value: 'talk-to-balrog',   label: '#talk-to-balrog' }
	];

	let pingRunning = $state(false);
	let pingMessage = $state('');
	let pingChannel = $state('general');
	let pingResult = $state<{ ok: boolean; msg: string } | null>(null);

	async function sendPing() {
		if (!pingMessage.trim()) return;
		pingRunning = true;
		pingResult = null;
		const res = await fetch('/api/discord/ping', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: pingMessage.trim(), channel: pingChannel })
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok) {
			const label = SEND_CHANNELS.find(c => c.value === pingChannel)?.label ?? pingChannel;
			pingResult = { ok: true, msg: `Sent to ${label}.` };
			pingMessage = '';
		} else {
			pingResult = { ok: false, msg: (data as { error?: string }).error ?? `HTTP ${res.status}` };
		}
		pingRunning = false;
	}

	let configLoading = $state(true);
	let configSaving = $state(false);
	let configError = $state('');
	let configSaved = $state(false);

	// Form-bound copies so we don't mutate config until save
	let eventSlugInput = $state('');
	let attendeeCapInput = $state<32 | 64>(32);
	let regDayInput = $state('wed');
	let regHourInput = $state(8);
	let regMinuteInput = $state(30);
	let announcementTemplateInput = $state('');

	async function loadConfig() {
		configLoading = true;
		configError = '';
		try {
			const res = await fetch('/api/discord/config');
			if (res.ok) {
				config = await res.json();
				eventSlugInput = config.eventSlug;
				attendeeCapInput = config.attendeeCap;
				regDayInput = config.registrationDay;
				regHourInput = config.registrationHour;
				regMinuteInput = config.registrationMinute;
				announcementTemplateInput = config.announcementTemplate || DEFAULT_TEMPLATE;
			} else {
				const data = await res.json().catch(() => ({}));
				configError = (data as { error?: string }).error ?? `HTTP ${res.status}`;
				announcementTemplateInput = DEFAULT_TEMPLATE;
			}
		} catch (e) {
			configError = e instanceof Error ? e.message : 'Failed to load config.';
			announcementTemplateInput = DEFAULT_TEMPLATE;
		} finally {
			configLoading = false;
		}
	}

	async function saveConfig() {
		configSaving = true;
		configError = '';
		configSaved = false;
		const res = await fetch('/api/discord/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				eventSlug: eventSlugInput.trim(),
				attendeeCap: attendeeCapInput,
				registrationDay: regDayInput,
				registrationHour: Number(regHourInput),
				registrationMinute: Number(regMinuteInput),
				// Only save a custom template if it differs from the default.
			announcementTemplate: announcementTemplateInput.trim() === DEFAULT_TEMPLATE.trim() ? '' : announcementTemplateInput
			})
		});
		if (res.ok) {
			config = await res.json();
			configSaved = true;
			setTimeout(() => (configSaved = false), 3000);
		} else {
			const data = await res.json().catch(() => ({}));
			configError = (data as { error?: string }).error ?? 'Failed to save config.';
		}
		configSaving = false;
	}

	// Extract slug from a full start.gg URL if pasted
	function normaliseSlug(raw: string): string {
		// "https://www.start.gg/tournament/foo/event/bar" → "tournament/foo/event/bar"
		const match = raw.match(/start\.gg\/(tournament\/.+)/);
		return match ? match[1] : raw;
	}

	function onSlugInput(e: Event) {
		const val = (e.target as HTMLInputElement).value;
		eventSlugInput = normaliseSlug(val);
	}

	// ---------------------------------------------------------------------------
	// Pause / Resume bot
	// ---------------------------------------------------------------------------

	let pauseRunning = $state(false);
	let pauseError = $state('');

	async function togglePause() {
		pauseRunning = true;
		pauseError = '';
		const res = await fetch('/api/discord/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ paused: !config.paused })
		});
		if (res.ok) {
			config = await res.json();
		} else {
			const data = await res.json().catch(() => ({}));
			pauseError = (data as { error?: string }).error ?? 'Failed to toggle pause.';
		}
		pauseRunning = false;
	}

	// ---------------------------------------------------------------------------
	// Waitlist flag reset
	// ---------------------------------------------------------------------------

	let resetWaitlistRunning = $state(false);
	let resetWaitlistResult = $state<{ ok: boolean; msg: string } | null>(null);

	async function resetWaitlistFlag() {
		resetWaitlistRunning = true;
		resetWaitlistResult = null;
		const res = await fetch('/api/discord/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ waitlistCreated: false })
		});
		if (res.ok) {
			config = await res.json();
			resetWaitlistResult = { ok: true, msg: 'Waitlist flag reset — monitoring will resume.' };
			setTimeout(() => (resetWaitlistResult = null), 4000);
		} else {
			const data = await res.json().catch(() => ({}));
			resetWaitlistResult = { ok: false, msg: (data as { error?: string }).error ?? 'Failed to reset.' };
		}
		resetWaitlistRunning = false;
	}

	// ---------------------------------------------------------------------------
	// Pre-tournament setup
	// ---------------------------------------------------------------------------

	interface StepResult {
		step: string;
		ok: boolean;
		detail: string;
	}

	let setupRunning = $state(false);
	let setupLog = $state<StepResult[]>([]);
	let setupError = $state('');
	let setupDone = $state(false);
	let setupDry = $state(false);

	async function runPreTournamentSetup() {
		setupRunning = true;
		setupLog = [];
		setupError = '';
		setupDone = false;

		const url = setupDry
			? '/api/discord/pre-tournament-setup?dry=true'
			: '/api/discord/pre-tournament-setup';
		const res = await fetch(url, { method: 'POST' });
		const data = await res.json().catch(() => ({}));

		if (!res.ok) {
			setupError = (data as { error?: string }).error ?? `HTTP ${res.status}`;
		} else {
			const body = data as { ok: boolean; log: StepResult[] };
			setupLog = body.log ?? [];
			setupDone = true;
		}
		setupRunning = false;
	}

	// ---------------------------------------------------------------------------
	// Announcement (manual override)
	// ---------------------------------------------------------------------------

	let announceRunning = $state(false);
	let announceError = $state('');
	let announceDone = $state(false);

	async function sendAnnouncementNow() {
		announceRunning = true;
		announceError = '';
		announceDone = false;

		const res = await fetch('/api/discord/announce', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ test: false })
		});
		const data = await res.json().catch(() => ({}));

		if (!res.ok) {
			announceError = (data as { error?: string }).error ?? `HTTP ${res.status}`;
		} else {
			announceDone = true;
		}
		announceRunning = false;
	}

	// ---------------------------------------------------------------------------
	// Test triggers (all post to test channels)
	// ---------------------------------------------------------------------------

	let testRunning = $state('');
	let testResult = $state<{ ok: boolean; msg: string } | null>(null);

	async function runTest(action: string) {
		testRunning = action;
		testResult = null;
		const res = await fetch('/api/discord/test-trigger', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action })
		});
		const data = await res.json();
		testResult = res.ok
			? { ok: true, msg: data.message ?? JSON.stringify(data) }
			: { ok: false, msg: data.error ?? 'Failed' };
		testRunning = '';
	}

	// ---------------------------------------------------------------------------
	// Derived helpers
	// ---------------------------------------------------------------------------

	let shortSlug = $derived.by(() => {
		const s = config.eventSlug;
		const parts = s.split('/');
		if (parts.length >= 4) return `${parts[1]}/${parts[3]}`;
		return s || '—';
	});

	/** Compute the next scheduled announcement as a human-readable string. */
	let nextAnnouncement = $derived.by(() => {
		const dayLabels: Record<string, string> = {
			mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
			thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
		};
		const day = dayLabels[config.registrationDay] ?? config.registrationDay;
		const h = String(config.registrationHour).padStart(2, '0');
		const m = String(config.registrationMinute).padStart(2, '0');
		return `${day} at ${h}:${m} PST`;
	});

	const DEFAULT_TEMPLATE =
		`@everyone ~ registration for next week's event is open!\n\n` +
		`- {{cap}} player cap.\n` +
		`- for venue access, see: #how-to-get-to-the-venue .\n` +
		`- **:warning: BRING YOUR NINTENDO SWITCHES (DOCK, CONSOLE, POWER CABLE, AND HDMI) WITH GAME CUBE ADAPTERS :warning:**\n` +
		`- if you are trying to register, but we've already reached the cap, please drop your StartGG tag ` +
		`(and say if you can bring a setup) at #add-me-to-the-waitlist once it opens. ` +
		`Are you from out-of-region? If so, you have priority in the waitlist!\n\n` +
		`PS If you can't bring a full setup, but would still like to contribute, _please bring your GCC adapter_.\n\n` +
		`https://start.gg/{{slug}}`;

	const inputClass =
		'mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500';

	const days = [
		{ value: 'mon', label: 'Monday' },
		{ value: 'tue', label: 'Tuesday' },
		{ value: 'wed', label: 'Wednesday' },
		{ value: 'thu', label: 'Thursday' },
		{ value: 'fri', label: 'Friday' },
		{ value: 'sat', label: 'Saturday' },
		{ value: 'sun', label: 'Sunday' }
	];

	onMount(loadConfig);
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Discord Setup</h1>
	<p class="mt-1 text-gray-400">Configure event, automation, and pre-tournament tasks.</p>

	{#if configLoading}
		<div class="mt-8 flex items-center gap-2 text-gray-400">
			<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>
			Loading config…
		</div>
	{:else}

	<!-- ── Status Card ── -->
	<div class="mt-6 rounded-xl border {config.paused ? 'border-amber-800 bg-amber-900/10' : config.eventSlug ? 'border-violet-800 bg-violet-900/10' : 'border-dashed border-gray-700 bg-gray-900/50'} p-4">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<p class="text-xs font-semibold uppercase tracking-wider text-gray-500">Current Event</p>
					{#if config.paused}
						<span class="rounded-full bg-amber-900/40 px-2 py-0.5 text-xs font-semibold text-amber-400 border border-amber-700">PAUSED</span>
					{:else if config.eventSlug}
						<span class="flex items-center gap-1 text-xs text-green-400">
							<span class="inline-block h-1.5 w-1.5 rounded-full bg-green-400"></span>Active
						</span>
					{/if}
				</div>
				{#if config.eventSlug}
					<p class="mt-1 font-mono text-sm text-white break-all">{config.eventSlug}</p>
					<div class="mt-1.5 flex flex-wrap gap-3 text-xs text-gray-400">
						<span>Cap: <span class="text-gray-200">{config.attendeeCap}</span></span>
						<span>Announcement: <span class="text-gray-200">{nextAnnouncement}</span></span>
						<span>Waitlist: <span class="text-gray-200">{config.waitlistCreated ? 'Created' : 'Monitoring (Wed)'}</span></span>
					</div>
				{:else}
					<p class="mt-1 text-sm text-gray-500">No event configured — set one below.</p>
				{/if}
			</div>
			<div class="flex shrink-0 flex-col items-end gap-2">
				<button onclick={loadConfig}
					class="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-violet-600 hover:text-violet-400 transition-colors">
					Refresh
				</button>
				<button onclick={togglePause} disabled={pauseRunning}
					class="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50
						{config.paused
							? 'border-green-700 bg-green-900/20 text-green-300 hover:border-green-600'
							: 'border-amber-700 bg-amber-900/20 text-amber-300 hover:border-amber-600'}">
					{pauseRunning ? '…' : config.paused ? 'Resume Bot' : 'Pause Bot'}
				</button>
			</div>
		</div>
		{#if pauseError}<p class="mt-2 text-xs text-red-400">{pauseError}</p>{/if}
	</div>

	<!-- ── Timeline ── -->
	<div class="mt-8 space-y-0">

	<!-- ── Step 1: Event Configuration ── -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">1</div>
			<div class="mt-1 w-px flex-1 bg-gray-800"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
		<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Event Configuration</p>

		<div class="mt-4 space-y-4">
			<div>
				<label for="event-slug" class="block text-sm font-medium text-gray-300">
					StartGG event URL or slug <span class="text-red-400">*</span>
				</label>
				<p class="mt-0.5 text-xs text-gray-500">
					Paste the full start.gg URL or just the slug like
					<code class="text-gray-400">tournament/micro-132/event/ultimate-singles</code>.
				</p>
				<input
					id="event-slug"
					type="text"
					value={eventSlugInput}
					oninput={onSlugInput}
					placeholder="tournament/microspacing-vancouver-133/event/ultimate-singles"
					class={inputClass}
				/>
				{#if eventSlugInput}
					<p class="mt-1 text-xs text-gray-500">
						Short slug: <span class="text-gray-300">{shortSlug}</span>
					</p>
				{/if}
			</div>

			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="attendee-cap" class="block text-sm font-medium text-gray-300">Attendee cap</label>
					<select id="attendee-cap" bind:value={attendeeCapInput} class={inputClass}>
						<option value={32}>32 (micro)</option>
						<option value={64}>64 (macro)</option>
					</select>
				</div>

				<div>
					<label for="reg-day" class="block text-sm font-medium text-gray-300">
						Announcement day <span class="text-xs text-gray-500">(PST)</span>
					</label>
					<select id="reg-day" bind:value={regDayInput} class={inputClass}>
						{#each days as d}
							<option value={d.value}>{d.label}</option>
						{/each}
					</select>
				</div>

				<div>
					<label for="reg-hour" class="block text-sm font-medium text-gray-300">Hour (0–23 PST)</label>
					<input
						id="reg-hour"
						type="number"
						min="0"
						max="23"
						bind:value={regHourInput}
						class={inputClass}
					/>
				</div>

				<div>
					<label for="reg-minute" class="block text-sm font-medium text-gray-300">Minute (0–59)</label>
					<input
						id="reg-minute"
						type="number"
						min="0"
						max="59"
						bind:value={regMinuteInput}
						class={inputClass}
					/>
				</div>
			</div>

			<!-- Announcement template -->
			<div>
				<label for="announce-template" class="block text-sm font-medium text-gray-300">
					Announcement message template
				</label>
				<p class="mt-0.5 text-xs text-gray-500">
					Leave blank to use the default message.
					<code class="text-gray-400">&#123;&#123;slug&#125;&#125;</code> and
					<code class="text-gray-400">&#123;&#123;cap&#125;&#125;</code> will be replaced.
				</p>
				<textarea
					id="announce-template"
					bind:value={announcementTemplateInput}
					rows={8}
					placeholder={"Leave blank to use the default message. Supports {{slug}} and {{cap}}."}
					class="mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
				></textarea>
				<div class="mt-1 flex items-center justify-between gap-3">
					{#if announcementTemplateInput.trim() && announcementTemplateInput.trim() !== DEFAULT_TEMPLATE.trim()}
						<p class="text-xs text-amber-500">Custom template active — default message will not be used.</p>
					{:else}
						<p class="text-xs text-gray-600">Using default message.</p>
					{/if}
					{#if announcementTemplateInput.trim() !== DEFAULT_TEMPLATE.trim()}
						<button
							type="button"
							onclick={() => (announcementTemplateInput = DEFAULT_TEMPLATE)}
							class="shrink-0 text-xs text-gray-500 hover:text-gray-300 transition-colors"
						>
							Revert to default
						</button>
					{/if}
				</div>
			</div>

			{#if configError}
				<div class="rounded-lg border border-red-800 bg-red-900/30 p-3 text-sm text-red-400">
					{configError}
				</div>
			{/if}

			<div class="flex items-center gap-3">
				<button
					type="button"
					onclick={saveConfig}
					disabled={configSaving}
					class="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
				>
					{configSaving ? 'Saving…' : 'Save Config'}
				</button>

				{#if configSaved}
					<span class="text-sm text-green-400">Saved.</span>
				{/if}

				{#if config.updatedAt}
					<span class="ml-auto text-xs text-gray-600">
						Last saved {new Date(config.updatedAt).toLocaleString()}
					</span>
				{/if}
			</div>
		</div>
	</div>
	</div>

	<!-- ── Step 2: Pre-Tournament Setup ── -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">2</div>
			<div class="mt-1 w-px flex-1 bg-gray-800"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
		<p class="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Pre-Tournament Setup</p>
		<p class="mb-3 text-xs text-gray-500">Lock old threads, create forum posts for top-8 graphic, drop-outs, and priority registration.</p>

		{#if !config.eventSlug}
			<div class="mt-4 rounded-lg border border-yellow-800 bg-yellow-900/20 p-3 text-sm text-yellow-400">
				Set and save an event slug above before running setup.
			</div>
		{:else}
			<div class="mt-4 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
				<p class="text-sm text-gray-400">
					Event: <span class="font-mono text-gray-200">{config.eventSlug}</span>
				</p>
				<p class="mt-0.5 text-sm text-gray-400">
					Cap: <span class="text-gray-200">{config.attendeeCap} players</span>
				</p>
			</div>

			<div class="mt-4 flex flex-wrap items-center gap-3">
				<button
					type="button"
					onclick={runPreTournamentSetup}
					disabled={setupRunning}
					class="rounded-lg {setupDry ? 'bg-gray-700 hover:bg-gray-600' : 'bg-violet-600 hover:bg-violet-500'} px-5 py-2 text-sm font-medium text-white disabled:opacity-50 transition-colors"
				>
					{setupRunning ? 'Running…' : setupDry ? 'Dry Run' : 'Run Pre-Tournament Setup'}
				</button>

				<label class="flex cursor-pointer items-center gap-2 text-sm text-gray-400 select-none">
					<input
						type="checkbox"
						bind:checked={setupDry}
						class="h-4 w-4 rounded border-gray-600 bg-gray-800 accent-violet-500"
					/>
					Dry run (uses test channels)
				</label>
			</div>
		{/if}

		{#if setupError}
			<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-3 text-sm text-red-400">
				{setupError}
			</div>
		{/if}

		{#if setupLog.length > 0}
			<div class="mt-4 space-y-1.5">
				{#each setupLog as step}
					<div
						class="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm
							{step.ok
								? 'border-green-800 bg-green-900/10'
								: 'border-red-800 bg-red-900/10'}"
					>
						<span class="mt-0.5 shrink-0 {step.ok ? 'text-green-400' : 'text-red-400'}">
							{step.ok ? '✓' : '✗'}
						</span>
						<div class="min-w-0">
							<div class="font-medium {step.ok ? 'text-green-300' : 'text-red-300'}">{step.step}</div>
							<div class="text-xs text-gray-400">{step.detail}</div>
						</div>
					</div>
				{/each}

				{#if setupDone}
					{@const allOk = setupLog.every((s) => s.ok)}
					<div
						class="mt-2 rounded-lg border px-4 py-3 text-sm font-medium
							{allOk
								? 'border-green-700 bg-green-900/20 text-green-300'
								: 'border-yellow-700 bg-yellow-900/20 text-yellow-300'}"
					>
						{#if setupDry}
							Dry run complete — actions ran against test channels.
						{:else}
							{allOk ? 'All steps completed successfully.' : 'Setup finished with some errors — see above.'}
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</div>
	</div>

	<!-- ── Step 3: Automation (Announcement + Waitlist) ── -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">3</div>
			<div class="mt-1 w-px flex-1 bg-gray-800"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
		<p class="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Automation</p>

		<!-- Announcement -->
		<div class="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium text-white">Registration Announcement</p>
					<div class="mt-1 flex items-center gap-2 text-xs text-gray-500">
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-violet-500"></span>
						{nextAnnouncement} <span class="text-gray-600">(automatic via Vercel cron)</span>
					</div>
				</div>
				<div>

		{#if config.eventSlug}
					<button onclick={sendAnnouncementNow} disabled={announceRunning}
						class="rounded-lg border border-amber-700 bg-amber-900/20 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-600 disabled:opacity-50 transition-colors">
						{announceRunning ? 'Sending…' : 'Send Now'}
					</button>
				{/if}
				</div>
			</div>
			{#if announceError}<p class="mt-2 text-xs text-red-400">{announceError}</p>{/if}
			{#if announceDone}<p class="mt-2 text-xs text-green-400">Sent to #announcements.</p>{/if}
		</div>

		<!-- Waitlist Monitoring -->
		<div class="mt-3 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium text-white">Waitlist Monitoring</p>
					<p class="mt-1 text-xs text-gray-500">Checks every 5 min on Wednesdays via QStash. Auto-creates waitlist forum when cap is hit.</p>
					<div class="mt-1.5">
						{#if !config.eventSlug}
							<span class="inline-flex items-center gap-1.5 text-xs text-gray-500">
								<span class="inline-block h-1.5 w-1.5 rounded-full bg-gray-600"></span>No event set
							</span>
						{:else if config.paused}
							<span class="inline-flex items-center gap-1.5 text-xs text-amber-400">
								<span class="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"></span>Paused
							</span>
						{:else if config.waitlistCreated}
							<span class="inline-flex items-center gap-1.5 text-xs text-blue-400">
								<span class="inline-block h-1.5 w-1.5 rounded-full bg-blue-500"></span>Waitlist created
							</span>
						{:else}
							<span class="inline-flex items-center gap-1.5 text-xs text-green-400">
								<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"></span>Active
							</span>
						{/if}
					</div>
				</div>
				{#if config.eventSlug && config.waitlistCreated}
					<button onclick={resetWaitlistFlag} disabled={resetWaitlistRunning}
						class="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-violet-600 hover:text-violet-400 disabled:opacity-40 transition-colors">
						{resetWaitlistRunning ? 'Resetting…' : 'Reset Flag'}
					</button>
				{/if}
			</div>
			{#if resetWaitlistResult}
				<p class="mt-2 text-xs {resetWaitlistResult.ok ? 'text-green-400' : 'text-red-400'}">{resetWaitlistResult.msg}</p>
			{/if}
		</div>
	</div>
	</div>

	<!-- ── Step 4: Testing ── -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">T</div>
			<div class="mt-1 w-px flex-1 bg-gray-800"></div>
		</div>
		<div class="pb-6 pt-1 min-w-0 flex-1">
		<p class="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Testing</p>
		<p class="mb-3 text-xs text-gray-500">All tests post to #talk-to-balrog or the test waitlist channel — never real channels.</p>

		<div class="grid gap-2 sm:grid-cols-2">
			<button onclick={() => runTest('announcement')} disabled={!!testRunning}
				class="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-left transition-colors hover:border-violet-600 disabled:opacity-50">
				<div class="text-sm font-medium text-white">Test Announcement</div>
				<div class="mt-0.5 text-xs text-gray-500">Posts to #talk-to-balrog</div>
			</button>
			<button onclick={() => runTest('attendee-check')} disabled={!!testRunning}
				class="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-left transition-colors hover:border-violet-600 disabled:opacity-50">
				<div class="text-sm font-medium text-white">Test Attendee Check</div>
				<div class="mt-0.5 text-xs text-gray-500">Checks count, no posting</div>
			</button>
			<button onclick={() => runTest('waitlist-test')} disabled={!!testRunning}
				class="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-left transition-colors hover:border-violet-600 disabled:opacity-50">
				<div class="text-sm font-medium text-white">Test Waitlist</div>
				<div class="mt-0.5 text-xs text-gray-500">Forum post in test channel</div>
			</button>
			<button onclick={() => runTest('motivational')} disabled={!!testRunning}
				class="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-left transition-colors hover:border-violet-600 disabled:opacity-50">
				<div class="text-sm font-medium text-white">Test Motivational</div>
				<div class="mt-0.5 text-xs text-gray-500">Posts to #talk-to-balrog</div>
			</button>
		</div>
		{#if testRunning}<p class="mt-2 text-xs text-gray-400 animate-pulse">Running {testRunning}...</p>{/if}
		{#if testResult}<p class="mt-2 text-xs {testResult.ok ? 'text-green-400' : 'text-red-400'}">{testResult.msg}</p>{/if}
	</div>
	</div>

	<!-- ── Tools ── -->
	<div class="flex gap-4">
		<div class="flex flex-col items-center">
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">∞</div>
		</div>
		<div class="pb-2 pt-1 min-w-0 flex-1">
		<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Tools</p>
		<div class="flex gap-2">
			<select bind:value={pingChannel}
				class="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-gray-300 focus:border-violet-500 focus:outline-none">
				{#each SEND_CHANNELS as ch}
					<option value={ch.value}>{ch.label}</option>
				{/each}
			</select>
			<input type="text" bind:value={pingMessage} placeholder="Send a message…"
				onkeydown={(e) => e.key === 'Enter' && sendPing()}
				class="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none" />
			<button onclick={sendPing} disabled={pingRunning || !pingMessage.trim()}
				class="rounded-lg border border-gray-700 px-4 py-1.5 text-sm text-gray-400 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50 transition-colors">
				{pingRunning ? '…' : 'Send'}
			</button>
		</div>
		{#if pingResult}<p class="mt-1.5 text-xs {pingResult.ok ? 'text-green-400' : 'text-red-400'}">{pingResult.msg}</p>{/if}
	</div>
	</div>

	</div><!-- end timeline -->

	{/if}
</main>
