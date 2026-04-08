<script lang="ts">
	import { onMount } from 'svelte';
	import type { AttendeeStatus } from '$lib/types/tournament';

	let attendance = $state<AttendeeStatus[]>([]);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state('');

	let setupCount = $derived(attendance.filter((a) => a.pledgedSetup).length);
	let presentCount = $derived(attendance.filter((a) => a.present).length);
	let setupDeployedCount = $derived(attendance.filter((a) => a.setupDeployed).length);
	let setupsNeeded = $derived(Math.max(0, 16 - setupCount - 1)); // -1 for venue setup

	onMount(loadAttendance);

	async function loadAttendance() {
		loading = true;
		const res = await fetch('/api/tournament/attendance');
		if (res.ok) {
			const data = await res.json();
			attendance = data.attendance;
		}
		loading = false;
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

	async function toggleFlag(gamerTag: string, flag: 'present' | 'setupDeployed') {
		const attendee = attendance.find((a) => a.gamerTag === gamerTag);
		if (!attendee) return;
		const newValue = !attendee[flag];

		// Optimistic update
		attendance = attendance.map((a) =>
			a.gamerTag === gamerTag ? { ...a, [flag]: newValue } : a
		);

		const res = await fetch('/api/tournament/attendance', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ gamerTag, [flag]: newValue })
		});
		if (!res.ok) {
			// Revert
			attendance = attendance.map((a) =>
				a.gamerTag === gamerTag ? { ...a, [flag]: !newValue } : a
			);
		}
	}
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Attendance & Setups</h1>
	<p class="mt-1 text-gray-400">Track who's here and who brought a setup.</p>

	{#if error}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-400">
			{error}
		</div>
	{/if}

	<!-- Summary cards -->
	<div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="rounded-lg border border-gray-800 bg-gray-900 p-3 text-center">
			<div class="text-2xl font-bold text-white">{attendance.length}</div>
			<div class="text-xs text-gray-500">Registered</div>
		</div>
		<div class="rounded-lg border border-gray-800 bg-gray-900 p-3 text-center">
			<div class="text-2xl font-bold text-green-400">{presentCount}</div>
			<div class="text-xs text-gray-500">Present</div>
		</div>
		<div class="rounded-lg border border-gray-800 bg-gray-900 p-3 text-center">
			<div class="text-2xl font-bold {setupCount >= 16 ? 'text-green-400' : 'text-amber-400'}">{setupCount + 1}</div>
			<div class="text-xs text-gray-500">Setups pledged (+1 venue)</div>
		</div>
		<div class="rounded-lg border border-gray-800 bg-gray-900 p-3 text-center">
			<div class="text-2xl font-bold text-violet-400">{setupDeployedCount}</div>
			<div class="text-xs text-gray-500">Deployed</div>
		</div>
	</div>

	{#if setupsNeeded > 0}
		<div class="mt-3 rounded-lg border border-amber-700 bg-amber-900/20 p-3 text-sm text-amber-300">
			Need <strong>{setupsNeeded} more setup{setupsNeeded > 1 ? 's' : ''}</strong> to reach 16 for Swiss.
		</div>
	{/if}

	<!-- Actions -->
	<div class="mt-4 flex items-center gap-3">
		<button onclick={refreshFromStartGG} disabled={refreshing}
			class="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
			{refreshing ? 'Refreshing...' : 'Refresh from StartGG'}
		</button>
	</div>

	<!-- Attendee list -->
	{#if loading}
		<div class="mt-6 text-gray-400 animate-pulse">Loading...</div>
	{:else}
		<div class="mt-6">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-gray-700 text-left text-gray-400">
						<th class="px-2 py-2">Player</th>
						<th class="px-2 py-2 text-center w-20">Setup</th>
						<th class="px-2 py-2 text-center w-20">Present</th>
						<th class="px-2 py-2 text-center w-20">Deployed</th>
						<th class="px-2 py-2 text-right text-xs">Registered</th>
					</tr>
				</thead>
				<tbody>
					{#each attendance.sort((a, b) => {
						// Sort: pledged setup first, then by name
						if (a.pledgedSetup !== b.pledgedSetup) return a.pledgedSetup ? -1 : 1;
						return a.gamerTag.localeCompare(b.gamerTag);
					}) as attendee}
						<tr class="border-b border-gray-800 {attendee.present ? 'bg-green-950/20' : ''}">
							<td class="px-2 py-1.5">
								<span class="text-white">{attendee.gamerTag}</span>
								{#if attendee.pledgedSetup}
									<span class="ml-1 text-xs text-amber-400">setup</span>
								{/if}
							</td>
							<td class="px-2 py-1.5 text-center">
								{#if attendee.pledgedSetup}
									<span class="text-green-400">✓</span>
								{:else}
									<span class="text-gray-600">—</span>
								{/if}
							</td>
							<td class="px-2 py-1.5 text-center">
								<button onclick={() => toggleFlag(attendee.gamerTag, 'present')}
									class="rounded px-2 py-0.5 text-xs transition-colors
										{attendee.present ? 'bg-green-700/40 text-green-300' : 'bg-gray-800 text-gray-500 hover:text-white'}">
									{attendee.present ? '✓ Here' : 'Mark'}
								</button>
							</td>
							<td class="px-2 py-1.5 text-center">
								{#if attendee.pledgedSetup}
									<button onclick={() => toggleFlag(attendee.gamerTag, 'setupDeployed')}
										class="rounded px-2 py-0.5 text-xs transition-colors
											{attendee.setupDeployed ? 'bg-violet-700/40 text-violet-300' : 'bg-gray-800 text-gray-500 hover:text-white'}">
										{attendee.setupDeployed ? '✓ Up' : 'Mark'}
									</button>
								{/if}
							</td>
							<td class="px-2 py-1.5 text-right text-xs text-gray-500">
								{attendee.registeredAt ?? ''}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</main>
