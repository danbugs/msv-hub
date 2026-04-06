import type { RequestHandler } from './$types';
import { applySeeding, type Entrant } from '$lib/server/seeder';

/** POST — apply seeding to StartGG without re-running the full seeder */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { targetSlug, entrants } = body as { targetSlug: string; entrants: Entrant[] };

	if (!targetSlug || !entrants?.length) {
		return Response.json({ error: 'targetSlug and entrants are required' }, { status: 400 });
	}

	try {
		const logs: string[] = [];
		await applySeeding(targetSlug, entrants, (msg) => logs.push(msg));
		return Response.json({ ok: true, logs });
	} catch (e) {
		return Response.json({ error: e instanceof Error ? e.message : 'Apply failed' }, { status: 500 });
	}
};
