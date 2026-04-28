<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';

	let { children, data } = $props();

	let theme = $state(browser ? (localStorage.getItem('msv-theme') ?? 'dark') : 'dark');

	$effect(() => {
		if (browser) {
			document.documentElement.classList.toggle('dark', theme === 'dark');
		}
	});

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		localStorage.setItem('msv-theme', theme);
	}
</script>

<svelte:head>
	<title>MSV Hub</title>
	<link rel="icon" type="image/png" href="/favicon.png" />
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	{#if data.user}
		<nav class="nav-border bg-card/90 backdrop-blur-md">
			<div class="flex items-center justify-between px-5 py-3">
				<a href="/dashboard" class="text-lg font-extrabold tracking-tight text-primary hover:text-primary/85 transition-colors">MSV Hub</a>
				<div class="flex items-center gap-4">
					<span class="text-sm text-muted-foreground">{data.user.email}</span>
					<button
						onclick={toggleTheme}
						title="{theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}"
						class="text-lg text-muted-foreground hover:text-primary transition-colors"
					>
						{theme === 'dark' ? '☀️' : '🌙'}
					</button>
					<button
						onclick={async () => {
							await fetch('/api/auth/logout', { method: 'POST' });
							window.location.href = '/';
						}}
						class="text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						Logout
					</button>
				</div>
			</div>
		</nav>
	{/if}

	{@render children()}
</div>
