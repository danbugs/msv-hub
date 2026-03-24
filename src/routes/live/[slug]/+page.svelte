<script lang="ts">
	let { data } = $props();

	let projectorMode = $state(false);
</script>

<svelte:head>
	<title>{data.slug} — MSV Live</title>
</svelte:head>

<div class={projectorMode ? 'min-h-screen bg-black p-8' : 'min-h-screen bg-gray-950 px-4 py-8'}>
	<div class={projectorMode ? 'mx-auto max-w-7xl' : 'mx-auto max-w-4xl'}>
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div>
				<h1 class={projectorMode ? 'text-5xl font-bold text-violet-400' : 'text-2xl font-bold text-violet-400'}>
					MSV Live
				</h1>
				<p class={projectorMode ? 'mt-2 text-2xl text-gray-400' : 'mt-1 text-gray-400'}>
					{data.slug}
				</p>
			</div>
			<button
				onclick={() => projectorMode = !projectorMode}
				class="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition-colors hover:border-violet-500 hover:text-white"
			>
				{projectorMode ? 'Exit Projector' : 'Projector Mode'}
			</button>
		</div>

		<!-- Station Assignments -->
		<div class="mt-8">
			<h2 class={projectorMode ? 'text-3xl font-semibold text-white' : 'text-lg font-semibold text-white'}>
				Station Assignments
			</h2>
			<div class={projectorMode
				? 'mt-4 grid grid-cols-4 gap-4'
				: 'mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4'}
			>
				<div class="rounded-xl border-2 border-red-500 bg-red-500/10 p-4 text-center">
					<div class={projectorMode ? 'text-lg font-bold text-red-400' : 'text-sm font-bold text-red-400'}>
						STREAM
					</div>
					<div class={projectorMode ? 'mt-2 text-xl text-gray-400' : 'mt-1 text-gray-500'}>
						No active round
					</div>
				</div>
				{#each Array(15) as _, i}
					<div class="rounded-xl border border-gray-700 bg-gray-900 p-4 text-center">
						<div class={projectorMode ? 'text-lg font-bold text-gray-300' : 'text-sm font-bold text-gray-300'}>
							STATION {i + 1}
						</div>
						<div class={projectorMode ? 'mt-2 text-xl text-gray-500' : 'mt-1 text-gray-500'}>
							—
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Standings -->
		<div class="mt-8">
			<h2 class={projectorMode ? 'text-3xl font-semibold text-white' : 'text-lg font-semibold text-white'}>
				Standings
			</h2>
			<div class="mt-4 rounded-xl border border-dashed border-gray-700 p-8 text-center text-gray-500">
				Tournament data will appear here once a Swiss round is active.
			</div>
		</div>
	</div>
</div>
