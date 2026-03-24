import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runSeeder, type SeederInput } from '$lib/server/seeder';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();

	const input: SeederInput = {
		mode: body.mode === 'macro' ? 'macro' : 'micro',
		targetNumber: Number(body.targetNumber),
		seasonStart: Number(body.seasonStart),
		microEnd: body.microEnd ? Number(body.microEnd) : undefined,
		macros: body.macros
			? String(body.macros).split(',').map((s: string) => Number(s.trim())).filter(Boolean)
			: undefined,
		avoidEvents: body.avoidEvents
			? String(body.avoidEvents).split(',').map((s: string) => s.trim()).filter(Boolean)
			: undefined,
		jitter: body.jitter !== undefined ? Number(body.jitter) : 20.0,
		seed: body.seed !== undefined && body.seed !== '' ? Number(body.seed) : undefined,
		apply: body.apply === true
	};

	if (!input.targetNumber || !input.seasonStart) {
		return json({ error: 'targetNumber and seasonStart are required' }, { status: 400 });
	}

	try {
		const result = await runSeeder(input);
		return json({
			entrants: result.entrants,
			pairings: result.pairings.map(([a, b]) => ({ top: a, bottom: b })),
			unresolvedCollisions: result.unresolvedCollisions.map(([a, b]) => ({ top: a, bottom: b })),
			targetSlug: result.targetSlug,
			logs: result.logs
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: msg }, { status: 500 });
	}
};
