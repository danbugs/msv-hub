<script lang="ts">
	import { onMount } from 'svelte';
	import type { TournamentState, BracketMatch, BracketState, Entrant } from '$lib/types/tournament';

	let tournament = $state<TournamentState | null>(null);
	let activeBracket = $state<'main' | 'redemption'>('main');
	let error = $state('');

	let reportingMatch = $state<BracketMatch | null>(null);
	let reportWinnerId = $state('');
	let reportScore = $state('');
	let reportTopChar = $state('');
	let reportBotChar = $state('');

	const CHARACTERS = [
		'Mario', 'Donkey Kong', 'Link', 'Samus', 'Dark Samus', 'Yoshi', 'Kirby', 'Fox',
		'Pikachu', 'Luigi', 'Ness', 'Captain Falcon', 'Jigglypuff', 'Peach', 'Daisy', 'Bowser',
		'Ice Climbers', 'Sheik', 'Zelda', 'Dr. Mario', 'Pichu', 'Falco', 'Marth', 'Lucina',
		'Young Link', 'Ganondorf', 'Mewtwo', 'Roy', 'Chrom', 'Mr. Game & Watch', 'Meta Knight',
		'Pit', 'Dark Pit', 'Zero Suit Samus', 'Wario', 'Snake', 'Ike', 'Pokemon Trainer',
		'Diddy Kong', 'Lucas', 'Sonic', 'King Dedede', 'Olimar', 'Lucario', 'R.O.B.', 'Toon Link',
		'Wolf', 'Villager', 'Mega Man', 'Wii Fit Trainer', 'Rosalina & Luma', 'Little Mac',
		'Greninja', 'Palutena', 'Pac-Man', 'Robin', 'Shulk', 'Bowser Jr.', 'Duck Hunt',
		'Ryu', 'Ken', 'Cloud', 'Corrin', 'Bayonetta', 'Inkling', 'Ridley', 'Simon', 'Richter',
		'King K. Rool', 'Isabelle', 'Incineroar', 'Piranha Plant', 'Joker', 'Hero',
		'Banjo & Kazooie', 'Terry', 'Byleth', 'Min Min', 'Steve', 'Sephiroth', 'Pyra/Mythra',
		'Kazuya', 'Sora'
	];

	const inputClass = 'mt-1 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500';

	// ── Layout constants ──────────────────────────────────────────────────
	const CARD_W = 192;
	const CARD_H = 68;
	const H_GAP = 40;   // horizontal gap between card columns
	const BASE_SLOT_H = 88; // slot height for first round (CARD_H + min vertical gap)

	onMount(loadTournament);

	async function loadTournament() {
		const res = await fetch('/api/tournament');
		if (res.ok) tournament = await res.json();
	}

	function getEntrant(id?: string): Entrant | undefined {
		if (!id) return undefined;
		return tournament?.entrants.find((e) => e.id === id);
	}

	function getBracket(): BracketState | undefined {
		return tournament?.brackets?.[activeBracket];
	}

	function isTop8Match(match: BracketMatch, bracket: BracketState): boolean {
		// GFR is always top 8
		if (match.id.includes('-GFR-')) return true;
		const totalPlayers = bracket.players.length;
		if (totalPlayers <= 8) return true;
		const maxWinnersRound = Math.max(...bracket.matches.filter((m) => m.round > 0).map((m) => m.round));
		if (match.round > 0) return match.round >= maxWinnersRound - 2;
		return match.round <= -(Math.max(...bracket.matches.filter((m) => m.round < 0).map((m) => Math.abs(m.round))) - 3);
	}

	function openReport(match: BracketMatch) {
		reportingMatch = match;
		reportWinnerId = '';
		reportScore = '';
		reportTopChar = '';
		reportBotChar = '';
	}

	function parseScore(score: string, winnerId: string, match: BracketMatch): [number, number] {
		const winnerIsTop = winnerId === match.topPlayerId;
		const [w, l] = score.split('-').map(Number);
		return winnerIsTop ? [w, l] : [l, w];
	}

	async function submitReport() {
		if (!reportingMatch || !reportWinnerId || !reportScore) return;
		error = '';

		const [topScore, bottomScore] = parseScore(reportScore, reportWinnerId, reportingMatch);

		const res = await fetch('/api/tournament/bracket', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				bracketName: activeBracket,
				matchId: reportingMatch.id,
				winnerId: reportWinnerId,
				topCharacter: reportTopChar || undefined,
				bottomCharacter: reportBotChar || undefined,
				topScore,
				bottomScore
			})
		});

		if (!res.ok) {
			const data = await res.json();
			error = data.error ?? 'Failed to report match';
		} else {
			reportingMatch = null;
			await loadTournament();
		}
	}

	// ── Visual bracket layout ─────────────────────────────────────────────

	interface MatchPos {
		match: BracketMatch;
		x: number;
		y: number;
	}

	interface Connector {
		x1: number; y1: number;
		mx: number;
		x2: number; y2: number;
	}

	interface BracketLayout {
		matchPositions: MatchPos[];
		connectors: Connector[];
		width: number;
		height: number;
	}

	function computeLayout(bracket: BracketState, sectionOffsetY = 0): BracketLayout {
		const allMatches = bracket.matches;

		// Group matches by round
		const byRound = new Map<number, BracketMatch[]>();
		for (const m of allMatches) {
			if (!byRound.has(m.round)) byRound.set(m.round, []);
			byRound.get(m.round)!.push(m);
		}
		for (const [, ms] of byRound) ms.sort((a, b) => a.matchIndex - b.matchIndex);

		const maxRound = Math.max(...allMatches.map((m) => m.round));
		// GFR is at maxRound if it exists; GF is the round just below it among positive rounds
		const hasGFR = allMatches.some((m) => m.id.includes('-GFR-'));
		const gfRound = hasGFR ? maxRound - 1 : maxRound;
		const gfrRound = hasGFR ? maxRound : null;

		const winRounds = [...byRound.keys()].filter((r) => r > 0 && r < gfRound).sort((a, b) => a - b);
		const losRounds = [...byRound.keys()].filter((r) => r < 0).sort((a, b) => Math.abs(a) - Math.abs(b));

		const firstWinRound = winRounds[0] ?? 1;
		const maxMatchesW = byRound.get(firstWinRound)?.length ?? 1;
		const maxMatchesL = losRounds.length > 0 ? (byRound.get(losRounds[0])?.length ?? 0) : 0;

		const winnersH = Math.max(maxMatchesW * BASE_SLOT_H, CARD_H + 8);
		const losersH = Math.max(maxMatchesL * BASE_SLOT_H, maxMatchesL > 0 ? CARD_H + 8 : 0);
		const SECTION_GAP = losersH > 0 ? 48 : 0;
		const losersSectionY = winnersH + SECTION_GAP;

		const posMap = new Map<string, { x: number; y: number }>();

		// Position winners matches
		for (let ri = 0; ri < winRounds.length; ri++) {
			const round = winRounds[ri];
			const ms = byRound.get(round)!;
			const numM = ms.length;
			const slotH = winnersH / numM;
			const colX = ri * (CARD_W + H_GAP);
			for (let mi = 0; mi < numM; mi++) {
				const y = sectionOffsetY + mi * slotH + (slotH - CARD_H) / 2;
				posMap.set(ms[mi].id, { x: colX, y });
			}
		}

		// Position GF
		const gfMs = byRound.get(gfRound);
		const gfColX = winRounds.length * (CARD_W + H_GAP);
		if (gfMs?.length) {
			posMap.set(gfMs[0].id, { x: gfColX, y: sectionOffsetY + (winnersH - CARD_H) / 2 });
		}

		// Position GFR (one column to the right of GF)
		if (gfrRound !== null) {
			const gfrMs = byRound.get(gfrRound);
			if (gfrMs?.length) {
				posMap.set(gfrMs[0].id, { x: gfColX + CARD_W + H_GAP, y: sectionOffsetY + (winnersH - CARD_H) / 2 });
			}
		}

		// Position losers matches
		for (let ri = 0; ri < losRounds.length; ri++) {
			const round = losRounds[ri];
			const ms = byRound.get(round)!;
			const numM = ms.length;
			const slotH = losersH > 0 ? losersH / numM : BASE_SLOT_H;
			const colX = ri * (CARD_W + H_GAP);
			for (let mi = 0; mi < numM; mi++) {
				const y = sectionOffsetY + losersSectionY + mi * slotH + (slotH - CARD_H) / 2;
				posMap.set(ms[mi].id, { x: colX, y });
			}
		}

		// Build connector lines (winner advancement paths)
		const connectors: Connector[] = [];
		for (const match of allMatches) {
			const from = posMap.get(match.id);
			if (!from || !match.winnerNextMatchId) continue;
			const to = posMap.get(match.winnerNextMatchId);
			if (!to) continue;

			const x1 = from.x + CARD_W;
			const y1 = from.y + CARD_H / 2;
			const x2 = to.x;
			const y2 = to.y + CARD_H / 2;
			const mx = x1 + H_GAP / 2;
			connectors.push({ x1, y1, mx, x2, y2 });
		}

		// GF → GFR connector (GF has no winnerNextMatchId since GFR is created dynamically)
		if (gfrRound !== null) {
			const gfPos = gfMs?.length ? posMap.get(gfMs[0].id) : undefined;
			const gfrMs = byRound.get(gfrRound);
			const gfrPos = gfrMs?.length ? posMap.get(gfrMs[0].id) : undefined;
			if (gfPos && gfrPos) {
				const x1 = gfPos.x + CARD_W;
				const y1 = gfPos.y + CARD_H / 2;
				connectors.push({ x1, y1, mx: x1 + H_GAP / 2, x2: gfrPos.x, y2: gfrPos.y + CARD_H / 2 });
			}
		}

		// Compute canvas size
		let maxX = 0, maxY = 0;
		for (const [, p] of posMap) {
			maxX = Math.max(maxX, p.x + CARD_W);
			maxY = Math.max(maxY, p.y + CARD_H);
		}

		const matchPositions: MatchPos[] = allMatches
			.map((m) => ({ match: m, ...(posMap.get(m.id) ?? { x: 0, y: 0 }) }))
			.filter((mp) => posMap.has(mp.match.id));

		return {
			matchPositions,
			connectors,
			width: maxX + 16,
			height: maxY + 16
		};
	}

	function roundLabel(round: number, maxRound: number): string {
		if (round === maxRound) return 'Grand Final';
		if (round > 0) {
			const winRounds = [...new Set([...Array(maxRound - 1)].map((_, i) => i + 1))];
			const max = winRounds[winRounds.length - 1] ?? round;
			if (round === max) return "Winners Finals";
			if (round === max - 1) return "Winners Semis";
			return `Winners R${round}`;
		}
		const absRound = Math.abs(round);
		return `Losers R${absRound}`;
	}
