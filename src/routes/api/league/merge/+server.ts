import type { RequestHandler } from './$types';
import { addMerge, removeMerge, getMergeMap } from '$lib/server/league-store';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const merges = await getMergeMap();
	return Response.json(merges);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const { secondaryId, primaryId } = await request.json() as { secondaryId: string; primaryId: string };
	if (!secondaryId || !primaryId || secondaryId === primaryId) {
		return Response.json({ error: 'Invalid merge parameters' }, { status: 400 });
	}
	await addMerge(secondaryId, primaryId);
	return Response.json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const { secondaryId } = await request.json() as { secondaryId: string };
	if (!secondaryId) {
		return Response.json({ error: 'Missing secondaryId' }, { status: 400 });
	}
	await removeMerge(secondaryId);
	return Response.json({ ok: true });
};
