/**
 * Test shim for $env/dynamic/private.
 * Vitest loads .env automatically, so process.env contains the real values.
 */
export const env = new Proxy({} as Record<string, string | undefined>, {
	get: (_, key: string) => process.env[key]
});
