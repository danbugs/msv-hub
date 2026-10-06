<script lang="ts">
	import { onMount } from 'svelte';
	import type { AttendeeStatus } from '$lib/types/tournament';
	import { buildNoShowPing, PING_CHANNELS, type PingChannel } from '$lib/attendance-ping';

	let attendance = $state<AttendeeStatus[]>([]);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state('');
	let togglesInFlight = $state(0);
	// Bumped on every local toggle so a poll that started earlier is discarded.
	let localEdits = 0;
	let pinging = $state(false);
	let pingResult = $state('');
	let pingChannel = $state<PingChannel>('general');
	let pingTest = $state(false);

	let setupCount = $derived(attendance.filter((a) => a.pledgedSetup).length);
	let presentCount = $derived(attendance.filter((a) => a.present).length);
	let setupDeployedCount = $derived(attendance.filter((a) => a.setupDeployed).length);
	let lateCount = $derived(attendance.filter((a) => a.late).length);
	let accountedCount = $derived(attendance.filter((a) => a.present || a.late).length);
	let setupsNeeded = $derived(Math.max(0, 16 - setupCount - 2)); // -2 for venue setups

	async function initialLoad() {
		loading = true;
		const res = await fetch('/api/tournament/attendance');
		if (res.ok) {
			const data = await res.json();
			attendance = data.attendance;
		}
		// If no cached attendance, auto-refresh from StartGG
		if (attendance.length === 0) {
			await refreshFromStartGG();
		}
		loading = false;
	}

	onMount(() => {
		initialLoad();
		// Pick up other TOs' toggles; skip while our own writes are pending so
		// an in-flight optimistic update isn't briefly reverted.
		const poll = setInterval(async () => {
			if (document.hidden || togglesInFlight > 0 || refreshing) return;
			const startedAt = localEdits;
			try {
				const r = await fetch('/api/tournament/attendance');
				if (!r.ok) return;
				const next = (await r.json()).attendance;
				if (startedAt === localEdits && togglesInFlight === 0 && !refreshing) attendance = next;
			} catch { /* venue wifi — retry next tick */ }
		}, 10_000);
		return () => clearInterval(poll);
	});

	let pingPreview = $derived(buildNoShowPing(attendance));

	async function pingNoShows() {
		if (!pingPreview) return;
		pinging = true;
		pingResult = '';
		error = '';
		// Ask the server for the exact message: it fills Discord IDs from StartGG
		// that the local attendance list may not have yet.
		const pre = await fetch('/api/tournament/attendance/ping', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ channel: pingChannel, test: pingTest, preview: true })
		});
		const p = await pre.json().catch(() => ({}));
		if (!pre.ok) { error = p.error ?? 'Ping preview failed'; pinging = false; return; }
		const label = PING_CHANNELS.find((c) => c.value === pingChannel)?.label;
		const msg = (pingTest ? 'TEST MODE — nobody will be notified.\n\n' : '') + `Balrog will post in ${label}:\n\n"${p.content}"\n\n` +
			`${p.mentioned} pinged on Discord` + (p.unlinked?.length ? `, ${p.unlinked.length} listed by tag (no Discord on start.gg)` : '') + '. Send?';
		if (!confirm(msg)) { pinging = false; return; }
		const res = await fetch('/api/tournament/attendance/ping', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ channel: pingChannel, test: pingTest })
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok && data.test) pingResult = `Test message posted — would have pinged ${data.mentioned} on Discord${data.unlinked?.length ? `, listed ${data.unlinked.length} by tag` : ''}.`;
		else if (res.ok) pingResult = `Pinged ${data.mentioned} on Discord${data.unlinked?.length ? `, listed ${data.unlinked.length} by tag` : ''}.`;
		else error = data.error ?? 'Ping failed';
		pinging = false;
	}

	async function refreshFromStartGG() {
		refreshing = true;
		error = '';
		const res = await fetch('/api/tournament/attendance', { method: 'POST' });
		const data = await res.json();
		if (res.ok) {
			attendance = data.attendance;
		} else {
			error = data.error ?? 'Refresh failed';
		}
		refreshing = false;
	}

	async function toggleFlag(gamerTag: string, flag: 'present' | 'setupDeployed' | 'late') {
		const attendee = attendance.find((a) => a.gamerTag === gamerTag);
		if (!attendee) return;
		const newValue = !attendee[flag];
		const before = { ...attendee };
		togglesInFlight++;
		localEdits++;

		// Optimistic update. Marking late/present are mutually exclusive.
		attendance = attendance.map((a) => {
			if (a.gamerTag !== gamerTag) return a;
			const patch: Partial<AttendeeStatus> = { [flag]: newValue };
			if (newValue && flag === 'present') patch.late = false;
			if (newValue && flag === 'late') patch.present = false;
			return { ...a, ...patch };
		});

		const body: Record<string, unknown> = { gamerTag, [flag]: newValue };
		if (newValue && flag === 'present') body.late = false;
		if (newValue && flag === 'late') body.present = false;

		try {
			const res = await fetch('/api/tournament/attendance', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error();
		} catch {
			// Revert all flags touched, including the cleared present/late counterpart
			attendance = attendance.map((a) => (a.gamerTag === gamerTag ? before : a));
		} finally {
			togglesInFlight--;
		}
	}
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-primary hover:text-primary/80">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-foreground">Attendance & Setups</h1>
	<p class="mt-1 text-muted-foreground">Track who's here and who brought a setup.</p>

	{#if error}
		<div class="mt-4 rounded-lg border border-destructive-border bg-destructive-muted px-4 py-3 text-sm text-destructive break-words">
			{error}
		</div>
	{/if}

	<!-- Summary cards -->
	<div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
		<div class="rounded-lg border border-border bg-card p-3 text-center">
			<div class="text-2xl font-bold text-foreground">{attendance.length}</div>
			<div class="text-xs text-muted-foreground">Registered</div>
		</div>
		<div class="rounded-lg border border-border bg-card p-3 text-center">
			<div class="text-2xl font-bold text-success">{presentCount}</div>
			<div class="text-xs text-muted-foreground">Present</div>
		</div>
		<div class="rounded-lg border border-border bg-card p-3 text-center">
			<div class="text-2xl font-bold text-info">{lateCount}</div>
			<div class="text-xs text-muted-foreground">Late ({accountedCount} accounted)</div>
		</div>
		<div class="rounded-lg border border-border bg-card p-3 text-center">
			<div class="text-2xl font-bold {setupCount + 2 >= 16 ? 'text-success' : 'text-warning'}">{setupCount + 2}</div>
			<div class="text-xs text-muted-foreground">Setups pledged (+2 venue)</div>
		</div>
		<div class="rounded-lg border border-border bg-card p-3 text-center">
			<div class="text-2xl font-bold text-primary">{setupDeployedCount}</div>
			<div class="text-xs text-muted-foreground">Deployed</div>
		</div>
	</div>

	{#if setupsNeeded > 0}
		<div class="mt-3 rounded-lg border border-warning-border bg-warning-muted p-3 text-sm text-warning">
			Need <strong>{setupsNeeded} more setup{setupsNeeded > 1 ? 's' : ''}</strong> to reach 16 for Swiss.
		</div>
	{/if}

	<!-- Actions -->
	<div class="mt-4 flex flex-wrap items-center gap-3">
		<button onclick={refreshFromStartGG} disabled={refreshing}
			class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
			{refreshing ? 'Refreshing...' : 'Refresh from StartGG'}
		</button>
		<span class="flex-1"></span>
		<select bind:value={pingChannel} aria-label="Channel to ping in"
			class="rounded-lg border border-input bg-secondary px-2 py-1.5 text-sm text-foreground">
			{#each PING_CHANNELS as c}<option value={c.value}>{c.label}</option>{/each}
		</select>
		<label class="flex items-center gap-1.5 text-sm text-muted-foreground">
			<input type="checkbox" bind:checked={pingTest} /> Test, don't notify anyone
		</label>
		<button onclick={pingNoShows} disabled={pinging || !pingPreview}
			title="Balrog pings everyone not marked Present or Late"
			class="rounded-lg border border-primary/40 px-4 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50">
			{pinging ? 'Pinging…' : `${pingTest ? 'Test ping' : 'Ping'} no-shows (${pingPreview ? pingPreview.mentionIds.length + pingPreview.unlinked.length : 0})`}
		</button>
	</div>
	{#if pingResult}
		<p class="mt-2 text-sm text-success">{pingResult}</p>
	{/if}

	<!-- Attendee list -->
	{#if loading}
		<div class="mt-6 text-muted-foreground animate-pulse">Loading...</div>
	{:else}
		<div class="mt-6 overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border text-left text-muted-foreground">
						<th class="px-2 py-2">Player</th>
						<th class="px-2 py-2 text-center w-20">Setup</th>
						<th class="px-2 py-2 text-center w-20">Present</th>
						<th class="px-2 py-2 text-center w-20">Late</th>
						<th class="px-2 py-2 text-center w-20">Deployed</th>
						<th class="px-2 py-2 text-right text-xs">Registered</th>
					</tr>
				</thead>
				<tbody>
					{#each attendance.toSorted((a, b) => {
						// Sort: pledged setup first, then by name
						if (a.pledgedSetup !== b.pledgedSetup) return a.pledgedSetup ? -1 : 1;
						return a.gamerTag.localeCompare(b.gamerTag);
					}) as attendee}
						<tr class="border-b border-border {attendee.present ? 'bg-success-muted' : attendee.late ? 'bg-info-muted' : ''}">
							<td class="px-2 py-1.5">
								<span class="text-foreground truncate">{attendee.gamerTag}</span>
								{#if attendee.pledgedSetup}
									<span class="ml-1 text-xs text-warning">setup</span>
								{/if}
							</td>
							<td class="px-2 py-1.5 text-center">
								{#if attendee.pledgedSetup}
									<span class="text-success">✓</span>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/if}
							</td>
							<td class="px-2 py-1.5 text-center">
								<button onclick={() => toggleFlag(attendee.gamerTag, 'present')}
									class="rounded px-2 py-0.5 text-xs transition-colors
										{attendee.present ? 'bg-green-700/40 text-success' : 'bg-secondary text-muted-foreground hover:text-foreground'}">
									{attendee.present ? '✓ Here' : 'Mark'}
								</button>
							</td>
							<td class="px-2 py-1.5 text-center">
								<button onclick={() => toggleFlag(attendee.gamerTag, 'late')}
									class="rounded px-2 py-0.5 text-xs transition-colors
										{attendee.late ? 'bg-sky-700/40 text-info' : 'bg-secondary text-muted-foreground hover:text-foreground'}">
									{attendee.late ? '⏰ Late' : 'Mark'}
								</button>
							</td>
							<td class="px-2 py-1.5 text-center">
								{#if attendee.pledgedSetup}
									<button onclick={() => toggleFlag(attendee.gamerTag, 'setupDeployed')}
										class="rounded px-2 py-0.5 text-xs transition-colors
											{attendee.setupDeployed ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground hover:text-foreground'}">
										{attendee.setupDeployed ? '✓ Up' : 'Mark'}
									</button>
								{/if}
							</td>
							<td class="px-2 py-1.5 text-right text-xs text-muted-foreground">
								{attendee.registeredAt ?? ''}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</main>
