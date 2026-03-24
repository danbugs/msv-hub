<script lang="ts">
	import '../app.css';

	let { children, data } = $props();
</script>

<svelte:head>
	<title>MSV Hub</title>
</svelte:head>

<div class="min-h-screen bg-gray-950 text-gray-100">
	{#if data.user}
		<nav class="border-b border-gray-800 bg-gray-900/80 backdrop-blur">
			<div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
				<a href="/dashboard" class="text-lg font-bold text-violet-400">MSV Hub</a>
				<div class="flex items-center gap-4">
					<span class="text-sm text-gray-400">{data.user.email}</span>
					<form method="POST" action="/api/auth/logout"
						onsubmit={async (e) => {
							e.preventDefault();
							await fetch('/api/auth/logout', { method: 'POST' });
							window.location.href = '/';
						}}>
						<button type="submit" class="text-sm text-gray-400 hover:text-white transition-colors">
							Logout
						</button>
					</form>
				</div>
			</div>
		</nav>
	{/if}

	{@render children()}
</div>
