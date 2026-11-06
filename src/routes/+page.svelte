<script lang="ts">
	let { data } = $props();

	const HUB_URL = 'https://start.gg/hub/microspacing';

	const fmt = (n: number) => n.toLocaleString('en-US');

	function eventDate(startAt: number): string {
		return new Date(startAt * 1000).toLocaleString('en-US', {
			timeZone: 'America/Vancouver',
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	const stats = $derived([
		{ value: fmt(data.totals.events), label: 'events' },
		{ value: fmt(data.totals.attendances), label: 'attendances' },
		{ value: fmt(data.totals.players), label: 'players' }
	]);

	const siteLinks = [
		{ href: '/league', title: 'League rankings', desc: 'Seasonal and all-time standings' },
		{ href: '/ranker', title: 'Ranker', desc: 'Make your own tier list of the scene' },
		{ href: '/live', title: 'Live', desc: 'Follow this week’s rounds and brackets' }
	];

	const socialLinks = [
		{ href: 'https://discord.gg/jRQ7zC8aVw', label: 'Discord' },
		{ href: 'https://www.youtube.com/@microspacing2199', label: 'YouTube' },
		{ href: 'https://twitch.tv/microspacing', label: 'Twitch' }
	];
</script>

<svelte:head>
	<title>Microspacing Vancouver — weekly Smash Ultimate tournament</title>
	<meta name="description" content="A free weekly Super Smash Bros. Ultimate tournament in Vancouver. Every Monday, 32 players, Swiss rounds then brackets." />
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	{#if data.live}
		<a href="/live/{data.live.slug}" class="block bg-primary text-primary-foreground hover:bg-primary/90">
			<div class="mx-auto max-w-3xl px-4 py-2 flex items-center gap-2 text-sm">
				<span class="relative flex h-2 w-2" aria-hidden="true">
					<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary-foreground opacity-75"></span>
					<span class="relative inline-flex h-2 w-2 rounded-full bg-primary-foreground"></span>
				</span>
				<span class="font-semibold">Live now</span>
				<span class="truncate opacity-90">{data.live.phase === 'swiss' ? 'Swiss rounds' : 'Brackets'} in progress</span>
				<span class="ml-auto shrink-0">Follow along →</span>
			</div>
		</a>
	{/if}

	<div class="border-b border-border bg-card/90 backdrop-blur-md">
		<div class="mx-auto max-w-3xl px-4 py-8 sm:py-10">
			<p class="text-xs font-bold uppercase tracking-wider text-muted-foreground">Super Smash Bros. Ultimate · Vancouver</p>
			<h1 class="mt-2 text-3xl sm:text-4xl font-extrabold tracking-tight text-primary">Microspacing Vancouver</h1>
			<p class="mt-3 max-w-xl text-base text-muted-foreground">
				A free weekly Smash Ultimate tournament, every Monday. Up to 32 players, several matches each,
				and it's been running since January 2023.
			</p>
			<div class="mt-5 flex flex-wrap gap-2">
				<a href={data.nextEvent?.url ?? HUB_URL} target="_blank" rel="noopener"
					class="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
					Sign up on start.gg
				</a>
				<a href="/league"
					class="inline-flex items-center rounded-lg bg-secondary px-4 py-2 text-sm font-semibold text-foreground hover:bg-accent transition-colors">
					See the rankings
				</a>
			</div>
		</div>
	</div>

	<div class="mx-auto max-w-3xl px-4 py-6 space-y-6">
		<div class="grid grid-cols-3 gap-2 sm:gap-3">
			{#each stats as s}
				<div class="rounded-xl border border-border bg-card px-2 py-4 text-center">
					<div class="text-xl sm:text-2xl font-extrabold font-mono text-foreground">{s.value}</div>
					<div class="mt-0.5 text-[11px] sm:text-xs uppercase tracking-wider text-muted-foreground">{s.label}</div>
				</div>
			{/each}
		</div>

		<section class="rounded-xl border border-border bg-card p-5">
			<h2 class="text-xs font-bold uppercase tracking-wider text-foreground">How to join</h2>
			<p class="mt-2 text-sm text-muted-foreground">
				Registration opens <strong class="text-foreground">Wednesdays at 8:30 AM Pacific</strong> on start.gg.
				Spots are capped at 32 and usually go fast, so set a reminder.
			</p>
			{#if data.nextEvent}
				<div class="mt-4 flex flex-col gap-3 rounded-lg bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
					<div class="min-w-0">
						<div class="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Next event</div>
						<div class="mt-0.5 font-semibold text-foreground">{data.nextEvent.name}</div>
						<div class="text-sm text-muted-foreground">{eventDate(data.nextEvent.startAt)}</div>
					</div>
					<a href={data.nextEvent.url} target="_blank" rel="noopener"
						class="shrink-0 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
						Register →
					</a>
				</div>
			{/if}
			<a href={HUB_URL} target="_blank" rel="noopener" class="mt-3 inline-block text-sm font-medium text-primary hover:underline">
				All events on the start.gg hub →
			</a>
		</section>

		<section class="grid gap-3 sm:grid-cols-2">
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-xs font-bold uppercase tracking-wider text-foreground">How a night works</h2>
				<p class="mt-2 text-sm text-muted-foreground">
					Everyone plays Swiss rounds first, against opponents with similar records. After that the field
					splits into a main bracket and a redemption bracket, so everyone gets several matches in.
				</p>
			</div>
			<div class="rounded-xl border border-border bg-card p-5">
				<h2 class="text-xs font-bold uppercase tracking-wider text-foreground">Rankings</h2>
				<p class="mt-2 text-sm text-muted-foreground">
					Every set counts toward seasonal player rankings, plus an all-time table going back to the first event.
					<a href="/league" class="font-medium text-primary hover:underline">See the league</a>.
				</p>
			</div>
		</section>

		<section class="rounded-xl border border-border bg-card p-5">
			<h2 class="text-xs font-bold uppercase tracking-wider text-foreground">Macrospacing</h2>
			<p class="mt-2 text-sm text-muted-foreground">
				Every so often we run Macrospacing, a bigger 64-player event that counts toward Vancouver's official league.
				Keep an eye on Discord and the start.gg hub for the next one.
			</p>
		</section>

		<section>
			<h2 class="mb-3 text-sm font-bold uppercase tracking-wider text-foreground">On this site</h2>
			<div class="grid gap-2 sm:grid-cols-3">
				{#each siteLinks as l}
					<a href={l.href} class="group rounded-xl border border-border bg-card p-4 hover:bg-accent/50 transition-colors">
						<div class="font-semibold text-foreground group-hover:text-primary transition-colors">{l.title} →</div>
						<div class="mt-0.5 text-xs text-muted-foreground">{l.desc}</div>
					</a>
				{/each}
			</div>
		</section>

		<section>
			<h2 class="mb-3 text-sm font-bold uppercase tracking-wider text-foreground">Follow along</h2>
			<div class="flex flex-wrap gap-2">
				{#each socialLinks as l}
					<a href={l.href} target="_blank" rel="noopener"
						class="rounded-lg bg-secondary px-3 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-primary transition-colors">
						{l.label}
					</a>
				{/each}
			</div>
			<p class="mt-2 text-xs text-muted-foreground">Some matches are streamed on Twitch and uploaded to YouTube. Announcements go out on Discord first.</p>
		</section>
	</div>

	<footer class="border-t border-border">
		<div class="mx-auto max-w-3xl px-4 py-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
			<span>Microspacing Vancouver</span>
			<a href="/login" class="hover:text-foreground transition-colors">Organizer login</a>
		</div>
	</footer>
</div>
