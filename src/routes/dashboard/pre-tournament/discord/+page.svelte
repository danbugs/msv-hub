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
		updatedAt: number;
	}

	let config = $state<DiscordConfig>({
		eventSlug: '',
		attendeeCap: 32,
		registrationDay: 'wed',
		registrationHour: 8,
		registrationMinute: 30,
		updatedAt: 0
	});

	let pingRunning = $state(false);
	let pingResult = $state<{ ok: boolean; msg: string } | null>(null);

	async function sendPing() {
		pingRunning = true;
		pingResult = null;
		const res = await fetch('/api/discord/ping', { method: 'POST' });
		const data = await res.json().catch(() => ({}));
		if (res.ok) {
			pingResult = { ok: true, msg: 'Message sent! Check the test channel.' };
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

	async function loadConfig() {
		configLoading = true;
		configError = '';
		const res = await fetch('/api/discord/config');
		if (res.ok) {
			config = await res.json();
			eventSlugInput = config.eventSlug;
			attendeeCapInput = config.attendeeCap;
			regDayInput = config.registrationDay;
			regHourInput = config.registrationHour;
			regMinuteInput = config.registrationMinute;
		} else {
			configError = 'Failed to load config.';
		}
		configLoading = false;
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
				registrationMinute: Number(regMinuteInput)
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
	// Announcement
	// ---------------------------------------------------------------------------

	let announceRunning = $state(false);
	let announceError = $state('');
	let announceDone = $state(false);
	let announcedTest = $state(false);

	async function sendAnnouncement(test: boolean) {
		announceRunning = true;
		announceError = '';
		announceDone = false;
		announcedTest = test;

		const res = await fetch('/api/discord/announce', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ test })
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
	// Derived helpers
	// ---------------------------------------------------------------------------

	let shortSlug = $derived.by(() => {
		const s = config.eventSlug;
		const parts = s.split('/');
		if (parts.length >= 4) return `${parts[1]}/${parts[3]}`;
		return s || '—';
	});

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
	<p class="mt-1 text-gray-400">
		Lock threads, create forum posts, and announce events — replacing Balrog's
		<code class="rounded bg-gray-800 px-1 py-0.5 text-xs text-violet-300">!do_pre_tournament_setup</code>.
	</p>

	<!-- Connectivity test -->
	<div class="mt-4 flex flex-wrap items-center gap-3">
		<button
			type="button"
			onclick={sendPing}
			disabled={pingRunning}
			class="rounded-lg border border-gray-700 px-4 py-1.5 text-sm text-gray-400 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50 transition-colors"
		>
			{pingRunning ? 'Sending…' : 'Say Hello'}
		</button>
		{#if pingResult}
			<span class="text-sm {pingResult.ok ? 'text-green-400' : 'text-red-400'}">{pingResult.msg}</span>
		{/if}
	</div>

	{#if configLoading}
		<div class="mt-8 flex items-center gap-2 text-gray-400">
			<div class="h-2 w-2 rounded-full bg-violet-500 animate-pulse"></div>
			Loading config…
		</div>
	{:else}

	<!-- Current event status card (!check_current_event) -->
	<div class="mt-6 rounded-xl border {config.eventSlug ? 'border-violet-800 bg-violet-900/10' : 'border-dashed border-gray-700 bg-gray-900/50'} p-4">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<p class="text-xs font-semibold uppercase tracking-wider text-gray-500">Current Event</p>
				{#if config.eventSlug}
					<p class="mt-1 font-mono text-sm text-white break-all">{config.eventSlug}</p>
					<div class="mt-1.5 flex flex-wrap gap-3 text-xs text-gray-400">
						<span>Cap: <span class="text-gray-200">{config.attendeeCap}</span></span>
						<span>Reg: <span class="text-gray-200">{days.find(d => d.value === config.registrationDay)?.label} {String(config.registrationHour).padStart(2,'0')}:{String(config.registrationMinute).padStart(2,'0')} PST</span></span>
						{#if config.updatedAt}
							<span>Updated: <span class="text-gray-200">{new Date(config.updatedAt).toLocaleString()}</span></span>
						{/if}
					</div>
				{:else}
					<p class="mt-1 text-sm text-gray-500">No event configured yet.</p>
				{/if}
			</div>
			<button
				type="button"
				onclick={loadConfig}
				class="shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-violet-600 hover:text-violet-400 transition-colors"
			>
				Refresh
			</button>
		</div>
	</div>

	<!-- =========================================================
	     Section 1: Config
	     ========================================================= -->
	<section class="mt-8">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Event Configuration</h2>
		<p class="mt-1 text-xs text-gray-500">Saved to Redis — persists across sessions.</p>

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
	</section>

	<!-- =========================================================
	     Section 2: Pre-tournament setup
	     ========================================================= -->
	<section class="mt-10">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Pre-Tournament Setup</h2>
		<p class="mt-1 text-xs text-gray-500">
			Equivalent to <code class="text-gray-400">!do_pre_tournament_setup</code>. Locks old threads and
			creates new forum posts for top-8 graphic, drop-outs, and priority registration.
		</p>

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
					Dry run (simulate, no Discord calls)
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
							Dry run complete — no Discord calls were made.
						{:else}
							{allOk ? 'All steps completed successfully.' : 'Setup finished with some errors — see above.'}
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- =========================================================
	     Section 3: Registration Announcement
	     ========================================================= -->
	<section class="mt-10">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Registration Announcement</h2>
		<p class="mt-1 text-xs text-gray-500">
			Posts the registration-open message to the announcement channel. Normally sent automatically
			on {days.find((d) => d.value === config.registrationDay)?.label ?? config.registrationDay}
			at {String(config.registrationHour).padStart(2, '0')}:{String(config.registrationMinute).padStart(2, '0')} PST —
			use this to send it manually or to test.
		</p>

		{#if !config.eventSlug}
			<div class="mt-4 rounded-lg border border-yellow-800 bg-yellow-900/20 p-3 text-sm text-yellow-400">
				Set and save an event slug above before sending an announcement.
			</div>
		{:else}
			<div class="mt-4 flex flex-wrap gap-3">
				<button
					type="button"
					onclick={() => sendAnnouncement(false)}
					disabled={announceRunning}
					class="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors"
				>
					{announceRunning && !announcedTest ? 'Sending…' : 'Send Announcement'}
				</button>

				<button
					type="button"
					onclick={() => sendAnnouncement(true)}
					disabled={announceRunning}
					class="rounded-lg border border-gray-700 px-5 py-2 text-sm text-gray-300 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50 transition-colors"
				>
					{announceRunning && announcedTest ? 'Sending…' : 'Send to Test Channel'}
				</button>
			</div>
		{/if}

		{#if announceError}
			<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-3 text-sm text-red-400">
				{announceError}
			</div>
		{/if}

		{#if announceDone}
			<div class="mt-4 rounded-lg border border-green-700 bg-green-900/20 p-3 text-sm text-green-400">
				Announcement sent{announcedTest ? ' to test channel' : ''}.
			</div>
		{/if}

		<!-- Message preview -->
		{#if config.eventSlug}
			<details class="mt-6 rounded-lg border border-gray-800 bg-gray-900">
				<summary class="cursor-pointer px-4 py-2 text-sm text-gray-400 hover:text-gray-300">
					Preview announcement message
				</summary>
				<pre class="whitespace-pre-wrap px-4 py-3 text-xs text-gray-400 leading-relaxed"
					>@everyone ~ registration for next week's event is open!

- {config.attendeeCap} player cap.
- for venue access, see: #how-to-get-to-the-venue .
- **⚠️ BRING YOUR NINTENDO SWITCHES (DOCK, CONSOLE, POWER CABLE, AND HDMI) WITH GAME CUBE ADAPTERS ⚠️**{config.attendeeCap === 32
						? ' (running Swiss is dependent on having at least 20 setups; otherwise, we\'ll do normal Redemption). We\'ve got monitors.'
						: ''}
- if you are trying to register, but we've already reached the cap, please drop your StartGG tag (and say if you can bring a setup) at #add-me-to-the-waitlist once it opens. Are you from out-of-region? If so, you have priority in the waitlist!

PS If you can't bring a full setup, but would still like to contribute, please bring your GCC adapter. There are some people that can bring full setups but only play w/ pro cons., so it's always best to have extras.

https://start.gg/{config.eventSlug}</pre>
			</details>
		{/if}
	</section>

	{/if}
</main>
