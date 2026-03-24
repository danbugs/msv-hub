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
	const sent = await sendOTPEmail(normalized, code);
	if (!sent) {
		return json({ error: 'Failed to send login code. Please try again.' }, { status: 500 });
	}

	return json({ ok: true });
};
