<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { TournamentState, Entrant, BracketMatch, BracketState } from '$lib/types/tournament';
	import BracketView from '$lib/components/BracketView.svelte';
	import { myMatchStatus } from '$lib/live/my-match';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	let { data } = $props();
	let tournament = $derived<TournamentState | null>(data.tournament);

	let searchQuery = $state('');
	let selectedEntrantId = $state<string | null>(null);
	let expandedRounds = $state(new Set<number>());

	function getEntrant(id?: string): Entrant | undefined {
		if (!id || !tournament) return undefined;
		return tournament.entrants.find((e) => e.id === id);
	}

	function matchedEntrants(): Entrant[] {
		if (!searchQuery.trim() || !tournament) return [];
		const q = searchQuery.toLowerCase();
		return tournament.entrants.filter((e) => e.gamerTag.toLowerCase().includes(q)).slice(0, 6);
	}

	function selectEntrant(id: string) {
		selectedEntrantId = id;
		const e = getEntrant(id);
		if (e) searchQuery = e.gamerTag;
	}

	function clearSearch() {
		searchQuery = '';
		selectedEntrantId = null;
	}

	// ── "Your match" card ─────────────────────────────────────────────────
	// Remembered per tournament in localStorage; ?me=<tag> lets a link preselect it.

	let meId = $state<string | null>(null);
	let notifyOn = $state(false);
	let now = $state(Date.now());
	const meKey = $derived(`msv-live-me:${data.slug}`);

	onMount(() => {
		const fromUrl = page.url.searchParams.get('me')?.toLowerCase();
		const byTag = fromUrl && tournament?.entrants.find((e) => e.gamerTag.toLowerCase() === fromUrl);
		let stored: string | null = null;
		try { stored = localStorage.getItem(meKey); } catch { /* storage blocked */ }
		meId = byTag ? byTag.id : stored && getEntrant(stored) ? stored : null;
		notifyOn = typeof Notification !== 'undefined' && Notification.permission === 'granted' && !!meId;
		const tick = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(tick);
	});

	function setMe(id: string | null) {
		meId = id;
		try {
			if (id) localStorage.setItem(meKey, id); else localStorage.removeItem(meKey);
		} catch { /* storage blocked */ }
	}

	let myStatus = $derived(tournament && meId ? myMatchStatus(tournament, meId) : null);

	async function enableNotify() {
		if (typeof Notification === 'undefined') return;
		notifyOn = (await Notification.requestPermission()) === 'granted';
	}

	// Alert when a new Swiss pairing appears or a bracket match gets called.
	// Only fires while the tab is alive — good enough for players watching at the venue.
	// The first status seen for a player is the baseline, so a reload doesn't re-alert.
	let alertBaseline: { meId: string; key: string | null } | null = null;
	$effect(() => {
		const s = myStatus;
		if (!s || !meId) return;
		const key =
			s.kind === 'swiss-playing' ? `swiss-${s.round}` :
			s.kind === 'bracket-ready' && s.calledAt ? `bracket-${s.match.id}-${s.calledAt}` : null;
		if (alertBaseline?.meId !== meId) { alertBaseline = { meId, key }; return; }
		if (!key || key === alertBaseline.key) return;
		alertBaseline.key = key;
		if (!notifyOn || !s || (s.kind !== 'swiss-playing' && s.kind !== 'bracket-ready')) return;
		const where = s.isStream ? 'STREAM' : s.station ? `Station ${s.station}` : 'your station';
		try {
			new Notification(`You're up — ${where}`, { body: `vs ${getEntrant(s.opponentId)?.gamerTag ?? 'TBD'}`, tag: 'msv-match' });
		} catch { /* some mobile browsers only allow notifications from a service worker */ }
		navigator.vibrate?.([200, 100, 200]);
	});

	function minutesAgo(ts: number): string {
		const m = Math.max(0, Math.floor((now - ts) / 60_000));
		return m === 0 ? 'just now' : `${m}m ago`;
	}

	// ── Player history (why command) ──────────────────────────────────────

	function getSwissMatchesFor(entrantId: string) {
		if (!tournament) return [];
		const results: { round: number; opponentId: string; won: boolean; topScore?: number; bottomScore?: number; isTop: boolean }[] = [];
		for (const r of tournament.rounds) {
			if (r.byePlayerId === entrantId) {
				results.push({ round: r.number, opponentId: 'BYE', won: true, isTop: true });
				continue;
			}
			for (const m of r.matches) {
				if (!m.winnerId) continue;
				const isTop = m.topPlayerId === entrantId;
				const isBot = m.bottomPlayerId === entrantId;
				if (!isTop && !isBot) continue;
				results.push({
					round: r.number,
					opponentId: isTop ? m.bottomPlayerId : m.topPlayerId,
					won: m.winnerId === entrantId,
					topScore: m.topScore,
					bottomScore: m.bottomScore,
					isTop
				});
			}
		}
		return results;
	}

	function getBracketMatchesFor(entrantId: string, bracketName: 'main' | 'redemption') {
		const bracket = tournament?.brackets?.[bracketName];
		if (!bracket) return [];
		const results: { match: BracketMatch; isTop: boolean }[] = [];
		for (const m of bracket.matches) {
			const isTop = m.topPlayerId === entrantId;
			const isBot = m.bottomPlayerId === entrantId;
			if (isTop || isBot) results.push({ match: m, isTop });
		}
		return results.sort((a, b) => {
			const ra = a.match.round < 0 ? 1000 + Math.abs(a.match.round) : -a.match.round;
			const rb = b.match.round < 0 ? 1000 + Math.abs(b.match.round) : -b.match.round;
			return ra - rb;
		});
	}

	function finalStandingFor(entrantId: string) {
		return tournament?.finalStandings?.find((s) => s.entrantId === entrantId);
	}

	// ── Bracket helpers ───────────────────────────────────────────────────

	function matchLabel(match: BracketMatch, bracket: BracketState): string {
		if (match.id.includes('-GFR-')) return 'Grand Finals Reset';
		const positiveRounds = bracket.matches.filter((m) => m.round > 0 && !m.id.includes('-GFR-'));
		const maxWR = positiveRounds.length ? Math.max(...positiveRounds.map((m) => m.round)) : 1;
		const hasGFR = bracket.matches.some((m) => m.id.includes('-GFR-'));
		if (match.round === maxWR) return hasGFR ? 'Grand Final (pre-reset)' : 'Grand Final';
		if (match.round > 0) {
			if (match.round === maxWR - 1) return 'Winners Finals';
			if (match.round === maxWR - 2) return 'Winners Semis';
			return `Winners R${match.round}`;
		}
		const maxLR = bracket.matches.filter((m) => m.round < 0).reduce((mx, m) => Math.max(mx, Math.abs(m.round)), 0);
		const absR = Math.abs(match.round);
		if (absR === maxLR) return 'Losers Finals';
		if (absR === maxLR - 1) return 'Losers Semis';
		return `Losers R${absR}`;
	}

	// Group bracket matches by round label for display
	function bracketRoundGroups(bracket: BracketState): { label: string; matches: BracketMatch[] }[] {
		const groups = new Map<string, BracketMatch[]>();
		// Order: winners rounds asc, then GF, then losers rounds desc, then GFR
		const sorted = [...bracket.matches].sort((a, b) => {
			const key = (m: BracketMatch) => {
				if (m.id.includes('-GFR-')) return 10000;
				if (m.round > 0) return -m.round; // winners: higher round first (closest to GF)
				return 100 + Math.abs(m.round); // losers: lower abs = earlier
			};
			return key(a) - key(b);
		});
		for (const m of sorted) {
			const label = matchLabel(m, bracket);
			const g = groups.get(label) ?? [];
			g.push(m);
			groups.set(label, g);
		}
		return [...groups.entries()].map(([label, matches]) => ({ label, matches }));
	}

	function getStandings() {
		if (!tournament) return [];
		return tournament.entrants
			.map((e) => {
				let wins = 0, losses = 0;
				for (const r of tournament!.rounds) {
					if (r.byePlayerId === e.id) wins++;
					for (const m of r.matches) {
						if (!m.winnerId) continue;
						if (m.topPlayerId === e.id || m.bottomPlayerId === e.id) {
							if (m.winnerId === e.id) wins++; else losses++;
						}
					}
				}
				return { ...e, wins, losses };
			})
			.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.initialSeed - b.initialSeed);
	}

	// Auto-refresh every 15s
	$effect(() => {
		const interval = setInterval(() => invalidateAll(), 15_000);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>{tournament?.name ?? data.slug} — MSV Live</title>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<!-- Header -->
	<div class="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur px-4 py-3">
		<div class="mx-auto max-w-3xl">
			<div class="flex items-center gap-3">
				<div class="flex-1 min-w-0">
					<div class="text-base font-bold text-primary truncate">{tournament?.name?.replace(/\s*-\s*Phase\s+\d+\s*\(.*?\)\s*$/i, '') ?? 'MSV Live'}</div>
					{#if tournament}
						<div class="text-xs text-muted-foreground">
							{tournament.phase === 'swiss'
								? `Swiss R${tournament.currentRound}/${tournament.settings.numRounds}`
								: tournament.phase === 'brackets' ? 'Brackets' : 'Completed'}
							· {tournament.entrants.length} players
						</div>
					{/if}
				</div>
				<a href="/live/{data.slug}/projector" target="_blank"
					class="text-xs text-primary hover:text-primary/80 shrink-0">projector ↗</a>
				<a href="https://twitch.tv/microspacing" target="_blank"
					class="text-xs text-primary hover:text-primary/80 shrink-0">twitch ↗</a>
			</div>

			<!-- Player search -->
			{#if tournament}
				<div class="relative mt-2">
					<input
						bind:value={searchQuery}
						oninput={() => { if (!searchQuery.trim()) selectedEntrantId = null; }}
						placeholder="Find yourself to pin your next match…"
						class="w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none" />
					{#if searchQuery && !selectedEntrantId}
						<div class="absolute top-full mt-1 left-0 w-full rounded-lg border border-border bg-card shadow-xl z-40">
							{#each matchedEntrants() as e}
								<button onclick={() => selectEntrant(e.id)}
									class="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent text-left">
									<span class="text-muted-foreground text-xs w-6 text-right shrink-0">#{e.initialSeed}</span>
									{e.gamerTag}
								</button>
							{:else}
								<div class="px-3 py-2 text-sm text-muted-foreground">No players found</div>
							{/each}
						</div>
					{/if}
					{#if selectedEntrantId}
						<button onclick={clearSearch}
							class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<div class="mx-auto max-w-3xl px-4 py-6 space-y-8">

		{#if tournament && meId && myStatus}
			{@const me = getEntrant(meId)}
			{@const s = myStatus}
			{@const urgent = s.kind === 'swiss-playing' || (s.kind === 'bracket-ready' && !!s.calledAt)}
			<section class="rounded-xl border p-4 {urgent ? 'border-primary bg-primary/10' : 'border-border bg-card'}" aria-live="polite">
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<span>Your match · <span class="font-medium text-foreground">{me?.gamerTag}</span></span>
					<span class="flex-1"></span>
					{#if !notifyOn && typeof Notification !== 'undefined'}
						<button onclick={enableNotify} class="text-primary hover:text-primary/80">🔔 alert me</button>
					{/if}
					<button onclick={() => setMe(null)} class="hover:text-foreground">not me</button>
				</div>
				<div class="mt-2">
					{#if s.kind === 'swiss-playing' || s.kind === 'bracket-ready'}
						{@const opp = getEntrant(s.opponentId)}
						<div class="flex items-baseline gap-3 flex-wrap">
							<span class="text-2xl font-bold {s.isStream ? 'text-primary' : 'text-foreground'}">
								{s.isStream ? 'STREAM' : s.station ? `Station ${s.station}` : 'Station TBD'}
							</span>
							<span class="text-base text-foreground">vs <span class="font-semibold">{opp?.gamerTag ?? 'TBD'}</span></span>
						</div>
						<div class="mt-1 text-xs text-muted-foreground">
							{#if s.kind === 'swiss-playing'}
								Swiss Round {s.round} — go play!
							{:else}
								{s.bracket === 'main' ? 'Main' : 'Redemption'} · {matchLabel(s.match, tournament.brackets![s.bracket]!)}
								· {s.calledAt ? `called ${minutesAgo(s.calledAt)} — head to your station` : 'not called yet, stay close'}
							{/if}
						</div>
					{:else if s.kind === 'swiss-reported'}
						<div class="text-base text-foreground">
							Round {s.round}: <span class="{s.won ? 'text-success' : 'text-destructive'} font-semibold">{s.won ? 'Win' : 'Loss'}</span>
						</div>
						<div class="mt-1 text-xs text-muted-foreground">
							{s.lastRound ? 'Swiss is over — waiting for brackets.' : `Waiting for Round ${s.round + 1} pairings.`}
						</div>
					{:else if s.kind === 'swiss-bye'}
						<div class="text-base text-foreground">BYE in Round {s.round}</div>
						<div class="mt-1 text-xs text-muted-foreground">Free win — hang tight for the next round.</div>
					{:else if s.kind === 'bracket-waiting'}
						{@const [a, b] = s.feederIds}
						<div class="text-base text-foreground">
							Next: {matchLabel(s.match, tournament.brackets![s.bracket]!)}
						</div>
						<div class="mt-1 text-xs text-muted-foreground">
							{#if a && b}
								Waiting on the winner of {getEntrant(a)?.gamerTag} vs {getEntrant(b)?.gamerTag}.
							{:else}
								Waiting on your opponent.
							{/if}
						</div>
					{:else if s.kind === 'done'}
						<div class="text-base text-foreground">
							{s.rank ? `Finished #${s.rank}${s.bracket === 'redemption' ? ' in Redemption' : ''}` : 'No more matches'}
						</div>
						<div class="mt-1 text-xs text-muted-foreground">GGs! Thanks for coming out.</div>
					{:else}
						<div class="text-sm text-muted-foreground">Waiting for the tournament to start.</div>
					{/if}
				</div>
			</section>
		{/if}

		{#if !tournament}
			<div class="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
				No active tournament for this slug.
			</div>

		{:else if selectedEntrantId}
			<!-- ── Player history view (like /why) ── -->
			{@const entrant = getEntrant(selectedEntrantId)}
			{@const standing = finalStandingFor(selectedEntrantId)}
			{@const swissMatches = getSwissMatchesFor(selectedEntrantId)}
			{@const swissW = swissMatches.filter((m) => m.won).length}
			{@const swissL = swissMatches.filter((m) => !m.won && m.opponentId !== 'BYE').length}

			<div>
				<div class="flex items-center gap-3 flex-wrap">
					<h2 class="text-xl font-bold text-foreground truncate min-w-0">{entrant?.gamerTag}</h2>
					<span class="rounded-full bg-secondary px-3 py-0.5 text-xs text-foreground">Seed #{entrant?.initialSeed}</span>
					{#if meId !== selectedEntrantId}
						<button onclick={() => { setMe(selectedEntrantId); clearSearch(); }}
							class="rounded-full border border-primary/40 px-3 py-0.5 text-xs text-primary hover:bg-primary/10">⭐ This is me</button>
					{/if}
					<span class="rounded-full bg-secondary px-3 py-0.5 text-xs text-success">{swissW}W – {swissL}L Swiss</span>
					{#if standing}
						<span class="rounded-full px-3 py-0.5 text-xs {standing.bracket === 'main' ? 'bg-primary/10 text-primary' : 'bg-destructive-muted text-destructive'}">
							{standing.bracket === 'main' ? 'Main' : 'Redemption'} Bracket — Rank #{standing.rank}
						</span>
					{/if}
				</div>

				<!-- Swiss history -->
				{#if swissMatches.length > 0}
					<div class="mt-4">
						<h3 class="text-sm font-semibold text-muted-foreground mb-2">Swiss</h3>
						<div class="space-y-1">
							{#each swissMatches as m}
								{@const opp = m.opponentId === 'BYE' ? null : getEntrant(m.opponentId)}
								<div class="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm min-w-0">
									<span class="text-xs text-muted-foreground w-12 shrink-0">R{m.round}</span>
									<span class="w-2 h-2 rounded-full shrink-0 {m.won ? 'bg-green-500' : 'bg-red-500'}"></span>
									<span class="{m.won ? 'text-success' : 'text-destructive'} font-medium w-8 shrink-0">{m.won ? 'W' : 'L'}</span>
									<span class="flex-1 text-foreground truncate">
										{m.opponentId === 'BYE' ? 'BYE' : (opp?.gamerTag ?? '?')}
									</span>
									{#if m.topScore !== undefined && m.bottomScore !== undefined}
										<span class="text-xs text-muted-foreground shrink-0">
											{m.isTop ? `${m.topScore}–${m.bottomScore}` : `${m.bottomScore}–${m.topScore}`}
										</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Bracket history -->
				{#if tournament.brackets}
					{#each (['main', 'redemption'] as const) as bn}
						{@const bracketMatches = getBracketMatchesFor(selectedEntrantId, bn)}
						{#if bracketMatches.length > 0}
							<div class="mt-4">
								<h3 class="text-sm font-semibold text-muted-foreground mb-2">
									{bn === 'main' ? 'Main' : 'Redemption'} Bracket
								</h3>
								<div class="space-y-1">
									{#each bracketMatches as { match, isTop }}
										{@const oppId = isTop ? match.bottomPlayerId : match.topPlayerId}
										{@const opp = getEntrant(oppId)}
										{@const won = match.winnerId === selectedEntrantId}
										{@const label = matchLabel(match, tournament.brackets![bn]!)}
										<div class="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm min-w-0">
											<span class="text-xs text-muted-foreground w-24 shrink-0 truncate">{label}</span>
											{#if match.winnerId}
												<span class="w-2 h-2 rounded-full shrink-0 {won ? 'bg-green-500' : 'bg-red-500'}"></span>
												<span class="{won ? 'text-success' : 'text-destructive'} font-medium w-8 shrink-0">{won ? 'W' : 'L'}</span>
											{:else}
												<span class="w-2 h-2 rounded-full shrink-0 bg-gray-600"></span>
												<span class="text-muted-foreground w-8 shrink-0">—</span>
											{/if}
											<span class="flex-1 text-foreground truncate">{opp?.gamerTag ?? (oppId ? '?' : 'TBD')}</span>
											{#if match.topScore !== undefined && match.bottomScore !== undefined}
												<span class="text-xs text-muted-foreground shrink-0">
													{isTop ? `${match.topScore}–${match.bottomScore}` : `${match.bottomScore}–${match.topScore}`}
												</span>
											{/if}
										</div>
										{#if match.topCharacters?.length || match.bottomCharacters?.length}
											<div class="flex gap-2 px-3 pb-1 text-xs text-muted-foreground min-w-0">
												{#if isTop && match.topCharacters?.length}
													<span class="truncate">{match.topCharacters.join(', ')}</span>
												{:else if !isTop && match.bottomCharacters?.length}
													<span class="truncate">{match.bottomCharacters.join(', ')}</span>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
							</div>
						{/if}
					{/each}
				{/if}
			</div>

		{:else}
			<!-- ── Full tournament view ── -->

			<!-- Bracket views — break out of max-w-3xl to use full width -->
			{#if tournament.brackets}
				<div class="grid grid-cols-1 xl:grid-cols-2 gap-4 w-[calc(100vw-2rem)] relative left-1/2 -translate-x-1/2 px-4 max-w-[100vw]">
				{#if (tournament.mode === 'gauntlet' || tournament.mode === 'experimental1') && !tournament.brackets.redemption}
					<div class="col-span-full rounded-lg border border-primary/20 bg-primary/5 px-4 py-2 text-xs text-muted-foreground">
						{tournament.mode === 'experimental1' ? 'Experimental #1' : 'Macro Default'} Mode — Redemption bracket starts once all early eliminates (0-2, 1-2) are decided.
					</div>
				{/if}
				{#each (['main', 'redemption'] as const) as bracketName}
					{@const bracket = tournament.brackets[bracketName]}
					{#if bracket}
						{@const totalM = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length}
						{@const doneM = bracket.matches.filter((m) => m.winnerId).length}
						<section class="min-w-0 rounded-xl border {bracketName === 'main' ? 'border-primary/20' : 'border-destructive/20'} bg-card/50 p-4">
							<div class="flex items-center justify-between mb-2">
								<h2 class="text-sm font-bold {bracketName === 'main' ? 'text-primary' : 'text-destructive'}">
									{bracketName === 'main' ? 'Main Bracket' : 'Redemption Bracket'}
								</h2>
								<span class="text-xs text-muted-foreground">{doneM}/{totalM} matches</span>
							</div>
							<div class="overflow-x-auto">
								<BracketView bracket={bracket} entrants={tournament.entrants} />
							</div>
						</section>
					{/if}
				{/each}
				</div>
			{/if}

			<!-- Swiss rounds history (all rounds, most recent first) -->
			{#if tournament.rounds.length > 0}
				<div>
					<h2 class="text-base font-bold text-foreground mb-3">Swiss Rounds</h2>
					<div class="space-y-4">
						{#each [...tournament.rounds].reverse() as round}
							{@const isOpen = expandedRounds.has(round.number) || round.status === 'active'}
							<div>
								<button onclick={() => {
									const next = new Set(expandedRounds);
									if (next.has(round.number)) next.delete(round.number); else next.add(round.number);
									expandedRounds = next;
								}} class="cursor-pointer select-none flex items-center gap-2 text-sm font-medium text-foreground w-full text-left min-w-0 overflow-hidden">
									<span class="text-muted-foreground">{isOpen ? '▾' : '▸'}</span>
									<span>Round {round.number}</span>
									<span class="rounded-full px-2 py-0.5 text-xs {round.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}">{round.status}</span>
									{#if round.byePlayerId}
										<span class="text-xs text-warning truncate">BYE: {getEntrant(round.byePlayerId)?.gamerTag}</span>
									{/if}
								</button>
								{#if isOpen}
								<div class="mt-2 space-y-1 pl-2">
									{#each round.matches as match}
										{@const top = getEntrant(match.topPlayerId)}
										{@const bot = getEntrant(match.bottomPlayerId)}
										<div class="flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-sm min-w-0">
											<span class="text-xs {match.isStream ? 'text-primary' : 'text-muted-foreground'} w-14 shrink-0">
												{match.isStream ? 'STREAM' : `Stn ${match.station}`}
											</span>
											<span class="{match.winnerId === match.topPlayerId ? 'text-success font-medium' : match.winnerId ? 'text-muted-foreground' : 'text-foreground'} flex-1 truncate">
												{top?.gamerTag ?? '?'}
											</span>
											{#if match.topScore !== undefined && match.bottomScore !== undefined}
												<span class="text-xs text-muted-foreground shrink-0">{match.topScore}–{match.bottomScore}</span>
											{:else}
												<span class="text-xs text-muted-foreground shrink-0">vs</span>
											{/if}
											<span class="{match.winnerId === match.bottomPlayerId ? 'text-success font-medium' : match.winnerId ? 'text-muted-foreground' : 'text-foreground'} flex-1 truncate text-right">
												{bot?.gamerTag ?? '?'}
											</span>
										</div>
									{/each}
								</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Standings -->
			{#if tournament.phase === 'swiss' && tournament.currentRound > 0}
				<details>
					<summary class="cursor-pointer select-none text-sm font-medium text-muted-foreground hover:text-foreground">Standings</summary>
					<div class="mt-2 overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-border text-left text-xs text-muted-foreground">
									<th class="px-2 py-1.5">Tag</th>
									<th class="px-2 py-1.5 text-right">Seed</th>
									<th class="px-2 py-1.5 text-right">W</th>
									<th class="px-2 py-1.5 text-right">L</th>
								</tr>
							</thead>
							<tbody>
								{#each getStandings() as e}
									<tr class="border-b border-border hover:bg-card/50">
										<td class="px-2 py-1.5 text-foreground">{e.gamerTag}</td>
										<td class="px-2 py-1.5 text-right font-mono text-muted-foreground text-xs">#{e.initialSeed}</td>
										<td class="px-2 py-1.5 text-right font-mono text-success">{e.wins}</td>
										<td class="px-2 py-1.5 text-right font-mono text-destructive">{e.losses}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{/if}

			{#if tournament.phase === 'completed' && tournament.finalStandings}
				<div class="rounded-xl border border-border bg-card p-5 text-center">
					<p class="text-lg font-bold text-foreground">Tournament Complete</p>
					<p class="mt-1 text-sm text-muted-foreground">Champion: <span class="text-primary font-semibold">{tournament.finalStandings[0]?.gamerTag}</span></p>
				</div>
			{/if}
		{/if}
	</div>
</div>
