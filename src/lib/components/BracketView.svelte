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

<div class="overflow-x-auto rounded-xl border border-gray-800 bg-gray-950 p-4">
	<!-- Winners round labels -->
	<div class="relative" style="width: {layout.width}px; height: 16px; margin-bottom: 2px">
		{#each winnersRoundLabels as [x, match]}
			<div class="absolute text-xs text-gray-500 font-medium truncate" style="left: {x}px; width: {CARD_W}px">
				{getRoundName(match.round, match.id.includes('-GFR-'))}
			</div>
		{/each}
	</div>
	<div class="relative" style="width: {layout.width}px; height: {layout.height}px">
		<!-- Losers round labels (inside bracket at losers section y) -->
		{#if losersRoundLabels.length > 0 && losersSectionY < Infinity}
			{#each losersRoundLabels as [x, match]}
				<div class="absolute text-xs text-gray-500 font-medium truncate pointer-events-none"
					style="left: {x}px; top: {losersSectionY - 20}px; width: {CARD_W}px">
					{getRoundName(match.round, false)}
				</div>
			{/each}
		{/if}
		<svg class="absolute inset-0 pointer-events-none overflow-visible"
			width={layout.width} height={layout.height}>
			{#each layout.connectors as c}
				<line x1={c.x1} y1={c.y1} x2={c.mx} y2={c.y1} stroke="#374151" stroke-width="1.5" />
				{#if c.y1 !== c.y2}
					<line x1={c.mx} y1={c.y1} x2={c.mx} y2={c.y2} stroke="#374151" stroke-width="1.5" />
				{/if}
				<line x1={c.mx} y1={c.y2} x2={c.x2} y2={c.y2} stroke="#374151" stroke-width="1.5" />
			{/each}
		</svg>

		{#each layout.matchPositions as { match, x, y }}
			{@const top = getEntrant(match.topPlayerId)}
			{@const bot = getEntrant(match.bottomPlayerId)}
			{@const ready = !match.winnerId && !!match.topPlayerId && !!match.bottomPlayerId}
			{@const called = ready && !!match.calledAt}

			<div class="absolute rounded-lg border bg-gray-900 overflow-hidden"
				style="left: {x}px; top: {y}px; width: {CARD_W}px"
				class:border-green-600={called}
				class:border-violet-600={match.isStream && ready && !called}
				class:border-gray-700={!match.isStream && !called}>

				<!-- Top player -->
				<div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-800
					{match.winnerId === match.topPlayerId ? 'bg-green-900/20' :
					 match.winnerId && match.topPlayerId ? 'opacity-40' : ''}">
					<span class="text-xs text-gray-500 w-6 text-right shrink-0">
						{top ? `#${top.initialSeed}` : ''}
					</span>
					<span class="flex-1 truncate text-sm {match.winnerId === match.topPlayerId ? 'text-green-300 font-medium' : 'text-white'}">
						{top?.gamerTag ?? (match.topPlayerId ? '?' : '—')}
					</span>
					{#if match.topScore !== undefined}
						<span class="text-xs font-mono {match.winnerId === match.topPlayerId ? 'text-green-400' : 'text-gray-500'} shrink-0">
							{match.topScore}
						</span>
					{/if}
				</div>

				<!-- Bottom player -->
				<div class="flex items-center gap-1.5 px-2 py-1.5
					{match.winnerId === match.bottomPlayerId ? 'bg-green-900/20' :
					 match.winnerId && match.bottomPlayerId ? 'opacity-40' : ''}">
					<span class="text-xs text-gray-500 w-6 text-right shrink-0">
						{bot ? `#${bot.initialSeed}` : ''}
					</span>
					<span class="flex-1 truncate text-sm {match.winnerId === match.bottomPlayerId ? 'text-green-300 font-medium' : 'text-white'}">
						{bot?.gamerTag ?? (match.bottomPlayerId ? '?' : '—')}
					</span>
					{#if match.bottomScore !== undefined}
						<span class="text-xs font-mono {match.winnerId === match.bottomPlayerId ? 'text-green-400' : 'text-gray-500'} shrink-0">
							{match.bottomScore}
						</span>
					{/if}
				</div>

				<!-- Characters (if reported) -->
				{#if match.winnerId && (match.topCharacters?.length || match.bottomCharacters?.length)}
					<div class="px-2 py-1 text-xs text-gray-500 border-t border-gray-800 leading-relaxed">
						{#if match.topCharacters?.length}<span class="text-gray-400">{top?.gamerTag}:</span> {match.topCharacters.join(', ')}{/if}{#if match.topCharacters?.length && match.bottomCharacters?.length} · {/if}{#if match.bottomCharacters?.length}<span class="text-gray-400">{bot?.gamerTag}:</span> {match.bottomCharacters.join(', ')}{/if}
					</div>
				{/if}

				<!-- Footer: station + action buttons -->
				{#if ready || match.winnerId}
					<div class="flex items-center justify-between px-2 py-1 border-t border-gray-800 bg-gray-900/50">
						<div class="flex items-center gap-1.5 min-w-0 overflow-hidden">
							{#if match.station !== undefined}
								{#if match.isStream}
									<a href="https://twitch.tv/microspacing" target="_blank"
										class="text-xs text-violet-400 hover:text-violet-300 shrink-0">STREAM ↗</a>
								{:else}
									<span class="text-xs text-gray-500 shrink-0">Stn {match.station}</span>
								{/if}
							{/if}
						</div>
						<div class="flex items-center gap-1 shrink-0">
							{#if onCall && ready}
								<button onclick={() => onCall!(match)}
									class="rounded px-2 py-0.5 text-xs font-medium transition-colors
										{called ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60' : 'border border-gray-600 text-gray-400 hover:text-green-400 hover:border-green-600'}">
									{#if called && match.calledAt}{elapsed(match.calledAt)}{:else}{called ? 'Called' : 'Call'}{/if}
								</button>
							{/if}
							{#if onStream && ready && !match.isStream}
								<button onclick={() => onStream!(match)}
									class="rounded px-2 py-0.5 text-xs text-gray-500 hover:text-violet-400 hover:bg-violet-900/20 transition-colors"
									title="Set as stream match">
									📺
								</button>
							{/if}
							{#if onReport}
								{#if ready}
									<button onclick={() => onReport!(match)}
										class="rounded bg-violet-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-violet-600">
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
