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
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<h1 class="text-2xl font-bold text-white">Dashboard</h1>
	<p class="mt-1 text-gray-400">Microspacing Vancouver — Tournament Operations</p>

	<!-- ── Weekly timeline ── -->
	<div class="mt-8 space-y-0">

		<!-- ── TUESDAY ─────────────────────────────────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">T</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Tuesday</p>
				<a href="/dashboard/pre-tournament/discord"
					class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">Discord Setup</div>
					<div class="mt-0.5 text-sm text-gray-400">Lock threads, create forum posts, send registration announcement</div>
				</a>
			</div>
		</div>

		<!-- ── TUE → WED gap: Seeding ───────────────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">↓</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Tue → Wed</p>
				<a href="/dashboard/pre-tournament/seed"
					class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">Seed Event</div>
					<div class="mt-0.5 text-sm text-gray-400">Elo-based seeding with jitter control, or import from existing StartGG event</div>
				</a>
			</div>
		</div>

		<!-- ── WEDNESDAY: Tournament ─────────────────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">W</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Wednesday — Tournament Day</p>

				{#if tournament === undefined}
					<div class="rounded-lg border border-gray-800 bg-gray-900 p-4 animate-pulse">
						<div class="h-4 w-32 rounded bg-gray-800"></div>
					</div>
				{:else if tournament}
					<!-- Active tournament -->
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
									Live: /live/{tournament.slug} ↗
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
		</div>

		<!-- ── WED → THU gap: Post-tournament ───────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">↓</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Wed → Thu</p>
				<a href="/dashboard/post-tournament"
					class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">Results & Export</div>
					<div class="mt-0.5 text-sm text-gray-400">Graphics, VOD, Braacket upload, StartGG sync</div>
				</a>
			</div>
		</div>

		<!-- ── ALWAYS ON ─────────────────────────────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">∞</div>
			</div>
			<div class="pb-2 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Always On</p>
				<div class="grid gap-2 sm:grid-cols-2">
					<!-- League overview (coming soon) -->
					<div class="rounded-lg border border-dashed border-gray-800 bg-gray-900/50 p-4 opacity-60 cursor-default">
						<div class="font-medium text-gray-400">League Overview</div>
						<div class="mt-0.5 text-sm text-gray-500">Season standings, Elo history, weekly recap — coming soon</div>
					</div>
					<a href="/dashboard/settings"
						class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
						<div class="font-medium text-white">TO Management</div>
						<div class="mt-0.5 text-sm text-gray-400">Manage tournament organizer access</div>
					</a>
					<a href="/dashboard/community"
						class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
						<div class="font-medium text-white">Community</div>
						<div class="mt-0.5 text-sm text-gray-400">Fun commands, motivational messages, dice rolls, goat crowning</div>
					</a>
				</div>
			</div>
		</div>

	</div>
</main>
