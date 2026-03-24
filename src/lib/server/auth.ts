import { SignJWT, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';

const getSecret = () => new TextEncoder().encode(env.JWT_SECRET ?? 'dev-secret-change-me');

// Initial TO — additional TOs stored in KV/env
const SEED_TOS = (env.SEED_TO_EMAILS ?? 'danilochiarlone@hotmail.com').split(',').map(e => e.trim().toLowerCase());

// In-memory OTP store (serverless-safe for short-lived codes)
const otpStore = new Map<string, { code: string; expires: number }>();

export function isAuthorizedEmail(email: string): boolean {
	return getAllTOEmails().includes(email.toLowerCase());
}

export function getAllTOEmails(): string[] {
	const extra = (env.EXTRA_TO_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
	return [...new Set([...SEED_TOS, ...extra])];
}

export function generateOTP(): string {
	const code = Math.floor(100000 + Math.random() * 900000).toString();
	return code;
}

export function storeOTP(email: string, code: string): void {
	otpStore.set(email.toLowerCase(), { code, expires: Date.now() + 10 * 60 * 1000 }); // 10 min
}

export function verifyOTP(email: string, code: string): boolean {
	const entry = otpStore.get(email.toLowerCase());
	if (!entry) return false;
	if (Date.now() > entry.expires) {
		otpStore.delete(email.toLowerCase());
		return false;
	}
	if (entry.code !== code) return false;
	otpStore.delete(email.toLowerCase());
	return true;
}

export async function createSessionToken(email: string): Promise<string> {
	return new SignJWT({ email: email.toLowerCase() })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('7d')
		.sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<{ email: string } | null> {
	try {
		const { payload } = await jwtVerify(token, getSecret());
		return { email: payload.email as string };
	} catch {
		return null;
	}
}
