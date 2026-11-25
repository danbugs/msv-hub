/**
 * Report every ready match in one round of the active tournament's main or redemption
 * bracket, through the hub's own API, so testing doesn't mean clicking through each match.
 * Goes through the same PATCH the dashboard uses: hub state, redemption generation,
 * station reassignment and the StartGG push all behave as they would on a real night.
 *
 * Usage:
 *   node scripts/report-bracket-round.mjs <main|redemption> <round> [options]
 *
 *   round     positive = winners round (1 = WR1), negative = losers round (-1 = LR1)
 *
 * Options:
 *   --base <url>      hub to talk to (default http://localhost:5173)
 *   --winner <who>    seed (better seed wins, default) | top | bottom | random
 *   --score <a-b>     winner-loser games (default 2-0)
 *   --email <addr>    TO email to act as (default: first of SEED_TO_EMAILS)
 *   --cookie <token>  use this session cookie instead of minting one from JWT_SECRET
 *                     (needed when --base's JWT_SECRET differs from the local .env)
 *   --dry-run         list what would be reported without reporting
 */
import { readFileSync } from 'fs';
import { SignJWT } from 'jose';

const env = Object.fromEntries(
	readFileSync(new URL('../.env', import.meta.url), 'utf8')
		.split('\n')
		.filter((l) => l.includes('=') && !l.startsWith('#'))
		.map((l) => {
			const i = l.indexOf('=');
			return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
		})
);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [bracketName, roundArg] = positional;
const round = Number(roundArg);

if (!['main', 'redemption'].includes(bracketName) || !Number.isInteger(round) || round === 0) {
	console.error('Usage: node scripts/report-bracket-round.mjs <main|redemption> <round> [--winner seed|top|bottom|random] [--score 2-0] [--base url] [--dry-run]');
	process.exit(1);
}

const base = flag('base', 'http://localhost:5173').replace(/\/$/, '');
const winnerMode = flag('winner', 'seed');
const [winScore, loseScore] = flag('score', '2-0').split('-').map(Number);
const dryRun = args.includes('--dry-run');
const email = flag('email', (env.SEED_TO_EMAILS ?? '').split(',')[0]?.trim().toLowerCase());

if (!['seed', 'top', 'bottom', 'random'].includes(winnerMode)) throw new Error(`Unknown --winner ${winnerMode}`);
if (!(winScore > loseScore) || loseScore < 0) throw new Error('--score must be winner-loser, e.g. 2-0 or 3-1');

const token =
	flag('cookie') ??
	(await new SignJWT({ email })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.sign(new TextEncoder().encode(env.JWT_SECRET ?? 'dev-secret-change-me')));
const headers = { 'Content-Type': 'application/json', Cookie: `session=${token}` };

async function api(method, path, body) {
	const res = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
	const json = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json?.error ?? res.statusText}`);
	return json;
}

const tournament = await api('GET', '/api/tournament');
if (!tournament) throw new Error('No active tournament');
const bracket = tournament.brackets?.[bracketName];
if (!bracket) throw new Error(`No ${bracketName} bracket yet`);

const seedOf = new Map(bracket.players.map((p) => [p.entrantId, p.seed]));
const tagOf = new Map(tournament.entrants.map((e) => [e.id, e.gamerTag]));
const label = (id) => `${tagOf.get(id) ?? id} (seed ${seedOf.get(id) ?? '?'})`;

const roundMatches = bracket.matches.filter((m) => m.round === round);
if (!roundMatches.length) {
	const rounds = [...new Set(bracket.matches.map((m) => m.round))].sort((a, b) => a - b);
	throw new Error(`${bracketName} has no round ${round}. Rounds: ${rounds.join(', ')}`);
}
const ready = roundMatches.filter((m) => m.topPlayerId && m.bottomPlayerId && !m.winnerId);
const skipped = roundMatches.length - ready.length;
console.log(`${bracketName} round ${round}: ${ready.length} to report${skipped ? `, ${skipped} skipped (done or waiting on players)` : ''}`);

function pickWinner(m) {
	if (winnerMode === 'top') return 'top';
	if (winnerMode === 'bottom') return 'bottom';
	if (winnerMode === 'random') return Math.random() < 0.5 ? 'top' : 'bottom';
	return (seedOf.get(m.topPlayerId) ?? Infinity) <= (seedOf.get(m.bottomPlayerId) ?? Infinity) ? 'top' : 'bottom';
}

let failed = 0;
// Sequential on purpose: the server merges concurrent reports, but StartGG rate-limits
// and a real night never reports a whole round in the same instant.
for (const m of ready) {
	const side = pickWinner(m);
	const winnerId = side === 'top' ? m.topPlayerId : m.bottomPlayerId;
	const loserId = side === 'top' ? m.bottomPlayerId : m.topPlayerId;
	// Per-game winners only for best-of-5, as the dashboard does: sending them sends the
	// StartGG report down the slow per-game GQL path instead of the fast REST one.
	const gameWinners = winScore === 3
		? [...Array(loseScore).fill(side === 'top' ? 'bottom' : 'top'), ...Array(winScore).fill(side)]
		: undefined;
	const line = `  ${m.id}: ${label(winnerId)} beats ${label(loserId)} ${winScore}-${loseScore}`;
	if (dryRun) {
		console.log(`${line} [dry run]`);
		continue;
	}
	try {
		const res = await api('PATCH', '/api/tournament/bracket', {
			bracketName,
			matchId: m.id,
			winnerId,
			topScore: side === 'top' ? winScore : loseScore,
			bottomScore: side === 'top' ? loseScore : winScore,
			gameWinners
		});
		const sg = res?.startgg;
		console.log(`${line}${sg && !sg.ok ? ` (StartGG: ${sg.queued ? 'queued for retry' : sg.error})` : ''}`);
		if (res?.redemptionBracket) console.log('  -> redemption bracket generated');
	} catch (e) {
		failed++;
		console.error(`${line} FAILED: ${e.message}`);
	}
}
if (failed) process.exit(1);
