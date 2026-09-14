import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAuthorizedEmail, verifyOTP, createSessionToken, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '$lib/server/auth';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const { email, code } = await request.json();

	if (!email || !code) {
		return json({ error: 'Email and code are required' }, { status: 400 });
	}

	const normalized = email.trim().toLowerCase();

	if (!isAuthorizedEmail(normalized)) {
		return json({ error: 'Invalid code' }, { status: 401 });
	}

	if (!verifyOTP(normalized, code)) {
		return json({ error: 'Invalid or expired code' }, { status: 401 });
	}

	const token = await createSessionToken(normalized);
	cookies.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);

	return json({ ok: true });
};
