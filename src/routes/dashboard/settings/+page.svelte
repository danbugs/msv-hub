<script lang="ts">
	let { data } = $props();
</script>

<main class="mx-auto max-w-3xl px-4 py-8">
	<a href="/dashboard" class="text-sm text-violet-400 hover:text-violet-300">&larr; Dashboard</a>
	<h1 class="mt-4 text-2xl font-bold text-white">TO Management</h1>
	<p class="mt-1 text-gray-400">Manage who has tournament organizer access.</p>

	<div class="mt-6 rounded-xl border border-gray-800 bg-gray-900 p-6">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Current TOs</h2>
		<ul class="mt-3 space-y-2">
			{#each data.toEmails as email}
				<li class="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-2">
					<span class="text-white">{email}</span>
				</li>
			{/each}
		</ul>

		<div class="mt-6 rounded-lg border border-dashed border-gray-700 p-4 text-center text-sm text-gray-500">
			Adding/removing TOs from the UI will be enabled once a database is connected.
			<br />
			For now, set the <code class="text-violet-400">EXTRA_TO_EMAILS</code> env var in Vercel (comma-separated).
		</div>
	</div>
</main>
