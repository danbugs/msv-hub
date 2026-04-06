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

	let expandedStep = $state<string | null>(null);
	function toggle(id: string) { expandedStep = expandedStep === id ? null : id; }
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<h1 class="text-2xl font-bold text-white">Dashboard</h1>
	<p class="mt-1 text-gray-400">Microspacing Vancouver — Tournament Operations</p>

	<!-- ── Weekly timeline ── -->
	<div class="mt-8 space-y-0">

		<!-- ── TUESDAY: StartGG Setup ─────────────────────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">T</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Tuesday — Setup</p>

				<!-- StartGG Setup Instructions -->
				<button onclick={() => toggle('startgg-setup')}
					class="w-full text-left rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">① Create Event on StartGG</div>
					<div class="mt-0.5 text-sm text-gray-400">Create the next event, configure settings, add TOs</div>
				</button>
				{#if expandedStep === 'startgg-setup'}
					<div class="mt-2 rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300 space-y-3">
						<p class="font-medium text-white">Create the event:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-gray-400">
							<li>Go to <strong class="text-gray-200">start.gg</strong> and create a new tournament.</li>
							<li>Set the tournament name, add the Discord join link as the contact type.</li>
							<li>Set the start date to <strong class="text-gray-200">6 PM Monday</strong> and end date to <strong class="text-gray-200">11 PM Monday</strong>.</li>
							<li>Select <strong class="text-gray-200">Copy settings from previous event</strong> and link it to the Microspacing Hub.</li>
						</ol>
						<p class="font-medium text-white">Configure the event dashboard:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-gray-400">
							<li>Set <strong class="text-gray-200">Homepage</strong> to public (link only).</li>
							<li>Set <strong class="text-gray-200">Events</strong> to public with brackets and seeding hidden.</li>
							<li>Set <strong class="text-gray-200">Registration</strong> to public and <strong class="text-gray-200">Attendees</strong> to public.</li>
							<li>In <strong class="text-gray-200">Details</strong>, set the short slug to <code class="bg-gray-800 px-1 rounded text-xs text-violet-300">microspacing-van</code>.</li>
						</ol>
						<p class="font-medium text-white">Add TOs:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-gray-400">
							<li>Go to <strong class="text-gray-200">Attendees</strong> and add the weekly TOs. Aim for 3 TOs per event.</li>
							<li>If needed, ping volunteers for help and give them priority registration.</li>
							<li>When adding TOs, select <strong class="text-gray-200">all three events</strong> (Swiss, Main Bracket, Redemption Bracket).</li>
							<li>In custom options, mark whether the TO is bringing a setup (usually yes) and that it is not past the registration deadline.</li>
							<li>Confirm the TO consents to being livestreamed.</li>
						</ol>
						<p class="font-medium text-white">Notify the team:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-gray-400">
							<li>Post in the Microsoft Microspacing chat that registration is live.</li>
						</ol>
					</div>
				{/if}

				<!-- Discord Setup -->
				<a href="/dashboard/pre-tournament/discord"
					class="mt-2 block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">② Discord Setup</div>
					<div class="mt-0.5 text-sm text-gray-400">Configure the announcement, waitlist monitoring, and pre-tournament forum posts</div>
				</a>

				<!-- Priority Registration Instructions -->
				<button onclick={() => toggle('pri-reg')}
					class="mt-2 w-full text-left rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">③ Priority Registration</div>
					<div class="mt-0.5 text-sm text-gray-400">Ping waitlist players from last week for early registration</div>
				</button>
				{#if expandedStep === 'pri-reg'}
					<div class="mt-2 rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300 space-y-3">
						<ol class="list-decimal list-inside space-y-1.5 text-gray-400">
							<li>Check the <strong class="text-gray-200">previous event's waitlist</strong>. Find the last person who was tagged (non-inclusive).</li>
							<li>Take note of the <strong class="text-gray-200">next 8 people</strong> after that tag and whether they are bringing a setup.</li>
							<li>Go to the latest <strong class="text-gray-200">priority-registration</strong> forum post and ping those 8 people. Note in the message that they have until end of day to reply. Check a previous forum post for the default message format.</li>
							<li><strong class="text-gray-200">At end of day:</strong> add everyone who responded yes, noting whether they are bringing a setup.</li>
							<li>In the tournament dashboard, set <strong class="text-gray-200">Registration</strong> to admins-only so you can re-open at 8:30 AM tomorrow.</li>
							<li>Set the <strong class="text-gray-200">Homepage</strong> to public and discoverable, and <strong class="text-gray-200">Events</strong> to public with brackets and seeding visible.</li>
						</ol>
					</div>
				{/if}
			</div>
		</div>

		<!-- ── TUE → MON gap: Seeding ───────────────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">↓</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Tue → Mon</p>
				<a href="/dashboard/pre-tournament/seed"
					class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">Seed Event</div>
					<div class="mt-0.5 text-sm text-gray-400">Elo-based seeding with jitter control, or import from existing StartGG event</div>
				</a>
			</div>
		</div>

		<!-- ── MONDAY: Tournament Day ─────────────────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-700 bg-violet-900/40 text-xs font-bold text-violet-300">M</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Monday — Tournament Day</p>

				<!-- Wednesday morning instructions -->
				<button onclick={() => toggle('mon-morning')}
					class="w-full text-left rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50">
					<div class="font-medium text-white">Morning Checklist</div>
					<div class="mt-0.5 text-sm text-gray-400">Open registration, verify announcement, check fastest registrant</div>
				</button>
				{#if expandedStep === 'mon-morning'}
					<div class="mt-2 rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300 space-y-3">
						<p class="font-medium text-amber-300">At 8:30 AM:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-gray-400">
							<li>Go to the event dashboard and set <strong class="text-gray-200">Registration</strong> to public.</li>
							<li>Balrog should post the announcement automatically. If not, go to <a href="/dashboard/pre-tournament/discord" class="text-violet-400 hover:text-violet-300">Discord Setup</a> → Automation → press <strong class="text-gray-200">Send Now</strong>.</li>
							<li>If the announcement has problems, the waitlist likely will too — <strong class="text-gray-200">pause the bot</strong> and monitor manually for when the event caps.</li>
						</ol>
						<p class="font-medium text-amber-300">After registration is live:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-gray-400">
							<li>Check who registered fastest: go to <strong class="text-gray-200">Attendees</strong> on StartGG and export the list. Find the fastest registration after 8:30 AM (ignore priority registrations).</li>
							<li>Go to the <strong class="text-gray-200">fastest-registration</strong> forum on Discord and post who won. Update the leaderboard.</li>
						</ol>
					</div>
				{/if}

				<!-- Active tournament card -->
				<div class="mt-2">
				{#if tournament === undefined}
					<div class="rounded-lg border border-gray-800 bg-gray-900 p-4 animate-pulse">
						<div class="h-4 w-32 rounded bg-gray-800"></div>
					</div>
				{:else if tournament}
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
		</div>

		<!-- ── MON → TUE: Post-tournament ───────────── -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gray-700 bg-gray-900 text-xs font-bold text-gray-500">↓</div>
				<div class="mt-1 w-px flex-1 bg-gray-800"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Mon → Tue</p>
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
