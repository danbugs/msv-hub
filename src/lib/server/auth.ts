import { randomInt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_DAYS = 7;
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

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

// In-memory OTP store — works for Vercel Node.js functions (instances are reused)
// but won't survive cold starts. Acceptable for low-traffic TO-only auth.
const otpStore = new Map<string, { code: string; expires: number }>();

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

export function storeOTP(email: string, code: string): void {
	otpStore.set(email, { code, expires: Date.now() + OTP_TTL_MS });
}

export function verifyOTP(email: string, code: string): boolean {
	const entry = otpStore.get(email);
	if (!entry) return false;
	if (Date.now() > entry.expires) {
		otpStore.delete(email);
		return false;
	}
	const expected = Buffer.from(entry.code);
	const actual = Buffer.from(code);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
	otpStore.delete(email);
	return true;
}

export async function createSessionToken(email: string): Promise<string> {
	return new SignJWT({ email })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(`${SESSION_TTL_DAYS}d`)
		.sign(getSecret());
}

export { SESSION_TTL_SECONDS };

export async function verifySessionToken(token: string): Promise<{ email: string } | null> {
	try {
		const { payload } = await jwtVerify(token, getSecret());
		if (typeof payload.email !== 'string') return null;
		return { email: payload.email };
	} catch {
		return null;
	}
}
