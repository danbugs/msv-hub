<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { TournamentState, Entrant, SwissRound, BracketMatch, BracketState } from '$lib/types/tournament';

	let { data } = $props();
	let tournament = $derived<TournamentState | null>(data.tournament);

	let now = $state(Date.now());
	onMount(() => {
		const tick = setInterval(() => { now = Date.now(); }, 1000);
		const poll = setInterval(() => { invalidateAll(); }, 10_000);
		return () => { clearInterval(tick); clearInterval(poll); };
	});

	function tag(id?: string): string {
		if (!id || !tournament) return 'TBD';
		return tournament.entrants.find((e) => e.id === id)?.gamerTag ?? 'TBD';
	}

	function elapsed(calledAt: number): string {
		const s = Math.floor((now - calledAt) / 1000);
		return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
	}

	interface CallEntry {
		id: string;
		p1: string;
		p2: string;
		station?: number;
		isStream?: boolean;
		calledAt?: number;
		hasResult: boolean;
		roundLabel: string;
	}

	const swissEntries = $derived.by((): CallEntry[] => {
		if (!tournament || tournament.phase !== 'swiss') return [];
		const round = tournament.rounds[tournament.currentRound - 1];
		if (!round || round.status === 'pending') return [];
		return round.matches.map((m) => ({
			id: m.id,
			p1: tag(m.topPlayerId),
			p2: tag(m.bottomPlayerId),
			station: m.station,
			isStream: m.isStream,
			hasResult: !!m.winnerId,
			roundLabel: `Swiss R${round.number}`,
		}));
	});

	function bracketEntries(bracket: BracketState | undefined, label: string): CallEntry[] {
		if (!bracket) return [];
		const activeRounds = new Set<number>();
		for (const m of bracket.matches) {
			if ((m.topPlayerId || m.bottomPlayerId) && !m.winnerId) {
				activeRounds.add(m.round);
			}
		}
		if (activeRounds.size === 0) return [];

		return bracket.matches
			.filter((m) => activeRounds.has(m.round) && (m.topPlayerId || m.bottomPlayerId))
			.map((m) => ({
				id: m.id,
				p1: tag(m.topPlayerId),
				p2: tag(m.bottomPlayerId),
				station: m.station,
				isStream: m.isStream,
				calledAt: m.calledAt,
				hasResult: !!m.winnerId,
				roundLabel: `${label} ${roundName(m.round)}`,
			}));
	}

	function roundName(round: number): string {
		if (round > 0) return `WR${round}`;
		return `LR${Math.abs(round)}`;
	}

	const mainEntries = $derived(bracketEntries(tournament?.brackets?.main, 'Main'));
	const redemptionEntries = $derived(bracketEntries(tournament?.brackets?.redemption, 'Redemption'));

	const allEntries = $derived.by((): CallEntry[] => {
		if (swissEntries.length > 0) return swissEntries;
		return [...mainEntries, ...redemptionEntries];
	});

	const called = $derived(allEntries.filter((e) => e.station && !e.hasResult));
	const pending = $derived(allEntries.filter((e) => !e.station && !e.hasResult));
	const done = $derived(allEntries.filter((e) => e.hasResult));

	const phaseLabel = $derived.by(() => {
		if (!tournament) return '';
		if (tournament.phase === 'swiss') return `Swiss Round ${tournament.currentRound}`;
		if (tournament.phase === 'brackets') return 'Brackets';
		return 'Completed';
	});
</script>

<svelte:head>
	<title>Call Screen — {tournament?.name ?? data.slug}</title>
</svelte:head>

<div class="min-h-screen bg-black text-white p-6 font-sans">
	{#if !tournament}
		<div class="flex items-center justify-center h-screen">
			<p class="text-4xl text-zinc-500">No tournament data</p>
		</div>
	{:else}
		<header class="mb-6 flex items-baseline justify-between">
			<div>
				<h1 class="text-3xl font-bold">{tournament.name}</h1>
				<p class="text-xl text-zinc-400 mt-1">{phaseLabel}</p>
			</div>
			<div class="text-right text-zinc-500">
				<p class="text-lg">{called.length} active &middot; {pending.length} waiting &middot; {done.length} done</p>
			</div>
		</header>

		{#if called.length > 0}
			<section class="mb-8">
				<h2 class="text-lg font-semibold text-emerald-400 mb-3 uppercase tracking-wider">Now Playing</h2>
				<div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));">
					{#each called as entry (entry.id)}
						<div class="rounded-lg px-5 py-3 flex items-center justify-between
							{entry.isStream ? 'bg-purple-900/60 ring-1 ring-purple-500' : 'bg-zinc-800'}">
							<div class="flex items-center gap-3 min-w-0">
								<span class="text-2xl font-bold text-emerald-400 shrink-0 w-12 text-center">
									{entry.isStream ? '📺' : `S${entry.station}`}
								</span>
								<div class="min-w-0">
									<p class="text-xl font-semibold truncate">{entry.p1} <span class="text-zinc-500 font-normal">vs</span> {entry.p2}</p>
									<p class="text-sm text-zinc-500">{entry.roundLabel}</p>
								</div>
							</div>
							{#if entry.calledAt}
								<span class="text-zinc-500 text-sm tabular-nums shrink-0 ml-3">{elapsed(entry.calledAt)}</span>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if pending.length > 0}
			<section class="mb-8">
				<h2 class="text-lg font-semibold text-amber-400 mb-3 uppercase tracking-wider">Up Next</h2>
				<div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));">
					{#each pending as entry (entry.id)}
						<div class="rounded-lg bg-zinc-900 px-5 py-3 flex items-center gap-3">
							<span class="text-2xl text-zinc-600 shrink-0 w-12 text-center">—</span>
							<div class="min-w-0">
								<p class="text-xl truncate">
									{#if entry.p1 !== 'TBD' && entry.p2 !== 'TBD'}
										{entry.p1} <span class="text-zinc-600">vs</span> {entry.p2}
									{:else if entry.p1 !== 'TBD'}
										{entry.p1} <span class="text-zinc-600">vs TBD</span>
									{:else if entry.p2 !== 'TBD'}
										<span class="text-zinc-600">TBD vs</span> {entry.p2}
									{:else}
										<span class="text-zinc-600">TBD vs TBD</span>
									{/if}
								</p>
								<p class="text-sm text-zinc-600">{entry.roundLabel}</p>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if done.length > 0 && (called.length > 0 || pending.length > 0)}
			<section>
				<h2 class="text-lg font-semibold text-zinc-600 mb-3 uppercase tracking-wider">Completed ({done.length})</h2>
				<div class="grid gap-1" style="grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));">
					{#each done as entry (entry.id)}
						<div class="rounded px-4 py-2 bg-zinc-900/50 flex items-center gap-3 opacity-50">
							<span class="text-lg text-zinc-700 shrink-0 w-10 text-center">✓</span>
							<p class="text-base truncate text-zinc-500">{entry.p1} vs {entry.p2}</p>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if allEntries.length === 0}
			<div class="flex items-center justify-center h-[60vh]">
				<p class="text-3xl text-zinc-600">Waiting for matches...</p>
			</div>
		{/if}
	{/if}
</div>
