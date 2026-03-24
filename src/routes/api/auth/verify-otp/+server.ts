import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAuthorizedEmail, verifyOTP, createSessionToken, SESSION_TTL_SECONDS } from '$lib/server/auth';

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
	cookies.set('session', token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		maxAge: SESSION_TTL_SECONDS
	});

	return json({ ok: true });
};
