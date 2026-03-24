<script lang="ts">
	const sections = [
		{
			title: 'Pre-Tournament',
			items: [
				{ label: 'Discord Setup', href: '/dashboard/pre-tournament/discord', desc: 'Lock threads, create new forum posts, announce event' },
				{ label: 'Seed Event', href: '/dashboard/pre-tournament/seed', desc: 'Elo-based seeding with jitter control' }
			]
		},
		{
			title: 'Tournament',
			items: [
				{ label: 'Run Swiss', href: '/dashboard/tournament/swiss', desc: 'Swiss rounds, station assignment, score reporting' },
				{ label: 'Brackets', href: '/dashboard/tournament/brackets', desc: 'Main & Redemption brackets with auto-split' }
			]
		},
		{
			title: 'Post-Tournament',
			items: [
				{ label: 'Results & Export', href: '/dashboard/post-tournament', desc: 'Graphics, VOD, Braacket upload, StartGG sync' }
			]
		},
		{
			title: 'Settings',
			items: [
				{ label: 'TO Management', href: '/dashboard/settings', desc: 'Manage tournament organizer access' }
			]
		}
	];
</script>

<main class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold text-white">Dashboard</h1>
	<p class="mt-1 text-gray-400">Microspacing Vancouver — Tournament Operations</p>

	<div class="mt-8 grid gap-6 sm:grid-cols-2">
		{#each sections as section}
			<div>
				<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{section.title}</h2>
				<div class="space-y-2">
					{#each section.items as item}
						<a
							href={item.href}
							class="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-violet-600 hover:bg-gray-800/50"
						>
							<div class="font-medium text-white">{item.label}</div>
							<div class="mt-1 text-sm text-gray-400">{item.desc}</div>
						</a>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</main>
