<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState } from '$lib/types/tournament';

	let tournament = $state<TournamentState | null | undefined>(undefined);

	onMount(async () => {
		const res = await fetch('/api/tournament');
		tournament = res.ok ? await res.json() : null;
	});

	async function deleteTournament() {
		if (!confirm('Delete the active tournament? This cannot be undone.')) return;
		await fetch('/api/tournament', { method: 'DELETE' });
		tournament = null;
	}

	const sections = [
		{
			title: 'Pre-Tournament',
			items: [
				{ label: 'Discord Setup', href: '/dashboard/pre-tournament/discord', desc: 'Lock threads, create new forum posts, announce event' },
				{ label: 'Seed Event', href: '/dashboard/pre-tournament/seed', desc: 'Elo-based seeding with jitter control' }
			]
		},
		{
			title: 'Post-Tournament',
			items: [
				{ label: 'Results & Export', href: '/dashboard/post-tournament', desc: 'Graphics, VOD, Braacket upload, StartGG sync' },
				{ label: 'League Overview', href: '#', desc: 'Season standings, Elo history, weekly recap — coming soon', disabled: true }
			]
		},
		{
			title: 'Settings',
			items: [
				{ label: 'TO Management', href: '/dashboard/settings', desc: 'Manage tournament organizer access' }
			]
		}
	];
</script>

<main class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold text-white">Dashboard</h1>
	<p class="mt-1 text-gray-400">Microspacing Vancouver — Tournament Operations</p>

	<!-- Active tournament card -->
	{#if tournament !== undefined}
		<div class="mt-6">
			{#if tournament}
				<div class="rounded-xl border border-violet-800 bg-violet-900/10 p-4">
					<div class="flex flex-wrap items-start gap-3">
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<h2 class="font-semibold text-white">{tournament.name}</h2>
								<span class="rounded-full bg-violet-900/60 px-2.5 py-0.5 text-xs font-medium text-violet-300">
									{#if tournament.phase === 'swiss'}
										Swiss R{tournament.currentRound}/{tournament.settings.numRounds}
									{:else if tournament.phase === 'brackets'}
										Brackets
									{:else}
										Completed
									{/if}
								</span>
							</div>
							<p class="mt-0.5 text-sm text-gray-400">
								{tournament.entrants.length} players · {tournament.settings.numStations} stations
								{#if tournament.phase === 'swiss' && tournament.currentRound > 0}
									· {tournament.rounds.filter(r => r.status === 'completed').length} round{tournament.rounds.filter(r => r.status === 'completed').length !== 1 ? 's' : ''} done
								{/if}
							</p>
							<a href="/live/{tournament.slug}" target="_blank"
								class="mt-1 block text-xs text-gray-500 hover:text-violet-400">
								Live page: /live/{tournament.slug} ↗
							</a>
						</div>
						<div class="flex items-center gap-2 shrink-0">
							{#if tournament.phase === 'swiss'}
								<a href="/dashboard/tournament/swiss"
									class="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 transition-colors">
									Manage Swiss
								</a>
							{:else if tournament.phase === 'brackets'}
								<a href="/dashboard/tournament/brackets"
									class="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 transition-colors">
									Manage Brackets
								</a>
							{:else if tournament.phase === 'completed'}
								<a href="/dashboard/tournament/brackets"
									class="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 transition-colors">
									View / Fix Results
								</a>
								<a href="/api/tournament/export?slug={tournament.slug}" target="_blank"
									class="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 hover:border-violet-600 hover:text-violet-400 transition-colors">
									Export JSON
								</a>
							{/if}
							<button onclick={deleteTournament}
								class="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 hover:border-red-700 hover:text-red-400 transition-colors">
								Delete
							</button>
						</div>
					</div>
				</div>
			{:else}
				<div class="rounded-xl border border-dashed border-gray-700 p-4 text-center text-sm text-gray-500">
					No active tournament —
					<a href="/dashboard/pre-tournament/seed" class="text-violet-400 hover:text-violet-300">seed an event to start one</a>
				</div>
			{/if}
		</div>
	{/if}

	<div class="mt-8 grid gap-6 sm:grid-cols-2">
		{#each sections as section}
			<div>
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{section.title}</h2>
				<div class="space-y-2">
					{#each section.items as item}
						{#if (item as any).disabled}
							<div class="block rounded-lg border border-dashed border-gray-800 bg-gray-900/50 p-4 opacity-60 cursor-default">
								<div class="font-medium text-gray-400">{item.label}</div>
								<div class="mt-1 text-sm text-gray-500">{item.desc}</div>
							</div>
						{:else}
							<a href={item.href}
								class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
								<div class="font-medium text-white">{item.label}</div>
								<div class="mt-1 text-sm text-gray-400">{item.desc}</div>
							</a>
						{/if}
					{/each}
				</div>
			</div>
		{/each}
	</div>
</main>
