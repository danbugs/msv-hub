<script lang="ts">
	import { onMount } from 'svelte';
	import type { BracketMatch, BracketState, Entrant } from '$lib/types/tournament';

	interface MatchPos { match: BracketMatch; x: number; y: number; }
	interface Connector { x1: number; y1: number; mx: number; x2: number; y2: number; }
	interface BracketLayout { matchPositions: MatchPos[]; connectors: Connector[]; width: number; height: number; }

	interface Props {
		bracket: BracketState;
		entrants: Entrant[];
		/** If provided, Report/Fix buttons appear on match cards. */
		onReport?: (match: BracketMatch) => void;
		/** If provided, Call/Uncall buttons appear on ready match cards. */
		onCall?: (match: BracketMatch) => void;
		/** If provided, a stream button appears on ready match cards. */
		onStream?: (match: BracketMatch) => void;
	}

	let { bracket, entrants, onReport, onCall, onStream }: Props = $props();

	let showProjected = $state(false);
	let now = $state(Date.now());
	onMount(() => {
		const id = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(id);
	});

	function elapsed(calledAt: number): string {
		const s = Math.floor((now - calledAt) / 1000);
		return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
	}

	const CARD_W = 192;
	const CARD_H = 100;
	const H_GAP = 40;
	const BASE_SLOT_H = 120;

	function getEntrant(id?: string): Entrant | undefined {
		if (!id) return undefined;
		return entrants.find((e) => e.id === id);
	}

	/** Compute projected players for unplayed matches (higher seed always wins) */
	const projectedPlayers = $derived.by(() => {
		if (!showProjected) return new Map<string, { top?: string; bottom?: string }>();
		const seedMap = new Map(bracket.players.map((p) => [p.entrantId, p.seed]));
		const projected = new Map<string, { top?: string; bottom?: string }>();

		// Clone match state
		const matchState = new Map(bracket.matches.map((m) => [m.id, {
			topPlayerId: m.topPlayerId,
			bottomPlayerId: m.bottomPlayerId,
			winnerId: m.winnerId,
			loserId: m.topPlayerId && m.bottomPlayerId && m.winnerId
				? (m.winnerId === m.topPlayerId ? m.bottomPlayerId : m.topPlayerId)
				: undefined,
			winnerNextMatchId: m.winnerNextMatchId,
			winnerNextSlot: m.winnerNextSlot,
			loserNextMatchId: m.loserNextMatchId,
			loserNextSlot: m.loserNextSlot,
		}]));

		// Simulate: process matches in round order (positive first, then negative)
		const sortedIds = bracket.matches
			.map((m) => m.id)
			.sort((a, b) => {
				const ma = matchState.get(a)!;
				const mb = matchState.get(b)!;
				const ra = bracket.matches.find((m) => m.id === a)!.round;
				const rb = bracket.matches.find((m) => m.id === b)!.round;
				// Process positive rounds first (ascending), then negative (ascending by abs)
				if (ra > 0 && rb > 0) return ra - rb;
				if (ra > 0 && rb < 0) return -1;
				if (ra < 0 && rb > 0) return 1;
				return Math.abs(ra) - Math.abs(rb);
			});

		for (const matchId of sortedIds) {
			const ms = matchState.get(matchId)!;
			if (!ms.topPlayerId || !ms.bottomPlayerId) continue;
			if (ms.winnerId) {
				// Already reported — advance as-is
			} else {
				// Project: higher seed wins
				const topSeed = seedMap.get(ms.topPlayerId) ?? Infinity;
				const botSeed = seedMap.get(ms.bottomPlayerId) ?? Infinity;
				ms.winnerId = topSeed <= botSeed ? ms.topPlayerId : ms.bottomPlayerId;
				ms.loserId = topSeed <= botSeed ? ms.bottomPlayerId : ms.topPlayerId;
				projected.set(matchId, { top: ms.topPlayerId, bottom: ms.bottomPlayerId });
			}
			// Advance winner
			if (ms.winnerNextMatchId) {
				const next = matchState.get(ms.winnerNextMatchId);
				if (next) {
					if (ms.winnerNextSlot === 'top') next.topPlayerId = ms.winnerId;
					else next.bottomPlayerId = ms.winnerId;
				}
			}
			// Advance loser
			if (ms.loserNextMatchId && ms.loserId) {
				const next = matchState.get(ms.loserNextMatchId);
				if (next) {
					if (ms.loserNextSlot === 'top') next.topPlayerId = ms.loserId;
					else next.bottomPlayerId = ms.loserId;
				}
			}
		}

		// Build projection map: for each match that doesn't have players yet, show projected players
		const result = new Map<string, { top?: string; bottom?: string }>();
		for (const m of bracket.matches) {
			const ms = matchState.get(m.id)!;
			if (!m.topPlayerId && ms.topPlayerId) result.set(m.id, { ...result.get(m.id), top: ms.topPlayerId });
			if (!m.bottomPlayerId && ms.bottomPlayerId) result.set(m.id, { ...result.get(m.id), bottom: ms.bottomPlayerId });
		}
		return result;
	});

	function getRoundName(round: number, isGFR: boolean): string {
		if (isGFR) return 'Grand Final Reset';
		const maxW = Math.max(...bracket.matches.filter((m) => m.round > 0 && !m.id.includes('-GFR-')).map((m) => m.round));
		const maxL = Math.max(...bracket.matches.filter((m) => m.round < 0).map((m) => Math.abs(m.round)), 0);
		if (round > 0) {
			if (round === maxW) return 'Grand Final';
			if (round === maxW - 1) return 'Winners Final';
			if (round === maxW - 2) return 'Winners Semi-Final';
			if (round === maxW - 3) return 'Winners Quarter-Final';
			return `Winners Round ${round}`;
		} else {
			const absR = Math.abs(round);
			if (absR === maxL) return 'Losers Final';
			if (absR === maxL - 1) return 'Losers Semi-Final';
			if (absR === maxL - 2) return 'Losers Quarter-Final';
			return `Losers Round ${absR}`;
		}
	}

	/** Can this match be fixed? Only if ALL downstream matches are unreported (recursive). */
	function canFix(match: BracketMatch): boolean {
		if (!match.winnerId) return false;
		const allMatches = bracket.matches;

		// Special case: GF can't be fixed if GF Reset has been reported.
		// (GF doesn't have winnerNextMatchId pointing to GFR in our data model.)
		const isGF = match.id.includes('-GF-') && !match.id.includes('-GFR-');
		if (isGF) {
			const gfr = allMatches.find((m) => m.id.includes('-GFR-'));
			if (gfr?.winnerId) return false;
		}

		const checked = new Set<string>();
		function anyDownstreamReported(m: BracketMatch): boolean {
			if (checked.has(m.id)) return false;
			checked.add(m.id);
			for (const nextId of [m.winnerNextMatchId, m.loserNextMatchId]) {
				if (!nextId) continue;
				const next = allMatches.find((n) => n.id === nextId);
				if (!next) continue;
				if (next.winnerId) return true;
				if (anyDownstreamReported(next)) return true;
			}
			return false;
		}

		return !anyDownstreamReported(match);
	}

	function computeLayout(b: BracketState): BracketLayout {
		const allMatches = b.matches;

		const byRound = new Map<number, BracketMatch[]>();
		for (const m of allMatches) {
			if (!byRound.has(m.round)) byRound.set(m.round, []);
			byRound.get(m.round)!.push(m);
		}
		for (const [, ms] of byRound) ms.sort((a, x) => a.matchIndex - x.matchIndex);

		const maxRound = Math.max(...allMatches.map((m) => m.round));
		const hasGFR = allMatches.some((m) => m.id.includes('-GFR-'));
		const gfRound = hasGFR ? maxRound - 1 : maxRound;
		const gfrRound = hasGFR ? maxRound : null;

		const winRounds = [...byRound.keys()].filter((r) => r > 0 && r < gfRound).sort((a, x) => a - x);
		const losRounds = [...byRound.keys()].filter((r) => r < 0).sort((a, x) => Math.abs(a) - Math.abs(x));

		const firstWinRound = winRounds[0] ?? 1;
		const maxMatchesW = byRound.get(firstWinRound)?.length ?? 1;
		const maxMatchesL = losRounds.length > 0 ? (byRound.get(losRounds[0])?.length ?? 0) : 0;

		const winnersH = Math.max(maxMatchesW * BASE_SLOT_H, CARD_H + 8);
		const losersH = Math.max(maxMatchesL * BASE_SLOT_H, maxMatchesL > 0 ? CARD_H + 8 : 0);
		const SECTION_GAP = losersH > 0 ? 48 : 0;
		const losersSectionY = winnersH + SECTION_GAP;

		const posMap = new Map<string, { x: number; y: number }>();

		for (let ri = 0; ri < winRounds.length; ri++) {
			const round = winRounds[ri];
			const ms = byRound.get(round)!;
			const numM = ms.length;
			const slotH = winnersH / numM;
			const colX = ri * (CARD_W + H_GAP);
			for (let mi = 0; mi < numM; mi++) {
				posMap.set(ms[mi].id, { x: colX, y: mi * slotH + (slotH - CARD_H) / 2 });
			}
		}

		const gfMs = byRound.get(gfRound);
		const gfColX = winRounds.length * (CARD_W + H_GAP);
		if (gfMs?.length) {
			posMap.set(gfMs[0].id, { x: gfColX, y: (winnersH - CARD_H) / 2 });
		}

		if (gfrRound !== null) {
			const gfrMs = byRound.get(gfrRound);
			if (gfrMs?.length) {
				posMap.set(gfrMs[0].id, { x: gfColX + CARD_W + H_GAP, y: (winnersH - CARD_H) / 2 });
			}
		}

		for (let ri = 0; ri < losRounds.length; ri++) {
			const round = losRounds[ri];
			const ms = byRound.get(round)!;
			const numM = ms.length;
			const slotH = losersH > 0 ? losersH / numM : BASE_SLOT_H;
			const colX = ri * (CARD_W + H_GAP);
			for (let mi = 0; mi < numM; mi++) {
				posMap.set(ms[mi].id, { x: colX, y: losersSectionY + mi * slotH + (slotH - CARD_H) / 2 });
			}
		}

		const connectors: Connector[] = [];
		for (const match of allMatches) {
			const from = posMap.get(match.id);
			if (!from || !match.winnerNextMatchId) continue;
			const to = posMap.get(match.winnerNextMatchId);
			if (!to) continue;
			const x1 = from.x + CARD_W;
			const y1 = from.y + CARD_H / 2;
			const mx = x1 + H_GAP / 2;
			connectors.push({ x1, y1, mx, x2: to.x, y2: to.y + CARD_H / 2 });
		}

		if (gfrRound !== null) {
			const gfPos = gfMs?.length ? posMap.get(gfMs[0].id) : undefined;
			const gfrMs2 = byRound.get(gfrRound);
			const gfrPos = gfrMs2?.length ? posMap.get(gfrMs2[0].id) : undefined;
			if (gfPos && gfrPos) {
				const x1 = gfPos.x + CARD_W;
				const y1 = gfPos.y + CARD_H / 2;
				connectors.push({ x1, y1, mx: x1 + H_GAP / 2, x2: gfrPos.x, y2: gfrPos.y + CARD_H / 2 });
			}
		}

		let maxX = 0, maxY = 0;
		for (const [, p] of posMap) {
			maxX = Math.max(maxX, p.x + CARD_W);
			maxY = Math.max(maxY, p.y + CARD_H);
		}

		return {
			matchPositions: allMatches
				.map((m) => ({ match: m, ...(posMap.get(m.id) ?? { x: 0, y: 0 }) }))
				.filter((mp) => posMap.has(mp.match.id)),
			connectors,
			width: maxX + 16,
			height: maxY + 16
		};
	}

	const layout = $derived(computeLayout(bracket));
	// Separate winners and losers round labels (they can share x-positions)
	const winnersRoundLabels = $derived(
		[...new Map(
			layout.matchPositions
				.filter((mp) => mp.match.round > 0 || mp.match.id.includes('-GFR-'))
				.map((mp) => [mp.x, mp.match] as [number, BracketMatch])
		).entries()].sort((a, b) => a[0] - b[0])
	);
	const losersRoundLabels = $derived(
		[...new Map(
			layout.matchPositions
				.filter((mp) => mp.match.round < 0 && !mp.match.id.includes('-GFR-'))
				.map((mp) => [mp.x, mp.match] as [number, BracketMatch])
		).entries()].sort((a, b) => a[0] - b[0])
	);
	const losersSectionY = $derived(
		layout.matchPositions.filter((mp) => mp.match.round < 0).reduce((min, mp) => Math.min(min, mp.y), Infinity)
	);
