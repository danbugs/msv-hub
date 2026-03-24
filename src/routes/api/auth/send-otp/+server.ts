import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAuthorizedEmail, generateOTP, storeOTP } from '$lib/server/auth';
import { sendOTPEmail } from '$lib/server/email';

export const POST: RequestHandler = async ({ request }) => {
	const { email } = await request.json();

	if (!email || typeof email !== 'string') {
		return json({ error: 'Email is required' }, { status: 400 });
	}

	const normalized = email.trim().toLowerCase();

	if (!isAuthorizedEmail(normalized)) {
		return json({ error: 'This email is not registered as a tournament organizer.' }, { status: 403 });
	}

	const code = generateOTP();
	storeOTP(normalized, code);
	const result = await sendOTPEmail(normalized, code);
	if (!result.ok) {
		return json({ error: `Failed to send login code: ${result.detail ?? 'unknown error'}` }, { status: 500 });
	}

	return json({ ok: true });
};
