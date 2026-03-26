/**
 * Vitest global setup: load .env into process.env before tests run.
 * Vitest doesn't automatically populate process.env from .env files in node
 * environments when dotenv isn't installed as a direct dependency.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
	const content = readFileSync(resolve(process.cwd(), '.env'), 'utf-8');
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 1) continue;
		const key = trimmed.slice(0, eq).trim();
		const raw = trimmed.slice(eq + 1).trim();
		// Strip surrounding quotes if present
		const value = raw.replace(/^(['"])(.*)\1$/, '$2');
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
} catch {
	// .env not found — tests requiring credentials will fail with a clear message
}
