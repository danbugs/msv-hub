import { readFileSync } from 'node:fs';
try {
	const env = readFileSync('.env', 'utf8');
	for (const line of env.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) process.env[m[1]] = m[2];
	}
} catch {}

const { Redis } = await import('@upstash/redis');
const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const slug = await r.get('tournament:active');
const t = await r.get('tournament:' + slug);
const st = typeof t === 'string' ? JSON.parse(t) : t;
console.log('slug:', slug);
console.log('startggMainBracketEventId:', st?.startggMainBracketEventId);
console.log('startggRedemptionBracketEventId:', st?.startggRedemptionBracketEventId);
