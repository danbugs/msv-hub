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
		const html = document.documentElement;
		html.classList.add('theme-transitioning');
		theme = theme === 'dark' ? 'light' : 'dark';
		localStorage.setItem('msv-theme', theme);
		setTimeout(() => html.classList.remove('theme-transitioning'), 300);
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
				<div class="flex items-center gap-3">
					<span class="text-sm text-muted-foreground hidden sm:inline">{data.user.email}</span>
					<button
						onclick={toggleTheme}
						title="{theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}"
						class="theme-icon inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
					>
						{#if theme === 'dark'}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="4" />
								<path d="M12 2v2" /><path d="M12 20v2" />
								<path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
								<path d="M2 12h2" /><path d="M20 12h2" />
								<path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
							</svg>
						{:else}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
							</svg>
						{/if}
					</button>
					<button
						onclick={async () => {
							await fetch('/api/auth/logout', { method: 'POST' });
							window.location.href = '/';
						}}
						class="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					>
						Logout
					</button>
				</div>
			</div>
		</nav>
	{/if}

	{@render children()}
</div>
