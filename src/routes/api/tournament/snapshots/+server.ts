import type { RequestHandler } from './$types';
import {
	getActiveTournament, getLastDeletedSlug, listSnapshots, getSnapshot, snapshotTournament, saveTournament
} from '$lib/server/store';

/** GET — snapshots for the active tournament, or the last deleted one if none is active */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const active = await getActiveTournament();
	const slug = active?.slug ?? (await getLastDeletedSlug());
	if (!slug) return Response.json({ slug: null, deleted: false, snapshots: [] });
	return Response.json({ slug, deleted: !active, snapshots: await listSnapshots(slug) });
};

/** POST { slug, ts } — restore a snapshot as the active tournament */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const { slug, ts } = (await request.json()) as { slug?: string; ts?: number };
	if (!slug || typeof ts !== 'number') return Response.json({ error: 'slug and ts are required' }, { status: 400 });

	const snap = await getSnapshot(slug, ts);
	if (!snap) return Response.json({ error: 'Snapshot not found (they expire after 7 days)' }, { status: 404 });

	// Snapshot the current state first so the restore itself can be undone.
	const current = await getActiveTournament();
	if (current) await snapshotTournament(current, 'Before restore', locals.user.email);

	await saveTournament(snap);
	return Response.json({ ok: true });
};
