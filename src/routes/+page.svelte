<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';

	let email = $state('');
	let code = $state('');
	let step = $state<'email' | 'code'>('email');
	let loading = $state(false);
	let error = $state('');

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
			// Refresh layout data so the nav picks up the new user immediately
			await invalidateAll();
			await goto('/dashboard');
		} else {
			error = 'Invalid or expired code.';
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<h1 class="text-3xl font-bold text-primary">MSV Hub</h1>
			<p class="mt-2 text-muted-foreground">Tournament Operations Center</p>
		</div>

		<div class="rounded-xl border border-border bg-card p-6">
			{#if step === 'email'}
				<form onsubmit={(e) => { e.preventDefault(); sendOTP(); }}>
					<label for="email" class="block text-sm font-medium text-foreground">TO Email</label>
					<input
						id="email"
						type="email"
						bind:value={email}
						placeholder="you@example.com"
						required
						class="mt-2 block w-full rounded-lg border border-input bg-secondary px-3 py-2 text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
					/>
					<Button
						type="submit"
						disabled={loading || !email}
						class="mt-4 w-full rounded-lg"
					>
						{loading ? 'Sending...' : 'Send Login Code'}
					</Button>
				</form>
			{:else}
				<form onsubmit={(e) => { e.preventDefault(); verifyCode(); }}>
					<p class="mb-4 text-sm text-muted-foreground">
						Code sent to <strong class="text-foreground">{email}</strong>
					</p>
					<label for="code" class="block text-sm font-medium text-foreground">6-Digit Code</label>
					<input
						id="code"
						type="text"
						inputmode="numeric"
						maxlength="6"
						bind:value={code}
						placeholder="123456"
						required
						class="mt-2 block w-full rounded-lg border border-input bg-secondary px-3 py-2 text-center text-2xl font-mono tracking-[0.3em] text-foreground placeholder-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
					/>
					<Button
						type="submit"
						disabled={loading || code.length !== 6}
						class="mt-4 w-full rounded-lg"
					>
						{loading ? 'Verifying...' : 'Login'}
					</Button>
					<Button
						type="button"
						variant="ghost"
						onclick={() => { step = 'email'; code = ''; error = ''; }}
						class="mt-2 w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						Use a different email
					</Button>
				</form>
			{/if}

			{#if error}
				<p class="mt-3 text-sm text-red-400">{error}</p>
			{/if}
		</div>
	</div>
</div>
