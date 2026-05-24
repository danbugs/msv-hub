import type { RequestHandler } from './$types';
import { gql } from '$lib/server/startgg';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const { slug } = await request.json() as { slug: string };
	if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

	const data = await gql<{ tournament: { id: number; name: string } }>(
		'query($slug:String!){tournament(slug:$slug){id name}}',
		{ slug }
	);

	if (!data?.tournament) return Response.json({ error: 'Not found' }, { status: 404 });
	return Response.json({ id: data.tournament.id, name: data.tournament.name });
};