</script>

<main class="mx-auto max-w-7xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<div class="mt-4 flex flex-wrap items-center gap-4">
		<h1 class="text-2xl font-bold text-white">Brackets</h1>
		{#if tournament}
			<a href="/live/{tournament.slug}" target="_blank" class="text-xs text-gray-500 hover:text-violet-400">
				Live: /live/{tournament.slug} ↗
			</a>
			<a href="/api/tournament/export?slug={tournament.slug}" target="_blank"
				class="ml-auto text-xs text-gray-500 hover:text-violet-400">
				Export JSON ↗
			</a>
		{/if}
	</div>

	{#if error}
		<div class="mt-4 rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">{error}</div>
	{/if}

	{#if !tournament?.brackets}
		<div class="mt-6 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
			No brackets yet. Complete Swiss rounds first.
			<a href="/dashboard/tournament/swiss" class="block mt-2 text-violet-400 hover:text-violet-300">Go to Swiss &rarr;</a>
		</div>
	{:else}
		<!-- Bracket selector -->
		<div class="mt-4 flex gap-2">
			<button onclick={() => activeBracket = 'main'}
				class="rounded-lg px-4 py-2 text-sm font-medium transition-colors {activeBracket === 'main' ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
				Main Bracket
			</button>
			<button onclick={() => activeBracket = 'redemption'}
				class="rounded-lg px-4 py-2 text-sm font-medium transition-colors {activeBracket === 'redemption' ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}">
				Redemption Bracket
			</button>
		</div>

		{@const bracket = getBracket()}
		{#if bracket}
			{@const layout = computeLayout(bracket)}
			{@const maxRound = Math.max(...bracket.matches.map((m) => m.round))}
			{@const totalMatches = bracket.matches.filter((m) => m.topPlayerId && m.bottomPlayerId).length}
			{@const doneMatches = bracket.matches.filter((m) => m.winnerId).length}

			<div class="mt-2 text-xs text-gray-500">
				{bracket.players.length} players · {doneMatches}/{totalMatches} matches complete
				{#if bracket.matches.some((m) => m.isStream && !m.winnerId)}
					{@const streamM = bracket.matches.find((m) => m.isStream && !m.winnerId)!}
					· <span class="text-violet-400">Stream: {getEntrant(streamM.topPlayerId)?.gamerTag} vs {getEntrant(streamM.bottomPlayerId)?.gamerTag}</span>
				{/if}
			</div>

			<!-- Visual bracket (scrollable) -->
			<div class="mt-4 overflow-x-auto overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-4"
				style="max-height: 80vh">
				<div class="relative" style="width: {layout.width}px; height: {layout.height}px">
					<!-- Connector SVG -->
					<svg class="absolute inset-0 pointer-events-none overflow-visible"
						width={layout.width} height={layout.height}>
						{#each layout.connectors as c}
							<!-- Horizontal right arm from match -->
							<line x1={c.x1} y1={c.y1} x2={c.mx} y2={c.y1} stroke="#374151" stroke-width="1.5" />
							<!-- Vertical to next match's y level -->
							{#if c.y1 !== c.y2}
								<line x1={c.mx} y1={c.y1} x2={c.mx} y2={c.y2} stroke="#374151" stroke-width="1.5" />
							{/if}
							<!-- Horizontal arm into next match -->
							<line x1={c.mx} y1={c.y2} x2={c.x2} y2={c.y2} stroke="#374151" stroke-width="1.5" />
						{/each}
					</svg>

					<!-- Match cards -->
					{#each layout.matchPositions as { match, x, y }}
						{@const top = getEntrant(match.topPlayerId)}
						{@const bot = getEntrant(match.bottomPlayerId)}
						{@const ready = !match.winnerId && !!match.topPlayerId && !!match.bottomPlayerId}
						{@const showChars = isTop8Match(match, bracket)}

						<div class="absolute rounded-lg border bg-gray-900 overflow-hidden"
							style="left: {x}px; top: {y}px; width: {CARD_W}px"
							class:border-violet-600={match.isStream && ready}
							class:border-gray-700={!match.isStream || !ready}>

							<!-- Top player row -->
							<div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-800
								{match.winnerId === match.topPlayerId ? 'bg-green-900/20' :
								 match.winnerId && match.topPlayerId ? 'opacity-40' : ''}">
								<span class="text-xs text-gray-500 w-6 text-right shrink-0">
									{tournament?.entrants.find((e) => e.id === match.topPlayerId)
										? `#${tournament!.entrants.find((e) => e.id === match.topPlayerId)!.initialSeed}`
										: ''}
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

							<!-- Bottom player row -->
							<div class="flex items-center gap-1.5 px-2 py-1.5
								{match.winnerId === match.bottomPlayerId ? 'bg-green-900/20' :
								 match.winnerId && match.bottomPlayerId ? 'opacity-40' : ''}">
								<span class="text-xs text-gray-500 w-6 text-right shrink-0">
									{tournament?.entrants.find((e) => e.id === match.bottomPlayerId)
										? `#${tournament!.entrants.find((e) => e.id === match.bottomPlayerId)!.initialSeed}`
										: ''}
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

							<!-- Footer: station label + report/fix button -->
							{#if ready || match.winnerId}
								<div class="flex items-center justify-between px-2 py-1 border-t border-gray-800 bg-gray-900/50">
									{#if match.station !== undefined}
										<span class="text-xs {match.isStream ? 'text-violet-400' : 'text-gray-500'}">
											{match.isStream ? 'STREAM' : `Stn ${match.station}`}
										</span>
									{:else}
										<span></span>
									{/if}
									{#if ready}
										<button onclick={() => openReport(match)}
											class="rounded bg-violet-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-violet-600">
											Report
										</button>
									{:else if match.winnerId && match.topPlayerId && match.bottomPlayerId}
										<button onclick={() => openReport(match)}
											class="rounded border border-yellow-700/50 px-2 py-0.5 text-xs text-yellow-500 hover:bg-yellow-900/20">
											Fix
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Report modal -->
			{#if reportingMatch}
				{@const top = getEntrant(reportingMatch.topPlayerId)}
				{@const bot = getEntrant(reportingMatch.bottomPlayerId)}
				{@const isTop8 = bracket ? isTop8Match(reportingMatch, bracket) : false}
				{@const isBo5 = isTop8 && activeBracket === 'main'}
				{@const showChars = isTop8}

				<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
					<div class="w-full max-w-sm rounded-xl bg-gray-900 border border-gray-700 p-5">
						<div class="flex items-start justify-between">
							<div>
								<h3 class="text-base font-semibold text-white">Report Match</h3>
								<p class="text-sm text-gray-400 mt-0.5">{top?.gamerTag ?? '?'} vs {bot?.gamerTag ?? '?'}</p>
							</div>
							<span class="text-xs rounded-full px-2 py-0.5 {isBo5 ? 'bg-violet-900/60 text-violet-300' : 'bg-gray-800 text-gray-400'}">
								{isBo5 ? 'BO5' : 'BO3'}
							</span>
						</div>

						<!-- Step 1: Pick winner -->
						<div class="mt-4 flex gap-2">
							<button onclick={() => { reportWinnerId = reportingMatch!.topPlayerId!; reportScore = ''; }}
								class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors {reportWinnerId === reportingMatch.topPlayerId ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
								{top?.gamerTag ?? '?'}
							</button>
							<button onclick={() => { reportWinnerId = reportingMatch!.bottomPlayerId!; reportScore = ''; }}
								class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors {reportWinnerId === reportingMatch.bottomPlayerId ? 'bg-green-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
								{bot?.gamerTag ?? '?'}
							</button>
						</div>

						<!-- Step 2: Pick score (BO3 or BO5) -->
						{#if reportWinnerId}
							{#if isBo5}
								<div class="mt-3 grid grid-cols-3 gap-2">
									{#each ['3-0', '3-1', '3-2'] as s}
										<button onclick={() => reportScore = s}
											class="rounded-lg py-2 text-sm font-medium transition-colors {reportScore === s ? 'bg-violet-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
											{s.replace('-', ' – ')}
										</button>
									{/each}
								</div>
							{:else}
								<div class="mt-3 flex gap-2">
									{#each ['2-0', '2-1'] as s}
										<button onclick={() => reportScore = s}
											class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors {reportScore === s ? 'bg-violet-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
											{s.replace('-', ' – ')}
										</button>
									{/each}
								</div>
							{/if}
						{/if}

						<!-- Step 3: Characters (top 8 only) -->
						{#if reportWinnerId && showChars}
							<div class="mt-3 space-y-2">
								<div>
									<label for="top-char" class="block text-xs text-gray-400">{top?.gamerTag}'s character</label>
									<select id="top-char" bind:value={reportTopChar} class={inputClass}>
										<option value="">— select —</option>
										{#each CHARACTERS as char}
											<option value={char}>{char}</option>
										{/each}
									</select>
								</div>
								<div>
									<label for="bot-char" class="block text-xs text-gray-400">{bot?.gamerTag}'s character</label>
									<select id="bot-char" bind:value={reportBotChar} class={inputClass}>
										<option value="">— select —</option>
										{#each CHARACTERS as char}
											<option value={char}>{char}</option>
										{/each}
									</select>
								</div>
							</div>
						{/if}

						<div class="mt-5 flex gap-2">
							<button onclick={submitReport} disabled={!reportWinnerId || !reportScore}
								class="flex-1 rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
								Submit
							</button>
							<button onclick={() => reportingMatch = null}
								class="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-white">
								Cancel
							</button>
						</div>
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</main>
