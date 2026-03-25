<script lang="ts">
	import { onMount } from 'svelte';
	import { DEFAULT_MOTIVATIONAL_MESSAGES } from '$lib/defaults';

	// ---------------------------------------------------------------------------
	// Motivational messages
	// ---------------------------------------------------------------------------

	let motivationalText = $state('');
	let motivMessages = $derived(
		motivationalText
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
	);

	let saveMessagesRunning = $state(false);
	let saveMessagesResult = $state<{ ok: boolean; msg: string } | null>(null);

	let motivRunning = $state(false);
	let motivResult = $state<{ ok: boolean; msg: string } | null>(null);

	async function saveMessages() {
		saveMessagesRunning = true;
		saveMessagesResult = null;
		const res = await fetch('/api/discord/community', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'save_messages', messages: motivMessages })
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok) {
			saveMessagesResult = { ok: true, msg: `Saved ${(data as { saved?: number }).saved ?? motivMessages.length} messages.` };
		} else {
			saveMessagesResult = { ok: false, msg: (data as { error?: string }).error ?? `HTTP ${res.status}` };
		}
		saveMessagesRunning = false;
	}

	async function postMotivational() {
		motivRunning = true;
		motivResult = null;
		const res = await fetch('/api/discord/community', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'motivational', messages: motivMessages.length ? motivMessages : undefined })
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok) {
			const sent = (data as { sent?: string }).sent ?? '';
			motivResult = { ok: true, msg: `Posted: "${sent}"` };
		} else {
			motivResult = { ok: false, msg: (data as { error?: string }).error ?? `HTTP ${res.status}` };
		}
		motivRunning = false;
	}

	// ---------------------------------------------------------------------------
	// Fun commands
	// ---------------------------------------------------------------------------

	type FunResult = { ok: boolean; msg: string } | null;

	let diceResult = $state<FunResult>(null);
	let diceRunning = $state(false);

	let ynResult = $state<FunResult>(null);
	let ynRunning = $state(false);

	let goatResult = $state<FunResult>(null);
	let goatRunning = $state(false);

	let quoteResult = $state<FunResult>(null);
	let quoteRunning = $state(false);

	async function runAction(
		action: string,
		setRunning: (v: boolean) => void,
		setResult: (v: FunResult) => void,
		formatOk: (data: Record<string, unknown>) => string
	) {
		setRunning(true);
		setResult(null);
		const res = await fetch('/api/discord/community', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action })
		});
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (res.ok) {
			setResult({ ok: true, msg: formatOk(data) });
		} else {
			setResult({ ok: false, msg: (data['error'] as string | undefined) ?? `HTTP ${res.status}` });
		}
		setRunning(false);
	}

	async function rollDice() {
		await runAction(
			'dice',
			(v) => (diceRunning = v),
			(v) => (diceResult = v),
			(d) => `Posted: 🎲 Rolled a ${d['roll']}!`
		);
	}

	async function yesOrNo() {
		await runAction(
			'yes_or_no',
			(v) => (ynRunning = v),
			(v) => (ynResult = v),
			(d) => `Posted: ${d['answer']}`
		);
	}

	async function whosDaGoat() {
		await runAction(
			'goat',
			(v) => (goatRunning = v),
			(v) => (goatResult = v),
			(d) => `Posted: @${d['goat']} is da goat! 🐐`
		);
	}

	async function postQuote() {
		await runAction(
			'quote',
			(v) => (quoteRunning = v),
			(v) => (quoteResult = v),
			(d) => `Posted quote by ${d['author']}.`
		);
	}

	// Load saved messages on mount
	onMount(async () => {
		const res = await fetch('/api/discord/config');
		// Community messages are stored separately — fetch from community endpoint indirectly.
		// We can't call getCommunityConfig from client, but we load via a dedicated approach:
		// Just pre-fill with defaults if nothing is saved.
		motivationalText = DEFAULT_MOTIVATIONAL_MESSAGES.join('\n');

		// Try to load saved community config
		const commRes = await fetch('/api/discord/community/config').catch(() => null);
		if (commRes && commRes.ok) {
			const data = (await commRes.json().catch(() => null)) as { motivationalMessages?: string[] } | null;
			if (data?.motivationalMessages?.length) {
				motivationalText = data.motivationalMessages.join('\n');
			}
		}
	});

	const btnClass =
		'rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50 transition-colors';
	const primaryBtnClass =
		'rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors';
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Community</h1>
	<p class="mt-1 text-gray-400">
		Balrog's fun community commands — trigger them manually from here and post results to #general.
	</p>

	<!-- =========================================================
	     Section 1: Motivational Messages
	     ========================================================= -->
	<section class="mt-8">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Motivational Messages</h2>
		<p class="mt-1 text-xs text-gray-500">
			One message per line. The cron sends a random one to #general every 48h. Saving updates the stored list.
		</p>

		<textarea
			bind:value={motivationalText}
			rows={10}
			placeholder={DEFAULT_MOTIVATIONAL_MESSAGES.join('\n')}
			class="mt-3 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
		></textarea>
		<p class="mt-1 text-xs text-gray-600">{motivMessages.length} message{motivMessages.length !== 1 ? 's' : ''}</p>

		<div class="mt-3 flex flex-wrap items-center gap-3">
			<button
				type="button"
				onclick={saveMessages}
				disabled={saveMessagesRunning}
				class={primaryBtnClass}
			>
				{saveMessagesRunning ? 'Saving…' : 'Save Message List'}
			</button>

			<button
				type="button"
				onclick={postMotivational}
				disabled={motivRunning}
				class={btnClass}
			>
				{motivRunning ? 'Posting…' : 'Post Random Motivational Message'}
			</button>
		</div>

		{#if saveMessagesResult}
			<p class="mt-2 text-xs {saveMessagesResult.ok ? 'text-green-400' : 'text-red-400'}">{saveMessagesResult.msg}</p>
		{/if}
		{#if motivResult}
			<p class="mt-2 text-xs {motivResult.ok ? 'text-green-400' : 'text-red-400'}">{motivResult.msg}</p>
		{/if}
	</section>

	<!-- =========================================================
	     Section 2: Fun Commands
	     ========================================================= -->
	<section class="mt-10">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Fun Commands</h2>
		<p class="mt-1 text-xs text-gray-500">Each posts a result to #general.</p>

		<div class="mt-4 grid gap-4 sm:grid-cols-2">

			<!-- Roll Dice -->
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<h3 class="text-sm font-medium text-white">Roll Dice</h3>
				<p class="mt-0.5 text-xs text-gray-500">Posts "🎲 Rolled a {1-6}!" to #general.</p>
				<button
					type="button"
					onclick={rollDice}
					disabled={diceRunning}
					class="mt-3 {btnClass}"
				>
					{diceRunning ? 'Rolling…' : 'Roll Dice'}
				</button>
				{#if diceResult}
					<p class="mt-2 text-xs {diceResult.ok ? 'text-green-400' : 'text-red-400'}">{diceResult.msg}</p>
				{/if}
			</div>

			<!-- Yes or No -->
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<h3 class="text-sm font-medium text-white">Yes or No</h3>
				<p class="mt-0.5 text-xs text-gray-500">Posts "Yes." or "No." randomly to #general.</p>
				<button
					type="button"
					onclick={yesOrNo}
					disabled={ynRunning}
					class="mt-3 {btnClass}"
				>
					{ynRunning ? 'Deciding…' : 'Yes or No'}
				</button>
				{#if ynResult}
					<p class="mt-2 text-xs {ynResult.ok ? 'text-green-400' : 'text-red-400'}">{ynResult.msg}</p>
				{/if}
			</div>

			<!-- Who's Da Goat -->
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<h3 class="text-sm font-medium text-white">Who's Da Goat</h3>
				<p class="mt-0.5 text-xs text-gray-500">
					Picks a random recent author from #general and crowns them 🐐.
				</p>
				<button
					type="button"
					onclick={whosDaGoat}
					disabled={goatRunning}
					class="mt-3 {btnClass}"
				>
					{goatRunning ? 'Finding…' : "Who's Da Goat"}
				</button>
				{#if goatResult}
					<p class="mt-2 text-xs {goatResult.ok ? 'text-green-400' : 'text-red-400'}">{goatResult.msg}</p>
				{/if}
			</div>

			<!-- Quote -->
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<h3 class="text-sm font-medium text-white">Quote</h3>
				<p class="mt-0.5 text-xs text-gray-500">
					Picks a random recent message from #general and reposts it as a quote.
				</p>
				<button
					type="button"
					onclick={postQuote}
					disabled={quoteRunning}
					class="mt-3 {btnClass}"
				>
					{quoteRunning ? 'Quoting…' : 'Post Quote'}
				</button>
				{#if quoteResult}
					<p class="mt-2 text-xs {quoteResult.ok ? 'text-green-400' : 'text-red-400'}">{quoteResult.msg}</p>
				{/if}
			</div>

		</div>
	</section>
</main>
