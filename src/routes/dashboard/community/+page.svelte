<script lang="ts">
	import { onMount } from 'svelte';
	import { DEFAULT_MOTIVATIONAL_MESSAGES, DEFAULT_GIF_URLS } from '$lib/defaults';

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
	// GIF URLs
	// ---------------------------------------------------------------------------

	let gifText = $state('');
	let gifUrls = $derived(
		gifText
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
	);

	let saveGifsRunning = $state(false);
	let saveGifsResult = $state<{ ok: boolean; msg: string } | null>(null);

	async function saveGifs() {
		saveGifsRunning = true;
		saveGifsResult = null;
		const res = await fetch('/api/discord/community', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'save_gifs', gifUrls })
		});
		const data = await res.json().catch(() => ({}));
		if (res.ok) {
			saveGifsResult = { ok: true, msg: `Saved ${(data as { saved?: number }).saved ?? gifUrls.length} GIF URLs.` };
		} else {
			saveGifsResult = { ok: false, msg: (data as { error?: string }).error ?? `HTTP ${res.status}` };
		}
		saveGifsRunning = false;
	}

	// ---------------------------------------------------------------------------
	// Slash command registration
	// ---------------------------------------------------------------------------

	let registerRunning = $state(false);
	let registerResult = $state<{ ok: boolean; msg: string } | null>(null);

	async function registerSlashCommands() {
		registerRunning = true;
		registerResult = null;
		const res = await fetch('/api/discord/register-commands', { method: 'POST' });
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (res.ok) {
			const names = (data['registered'] as string[] | undefined) ?? [];
			registerResult = { ok: true, msg: `Registered ${names.length} command(s): ${names.join(', ')}` };
		} else {
			registerResult = { ok: false, msg: (data['error'] as string | undefined) ?? `HTTP ${res.status}` };
		}
		registerRunning = false;
	}

	onMount(async () => {
		motivationalText = DEFAULT_MOTIVATIONAL_MESSAGES.join('\n');
		gifText = DEFAULT_GIF_URLS.join('\n');
		const commRes = await fetch('/api/discord/community/config').catch(() => null);
		if (commRes && commRes.ok) {
			const data = (await commRes.json().catch(() => null)) as {
				motivationalMessages?: string[];
				gifUrls?: string[];
			} | null;
			if (data?.motivationalMessages?.length) {
				motivationalText = data.motivationalMessages.join('\n');
			}
			if (data?.gifUrls?.length) {
				gifText = data.gifUrls.join('\n');
			}
		}
	});

	const primaryBtnClass =
		'rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50 transition-colors';
	const secondaryBtnClass =
		'rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-violet-600 hover:text-violet-300 disabled:opacity-50 transition-colors';
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">Community</h1>
	<p class="mt-1 text-gray-400">
		Balrog's community features — motivational messages and Discord slash commands.
	</p>

	<!-- =========================================================
	     Section 1: Motivational Messages
	     ========================================================= -->
	<section class="mt-8">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Motivational Messages</h2>
		<p class="mt-1 text-xs text-gray-500">
			One message per line. The cron posts a random one to #general every 48–72h.
		</p>

		<textarea
			bind:value={motivationalText}
			rows={10}
			placeholder={DEFAULT_MOTIVATIONAL_MESSAGES.join('\n')}
			class="mt-3 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
		></textarea>
		<p class="mt-1 text-xs text-gray-600">{motivMessages.length} message{motivMessages.length !== 1 ? 's' : ''}</p>

		<div class="mt-3 flex flex-wrap items-center gap-3">
			<button type="button" onclick={saveMessages} disabled={saveMessagesRunning} class={primaryBtnClass}>
				{saveMessagesRunning ? 'Saving…' : 'Save Message List'}
			</button>
			<button type="button" onclick={postMotivational} disabled={motivRunning} class={secondaryBtnClass}>
				{motivRunning ? 'Posting…' : 'Post Random Now'}
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
	     Section 2: GIF URLs
	     ========================================================= -->
	<section class="mt-10">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">GIF URLs</h2>
		<p class="mt-1 text-xs text-gray-500">
			One direct GIF URL per line (e.g. Giphy CDN or Tenor media URLs). Used by <code class="text-gray-400">/gif</code>.
		</p>

		<textarea
			bind:value={gifText}
			rows={8}
			placeholder={DEFAULT_GIF_URLS.join('\n')}
			class="mt-3 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
		></textarea>
		<p class="mt-1 text-xs text-gray-600">{gifUrls.length} URL{gifUrls.length !== 1 ? 's' : ''}</p>

		<div class="mt-3">
			<button type="button" onclick={saveGifs} disabled={saveGifsRunning} class={primaryBtnClass}>
				{saveGifsRunning ? 'Saving…' : 'Save GIF List'}
			</button>
		</div>

		{#if saveGifsResult}
			<p class="mt-2 text-xs {saveGifsResult.ok ? 'text-green-400' : 'text-red-400'}">{saveGifsResult.msg}</p>
		{/if}
	</section>

	<!-- =========================================================
	     Section 3: Slash Commands
	     ========================================================= -->
	<section class="mt-10">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Slash Commands</h2>
		<p class="mt-1 text-xs text-gray-500">
			Registers guild commands instantly. Run once after any command changes.
		</p>

		<div class="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
			<p class="text-xs text-gray-500 mb-3">
				Commands: <code class="text-gray-400">/roll_dice</code>
				<code class="text-gray-400">/yes_or_no</code>
				<code class="text-gray-400">/thanks</code>
				<code class="text-gray-400">/who_is_da_goat</code>
				<code class="text-gray-400">/quote</code>
				<code class="text-gray-400">/gif</code>
				<code class="text-gray-400">/nextweek</code>
				<code class="text-gray-400">/standings</code>
				<code class="text-gray-400">/bracket</code>
				<code class="text-gray-400">/balrog_help</code>
			</p>
			<button type="button" onclick={registerSlashCommands} disabled={registerRunning} class={primaryBtnClass}>
				{registerRunning ? 'Registering…' : 'Register Slash Commands'}
			</button>
			{#if registerResult}
				<p class="mt-2 text-xs {registerResult.ok ? 'text-green-400' : 'text-red-400'}">{registerResult.msg}</p>
			{/if}
		</div>
	</section>
</main>