</script>

<div class="mb-2">
	<label class="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
		<input type="checkbox" bind:checked={showProjected}
			class="rounded border-input bg-background text-primary focus:ring-ring" />
		Show Projected
	</label>
</div>
<div class="overflow-x-auto rounded-xl border border-border bg-background/60 p-5 cursor-grab active:cursor-grabbing"
	role="region" aria-label="Bracket"
	onmousedown={(e) => {
		const el = e.currentTarget;
		if ((e.target as HTMLElement).closest('button, a, input, label')) return;
		e.preventDefault();
		const startX = e.clientX;
		const startScroll = el.scrollLeft;
		el.style.cursor = 'grabbing';
		const onMove = (ev: MouseEvent) => { el.scrollLeft = startScroll - (ev.clientX - startX); };
		const onUp = () => { el.style.cursor = ''; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}}>
	<!-- Winners round labels -->
	<div class="relative" style="width: {layout.width}px; height: 20px; margin-bottom: 4px">
		{#each winnersRoundLabels as [x, match]}
			<div class="absolute text-[11px] font-semibold text-muted-foreground uppercase tracking-wider truncate" style="left: {x}px; width: {CARD_W}px">
				{getRoundName(match.round, match.id.includes('-GFR-'))}
			</div>
		{/each}
	</div>
	<div class="relative" style="width: {layout.width}px; height: {layout.height}px">
		<!-- Losers round labels (inside bracket at losers section y) -->
		{#if losersRoundLabels.length > 0 && losersSectionY < Infinity}
			{#each losersRoundLabels as [x, match]}
				<div class="absolute text-[11px] font-semibold text-muted-foreground uppercase tracking-wider truncate pointer-events-none"
					style="left: {x}px; top: {losersSectionY - 20}px; width: {CARD_W}px">
					{getRoundName(match.round, false)}
				</div>
			{/each}
		{/if}
		<svg class="absolute inset-0 pointer-events-none overflow-visible"
			width={layout.width} height={layout.height}>
			{#each layout.connectors as c}
				<line x1={c.x1} y1={c.y1} x2={c.mx} y2={c.y1} stroke="var(--bracket-connector)" stroke-width="1.5" stroke-linecap="round" />
				{#if c.y1 !== c.y2}
					<line x1={c.mx} y1={c.y1} x2={c.mx} y2={c.y2} stroke="var(--bracket-connector)" stroke-width="1.5" stroke-linecap="round" />
				{/if}
				<line x1={c.mx} y1={c.y2} x2={c.x2} y2={c.y2} stroke="var(--bracket-connector)" stroke-width="1.5" stroke-linecap="round" />
			{/each}
		</svg>

		{#each layout.matchPositions as { match, x, y }}
			{@const proj = projectedPlayers.get(match.id)}
			{@const topId = match.topPlayerId ?? proj?.top}
			{@const botId = match.bottomPlayerId ?? proj?.bottom}
			{@const top = getEntrant(topId)}
			{@const bot = getEntrant(botId)}
			{@const topIsProjected = !match.topPlayerId && !!proj?.top}
			{@const botIsProjected = !match.bottomPlayerId && !!proj?.bottom}
			{@const ready = !match.winnerId && !!match.topPlayerId && !!match.bottomPlayerId}
			{@const called = ready && !!match.calledAt}
			{@const accent = called ? 'var(--accent-called)' : match.isStream && ready ? 'var(--accent-stream)' : ready ? 'var(--accent-ready)' : match.winnerId ? 'var(--accent-completed)' : 'var(--accent-waiting)'}

			<div class="absolute rounded-lg border border-border overflow-hidden bg-card match-card {called ? 'msv-pulse accent-glow-called' : ''} {ready ? 'match-card-interactive' : ''}"
				style="left: {x}px; top: {y}px; width: {CARD_W}px; border-left: 3px solid {accent}">

				<!-- Top player -->
				<div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/50
					{match.winnerId === match.topPlayerId ? 'bg-bracket-winner-bg' :
					 match.winnerId && match.topPlayerId ? 'opacity-40' : ''}">
					<span class="text-[10px] font-mono text-muted-foreground w-5 text-right shrink-0 tabular-nums">
						{top ? top.initialSeed : ''}
					</span>
					<span class="flex-1 truncate text-sm {topIsProjected ? 'text-bracket-projected italic' : match.winnerId === match.topPlayerId ? 'text-bracket-winner font-semibold' : 'text-foreground font-medium'}">
						{top?.gamerTag ?? (match.topPlayerId ? '?' : '—')}
					</span>
					{#if match.topScore !== undefined}
						<span class="text-xs font-mono tabular-nums {match.winnerId === match.topPlayerId ? 'text-bracket-winner font-bold' : 'text-muted-foreground'} shrink-0">
							{match.topScore}
						</span>
					{/if}
				</div>

				<!-- Bottom player -->
				<div class="flex items-center gap-1.5 px-2 py-1.5
					{match.winnerId === match.bottomPlayerId ? 'bg-bracket-winner-bg' :
					 match.winnerId && match.bottomPlayerId ? 'opacity-40' : ''}">
					<span class="text-[10px] font-mono text-muted-foreground w-5 text-right shrink-0 tabular-nums">
						{bot ? bot.initialSeed : ''}
					</span>
					<span class="flex-1 truncate text-sm {botIsProjected ? 'text-bracket-projected italic' : match.winnerId === match.bottomPlayerId ? 'text-bracket-winner font-semibold' : 'text-foreground font-medium'}">
						{bot?.gamerTag ?? (match.bottomPlayerId ? '?' : '—')}
					</span>
					{#if match.bottomScore !== undefined}
						<span class="text-xs font-mono tabular-nums {match.winnerId === match.bottomPlayerId ? 'text-bracket-winner font-bold' : 'text-muted-foreground'} shrink-0">
							{match.bottomScore}
						</span>
					{/if}
				</div>

				<!-- Characters (if reported) -->
				{#if match.winnerId && (match.topCharacters?.length || match.bottomCharacters?.length)}
					<div class="px-2 py-1 text-xs text-muted-foreground border-t border-border/50 leading-relaxed">
						{#if match.topCharacters?.length}<span class="text-muted-foreground">{top?.gamerTag}:</span> {match.topCharacters.join(', ')}{/if}{#if match.topCharacters?.length && match.bottomCharacters?.length} · {/if}{#if match.bottomCharacters?.length}<span class="text-muted-foreground">{bot?.gamerTag}:</span> {match.bottomCharacters.join(', ')}{/if}
					</div>
				{/if}

				<!-- Footer: station + action buttons -->
				{#if ready || match.winnerId}
					<div class="flex items-center justify-between px-2 py-1 border-t border-border/50 bg-muted/20">
						<div class="flex items-center gap-1.5 min-w-0 overflow-hidden">
							{#if match.station !== undefined}
								{#if match.isStream}
									<a href="https://twitch.tv/microspacing" target="_blank"
										class="text-xs text-primary hover:text-primary/80 shrink-0">STREAM ↗</a>
								{:else}
									<span class="text-xs text-muted-foreground shrink-0">Stn {match.station}</span>
								{/if}
							{:else if ready}
								<span class="text-xs text-warning shrink-0">Waiting</span>
							{/if}
						</div>
						<div class="flex items-center gap-1 shrink-0">
							{#if onCall && ready}
								<button onclick={() => onCall!(match)}
									class="rounded px-2 py-0.5 text-xs font-medium transition-colors
										{called ? 'bg-amber-900/30 text-amber-400 hover:bg-amber-900/50' : 'border border-border text-muted-foreground hover:text-amber-400 hover:border-amber-600'}">
									{#if called && match.calledAt}{elapsed(match.calledAt)}{:else}{called ? 'Called' : 'Call'}{/if}
								</button>
							{/if}
							{#if onStream && ready}
								<button onclick={() => onStream!(match)}
									class="rounded px-1.5 py-0.5 text-xs transition-colors inline-flex items-center
										{match.isStream ? 'text-primary bg-primary/10 hover:bg-red-900/20 hover:text-red-400' : 'text-muted-foreground hover:text-primary hover:bg-primary/10'}"
									title={match.isStream ? 'Remove from stream' : 'Set as stream match'}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<rect x="2" y="3" width="20" height="14" rx="2" />
										<path d="M8 21h8" /><path d="M12 17v4" />
									</svg>
								</button>
							{/if}
							{#if onReport}
								{#if ready}
									<button onclick={() => onReport!(match)}
										class="rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
										Report
									</button>
								{:else if match.winnerId && match.topPlayerId && match.bottomPlayerId && canFix(match)}
									<button onclick={() => onReport!(match)}
										class="rounded border border-yellow-700/50 px-2 py-0.5 text-xs text-yellow-500 hover:bg-yellow-900/20">
										Fix
									</button>
								{/if}
							{/if}
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
