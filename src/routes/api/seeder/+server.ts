import type { RequestHandler } from './$types';
import { runSeeder, type SeederInput } from '$lib/server/seeder';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
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
		return new Response(JSON.stringify({ error: 'targetNumber and seasonStart are required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			function sendEvent(event: string, data: unknown) {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			}

			try {
				const result = await runSeeder(input, (msg) => {
					sendEvent('log', { message: msg });
				});

				sendEvent('result', {
					entrants: result.entrants,
					pairings: result.pairings.map(([a, b]) => ({ top: a, bottom: b })),
					unresolvedCollisions: result.unresolvedCollisions.map(([a, b]) => ({ top: a, bottom: b })),
					targetSlug: result.targetSlug,
					logs: result.logs
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Unknown error';
				sendEvent('error', { error: msg });
			}

			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
