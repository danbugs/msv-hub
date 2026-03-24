<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();

	let email = $state('');
	let code = $state('');
	let step = $state<'email' | 'code'>('email');
	let loading = $state(false);
	let error = $state('');

	// Redirect if already logged in
	$effect(() => {
		if (data.user) goto('/dashboard');
	});

	async function sendOTP() {
		loading = true;
		error = '';
		const res = await fetch('/api/auth/send-otp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email })
		});
		loading = false;
		if (res.ok) {
			step = 'code';
		} else {
			const body = await res.json();
			error = body.error ?? 'Something went wrong. Try again.';
		}
	}

	async function verifyCode() {
		loading = true;
		error = '';
		const res = await fetch('/api/auth/verify-otp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, code })
		});
		loading = false;
		if (res.ok) {
			goto('/dashboard');
		} else {
			error = 'Invalid or expired code.';
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<h1 class="text-3xl font-bold text-violet-400">MSV Hub</h1>
			<p class="mt-2 text-gray-400">Tournament Operations Center</p>
		</div>

		<div class="rounded-xl border border-gray-800 bg-gray-900 p-6">
			{#if step === 'email'}
				<form onsubmit={(e) => { e.preventDefault(); sendOTP(); }}>
					<label for="email" class="block text-sm font-medium text-gray-300">TO Email</label>
					<input
						id="email"
						type="email"
						bind:value={email}
						placeholder="you@example.com"
						required
						class="mt-2 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
					/>
					<button
						type="submit"
						disabled={loading || !email}
						class="mt-4 w-full rounded-lg bg-violet-600 px-4 py-2 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
					>
						{loading ? 'Sending...' : 'Send Login Code'}
					</button>
				</form>
			{:else}
				<form onsubmit={(e) => { e.preventDefault(); verifyCode(); }}>
					<p class="mb-4 text-sm text-gray-400">
						Code sent to <strong class="text-white">{email}</strong>
					</p>
					<label for="code" class="block text-sm font-medium text-gray-300">6-Digit Code</label>
					<input
						id="code"
						type="text"
						inputmode="numeric"
						maxlength="6"
						bind:value={code}
						placeholder="123456"
						required
						class="mt-2 block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-center text-2xl font-mono tracking-[0.3em] text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
					/>
					<button
						type="submit"
						disabled={loading || code.length !== 6}
						class="mt-4 w-full rounded-lg bg-violet-600 px-4 py-2 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
					>
						{loading ? 'Verifying...' : 'Login'}
					</button>
					<button
						type="button"
						onclick={() => { step = 'email'; code = ''; error = ''; }}
						class="mt-2 w-full text-sm text-gray-400 hover:text-white transition-colors"
					>
						Use a different email
					</button>
				</form>
			{/if}

			{#if error}
				<p class="mt-3 text-sm text-red-400">{error}</p>
			{/if}
		</div>
	</div>
</div>
