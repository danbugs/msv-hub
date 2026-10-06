import type { Handle } from '@sveltejs/kit';
import { verifySessionToken, isAuthorizedEmail, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '$lib/server/auth';

const CORS_GET_PREFIXES = ['/api/league/seasons', '/api/league/season/'];

function isPublicLeagueGet(method: string, pathname: string): boolean {
	if (method !== 'GET' && method !== 'OPTIONS') return false;
	return CORS_GET_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export const handle: Handle = async ({ event, resolve }) => {
	if (event.request.method === 'OPTIONS' && isPublicLeagueGet('OPTIONS', event.url.pathname)) {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type'
			}
		});
	}

	const token = event.cookies.get(SESSION_COOKIE);
	if (token) {
		const session = await verifySessionToken(token);
		// Tokens never expire, so the allowlist check is what revokes a removed TO.
		if (session && isAuthorizedEmail(session.email)) {
			event.locals.user = session;
			// Re-issue the cookie so its Max-Age slides forward on every visit;
			// the token itself has no expiry, so only browser cookie lifetime matters.
			event.cookies.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
		}
	}

	const response = await resolve(event);

	if (isPublicLeagueGet(event.request.method, event.url.pathname)) {
		response.headers.set('Access-Control-Allow-Origin', '*');
	}

	return response;
};
