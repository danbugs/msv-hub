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

	let resettingStartGG = $state(false);
	let resetResult = $state('');
	async function resetStartGG() {
		if (!confirm('Reset StartGG? This restarts all phases, removes bracket registrations, and leaves everyone in Swiss Round 1 only. Continue?')) return;
		resettingStartGG = true;
		resetResult = '';
		const res = await fetch('/api/tournament/reset-startgg', { method: 'POST' });
		const data = await res.json();
		if (res.ok) resetResult = 'StartGG reset complete';
		else resetResult = data.error ?? 'Reset failed';
		resettingStartGG = false;
	}
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<h1 class="text-2xl font-bold text-foreground">Dashboard</h1>
	<p class="mt-1 text-muted-foreground">Microspacing Vancouver — Tournament Operations</p>

	<div class="mt-8 space-y-0">

		<!-- ══ TUESDAY ══════════════════════════════════════════ -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary bg-primary/10 text-xs font-bold text-primary">T</div>
				<div class="mt-1 w-px flex-1 bg-secondary"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tuesday — Setup</p>

				<!-- ① Create Event on StartGG (automated) -->
				<a href="/dashboard/event-setup"
					class="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">① Create Event on StartGG <span class="ml-1.5 text-xs font-normal text-success">automated</span></div>
					<div class="mt-0.5 text-sm text-muted-foreground">Auto-created every Tuesday at 9 AM — manage TOs, config, and manual trigger</div>
				</a>

				<!-- ② Discord Setup -->
				<a href="/dashboard/pre-tournament/discord"
					class="mt-2 block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">② Discord Setup <span class="ml-1.5 text-xs font-normal text-success">automated</span></div>
					<div class="mt-0.5 text-sm text-muted-foreground">Auto-triggered after event creation — configure announcement, waitlist monitoring, and forum posts</div>
				</a>

				<!-- ③ Priority Registration -->
				<button onclick={() => toggle('pri-reg')}
					class="mt-2 w-full text-left rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">③ Priority Registration</div>
					<div class="mt-0.5 text-sm text-muted-foreground">Ping waitlist players from last week for early registration</div>
				</button>
				{#if expandedStep === 'pri-reg'}
					<div class="mt-2 rounded-lg border border-border bg-card/50 p-4 text-sm text-foreground space-y-3">
						<ol class="list-decimal list-inside space-y-1.5 text-muted-foreground">
							<li>Check the <strong class="text-foreground">previous event's waitlist</strong>. Find the last person who was tagged (non-inclusive).</li>
							<li>Take note of the <strong class="text-foreground">next 8 people</strong> and whether they are bringing a setup.</li>
							<li>Go to the latest <strong class="text-foreground">priority-registration</strong> forum post and ping those 8 people. Note in the message that they have until end of day to reply. Check a previous post for the standard message format.</li>
							<li><strong class="text-foreground">At end of day:</strong> add everyone who responded yes as <strong class="text-foreground">attendees to the StartGG tournament</strong>. When adding them, register for <strong class="text-foreground">Swiss only</strong> and correctly fill in the custom options (e.g., whether they are bringing a setup).</li>
							<li>Go to the tournament dashboard and set <strong class="text-foreground">Registration</strong> to admins-only so you can re-open it at 8:30 AM on Wednesday.</li>
							<li>Set the <strong class="text-foreground">Homepage</strong> to public and discoverable, and <strong class="text-foreground">Events</strong> visibility to public with brackets and seeding visible.</li>
						</ol>
					</div>
				{/if}
			</div>
		</div>

		<!-- ══ WEDNESDAY ════════════════════════════════════════ -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary bg-primary/10 text-xs font-bold text-primary">W</div>
				<div class="mt-1 w-px flex-1 bg-secondary"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Wednesday — Registration Day</p>

				<!-- ④ Open Registration (fully automated) -->
				<button onclick={() => toggle('open-reg')}
					class="w-full text-left rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">④ Open Registration <span class="ml-1.5 text-xs font-normal text-success">automated</span></div>
					<div class="mt-0.5 text-sm text-muted-foreground">Balrog handles registration, announcement, fastest registrant, and waitlist</div>
				</button>
				{#if expandedStep === 'open-reg'}
					<div class="mt-2 rounded-lg border border-border bg-card/50 p-4 text-sm text-foreground space-y-3">
						<p class="font-medium text-success">All automated at 8:30 AM:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-muted-foreground">
							<li>Balrog opens registration on StartGG and posts the announcement to Discord.</li>
							<li>Once 4+ public registrants appear, Balrog detects the fastest registrant and posts to the forum with an updated leaderboard.</li>
							<li>When the event caps, Balrog creates a waitlist thread and announces it.</li>
						</ol>
						<p class="font-medium text-warning">If something goes wrong:</p>
						<ol class="list-decimal list-inside space-y-1.5 text-muted-foreground">
							<li>Go to <a href="/dashboard/pre-tournament/discord" class="text-primary hover:text-primary/80">Discord Setup</a> → Testing → <strong class="text-foreground">Send Now</strong> for the announcement.</li>
							<li>Use <a href="/dashboard/pre-tournament/discord" class="text-primary hover:text-primary/80">Discord Setup</a> → Tools → <strong class="text-foreground">Manual Fastest Reg</strong> to post a specific event's fastest registrant.</li>
							<li>If both announcement and waitlist are broken, <strong class="text-foreground">Pause the bot</strong> and handle manually.</li>
						</ol>
					</div>
				{/if}
			</div>
		</div>

		<!-- ══ WED → MON: Seeding + Drop-out Monitoring ════════ -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-bold text-muted-foreground">↓</div>
				<div class="mt-1 w-px flex-1 bg-secondary"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Wed → Mon</p>

				<a href="/dashboard/pre-tournament/seed"
					class="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">Seed Event</div>
					<div class="mt-0.5 text-sm text-muted-foreground">Elo-based seeding with jitter control, or import from an existing StartGG event</div>
				</a>

				<button onclick={() => toggle('dropout-monitor')}
					class="mt-2 w-full text-left rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">Monitor Drop-outs</div>
					<div class="mt-0.5 text-sm text-muted-foreground">Check remove-me-from-bracket and coordinate waitlist replacements</div>
				</button>
				{#if expandedStep === 'dropout-monitor'}
					<div class="mt-2 rounded-lg border border-border bg-card/50 p-4 text-sm text-foreground space-y-3">
						<ol class="list-decimal list-inside space-y-1.5 text-muted-foreground">
							<li>Monitor the <strong class="text-foreground">#remove-me-from-bracket</strong> channel for players dropping out.</li>
							<li>When someone drops, check the <strong class="text-foreground">waitlist forum post</strong> for the next person in line.</li>
							<li>Ping the replacement in <strong class="text-foreground">#remove-me-from-bracket</strong> to confirm they can attend. Note whether they are bringing a setup.</li>
							<li>Once confirmed, remove the drop-out from the StartGG event and add the replacement.</li>
						</ol>
					</div>
				{/if}
			</div>
		</div>

		<!-- ══ MONDAY: Tournament Day ══════════════════════════ -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary bg-primary/10 text-xs font-bold text-primary">M</div>
				<div class="mt-1 w-px flex-1 bg-secondary"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Monday — Tournament Day</p>

				<!-- Attendance & Setup Tracking -->
				<a href="/dashboard/tournament/attendance"
					class="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">Attendance & Setups</div>
					<div class="mt-0.5 text-sm text-muted-foreground">Track who's here, verify setups, mark attendance for TOs to collaborate</div>
				</a>

				<!-- Active tournament card -->
				<div class="mt-2">
				{#if tournament === undefined}
					<div class="rounded-lg border border-border bg-card p-4 animate-pulse">
						<div class="h-4 w-32 rounded bg-secondary"></div>
					</div>
				{:else if tournament}
					<div class="rounded-xl border border-primary bg-primary/10 p-4">
						<div class="flex flex-wrap items-start gap-3">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 flex-wrap">
									<h2 class="font-semibold text-foreground">{tournament.name}</h2>
									<span class="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
										{#if tournament.phase === 'swiss'}
											Swiss R{tournament.currentRound}/{tournament.settings.numRounds}
										{:else if tournament.phase === 'brackets'}
											Brackets
										{:else}
											Completed
										{/if}
									</span>
								</div>
								<p class="mt-0.5 text-sm text-muted-foreground">
									{tournament.entrants.length} players · {tournament.settings.numStations} stations
									{#if tournament.phase === 'swiss' && tournament.currentRound > 0}
										· {tournament.rounds.filter(r => r.status === 'completed').length} round{tournament.rounds.filter(r => r.status === 'completed').length !== 1 ? 's' : ''} done
									{/if}
								</p>
								<a href="/live/{tournament.slug}" target="_blank"
									class="mt-1 block text-xs text-muted-foreground hover:text-primary">
									Live: /live/{tournament.slug} ↗
								</a>
							</div>
							<div class="flex items-center gap-2 shrink-0">
								{#if tournament.phase === 'swiss'}
									<a href="/dashboard/tournament/swiss"
										class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
										Manage Swiss
									</a>
								{:else if tournament.phase === 'brackets'}
									<a href="/dashboard/tournament/brackets"
										class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
										Manage Brackets
									</a>
								{:else if tournament.phase === 'completed'}
									<a href="/dashboard/tournament/brackets"
										class="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
										View / Fix Results
									</a>
									<a href="/api/tournament/export?slug={tournament.slug}" target="_blank"
										class="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
										Export JSON
									</a>
								{/if}
								<button onclick={resetStartGG} disabled={resettingStartGG}
									class="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-amber-700 hover:text-amber-400 transition-colors disabled:opacity-50"
									title="Restart all StartGG phases, remove bracket registrations, reset to Swiss Round 1">
									{resettingStartGG ? 'Resetting...' : 'Reset StartGG'}
								</button>
								<button onclick={deleteTournament}
									class="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-red-700 hover:text-red-400 transition-colors">
									Delete
								</button>
							</div>
							{#if resetResult}<p class="mt-2 text-xs {resetResult.includes('complete') ? 'text-success' : 'text-destructive'}">{resetResult}</p>{/if}
						</div>
					</div>
				{:else}
					<div class="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
						No active tournament —
						<a href="/dashboard/pre-tournament/seed" class="text-primary hover:text-primary/80">seed an event to start one</a>
					</div>
				{/if}
				</div>
			</div>
		</div>

		<!-- ══ MON → TUE: Post-tournament ══════════════════════ -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-bold text-muted-foreground">↓</div>
				<div class="mt-1 w-px flex-1 bg-secondary"></div>
			</div>
			<div class="pb-6 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mon → Tue</p>
				<a href="/dashboard/post-tournament"
					class="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
					<div class="font-medium text-foreground">Results & Export</div>
					<div class="mt-0.5 text-sm text-muted-foreground">Graphics, VOD, Braacket upload, StartGG sync</div>
				</a>
			</div>
		</div>

		<!-- ══ ALWAYS ON ═══════════════════════════════════════ -->
		<div class="flex gap-4">
			<div class="flex flex-col items-center">
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-bold text-muted-foreground">∞</div>
			</div>
			<div class="pb-2 pt-1 min-w-0 flex-1">
				<p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Always On</p>
				<div class="grid gap-2 sm:grid-cols-2">
					<div class="rounded-lg border border-dashed border-border bg-card/50 p-4 opacity-60 cursor-default">
						<div class="font-medium text-muted-foreground">League Overview</div>
						<div class="mt-0.5 text-sm text-muted-foreground">Season standings, Elo history, weekly recap — coming soon</div>
					</div>
					<a href="/dashboard/settings"
						class="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-accent">
						<div class="font-medium text-foreground">TO Management</div>
						<div class="mt-0.5 text-sm text-muted-foreground">Manage tournament organizer access</div>
					</a>
				</div>
			</div>
		</div>

	</div>
</main>
