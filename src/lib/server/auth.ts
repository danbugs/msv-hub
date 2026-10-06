import { randomInt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { setOTP, getOTP, incrOTPAttempts, deleteOTP } from './store';

export const OTP_TTL_MS = 10 * 60 * 1000;
// Session tokens carry no `exp` claim, so the cookie lifetime is the only limit.
// Browsers cap Max-Age at 400 days (RFC 6265bis), so this is the longest a
// cookie can live; hooks.server.ts re-sets it on every request so the window slides.
export const SESSION_COOKIE = 'session';
export const SESSION_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	secure: true,
	maxAge: 400 * 24 * 60 * 60
} as const;

let cachedSecret: Uint8Array | null = null;
function getSecret(): Uint8Array {
	if (cachedSecret) return cachedSecret;
	const secret = env.JWT_SECRET;
	if (!secret && !dev) throw new Error('JWT_SECRET must be set in production');
	cachedSecret = new TextEncoder().encode(secret ?? 'dev-secret-change-me');
	return cachedSecret;
}

function getSeedTOs(): string[] {
	const raw = env.SEED_TO_EMAILS ?? '';
	if (!raw && !dev) throw new Error('SEED_TO_EMAILS must be set in production');
	return raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

// Wrong guesses allowed per code before it's burned; 6 digits is only 1e6
// combinations, so without a cap a code could be brute-forced inside its TTL.
const MAX_OTP_ATTEMPTS = 5;

export function isAuthorizedEmail(email: string): boolean {
	return getAllTOEmails().includes(email);
}

export function getAllTOEmails(): string[] {
	const seed = getSeedTOs();
	const extra = (env.EXTRA_TO_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
	return [...new Set([...seed, ...extra])];
}

export function generateOTP(): string {
	return randomInt(100000, 999999).toString();
}

export async function storeOTP(email: string, code: string): Promise<void> {
	await setOTP(email, code, OTP_TTL_MS / 1000);
}

export async function verifyOTP(email: string, code: string): Promise<boolean> {
	const stored = await getOTP(email);
	if (!stored) return false;
	const expected = Buffer.from(stored);
	const actual = Buffer.from(code);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		const attempts = await incrOTPAttempts(email, OTP_TTL_MS / 1000);
		if (attempts >= MAX_OTP_ATTEMPTS) await deleteOTP(email);
		return false;
	}
	await deleteOTP(email);
	return true;
}

export async function createSessionToken(email: string): Promise<string> {
	return new SignJWT({ email })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<{ email: string } | null> {
	try {
		const { payload } = await jwtVerify(token, getSecret());
		if (typeof payload.email !== 'string') return null;
		return { email: payload.email };
	} catch {
		return null;
	}
}
