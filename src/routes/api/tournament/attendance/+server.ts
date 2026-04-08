import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament } from '$lib/server/store';
import { exportAttendees } from '$lib/server/startgg-admin';
import { gql } from '$lib/server/startgg';
import type { AttendeeStatus } from '$lib/types/tournament';

/** GET — fetch attendance data (from cache or StartGG) */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	return Response.json({
		attendance: tournament.attendance ?? [],
		setupCount: (tournament.attendance ?? []).filter((a) => a.pledgedSetup).length,
		presentCount: (tournament.attendance ?? []).filter((a) => a.present).length,
		setupDeployedCount: (tournament.attendance ?? []).filter((a) => a.setupDeployed).length,
		totalPlayers: tournament.entrants.length
	});
};

/** POST — refresh attendance from StartGG export */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	// Get tournament ID — try startggEventId first, then resolve from slug
	let tournamentId = 0;
	if (tournament.startggEventId) {
		// Get tournament ID from event ID
		const eData = await gql<{ event: { tournament: { id: number } } }>(
			'query($id:ID!){event(id:$id){tournament{id}}}', { id: tournament.startggEventId }
		);
		tournamentId = eData?.event?.tournament?.id ?? 0;
	}
	if (!tournamentId && tournament.startggEventSlug) {
		const slugMatch = tournament.startggEventSlug.match(/tournament\/([^/]+)/);
		if (slugMatch) {
			const tData = await gql<{ tournament: { id: number } }>(
				'query($slug:String!){tournament(slug:$slug){id}}', { slug: slugMatch[1] }
			);
			tournamentId = tData?.tournament?.id ?? 0;
		}
	}
	if (!tournamentId) {
		return Response.json({ error: `Could not resolve tournament ID (eventId=${tournament.startggEventId}, slug=${tournament.startggEventSlug})` }, { status: 400 });
	}

	console.log(`[attendance] Resolved tournament ID: ${tournamentId}`);
	const attendees = await exportAttendees(tournamentId);
	console.log(`[attendance] Export returned ${attendees.length} attendees`);
	if (!attendees.length) {
		return Response.json({ error: `Export returned 0 attendees for tournament ${tournamentId}. Check admin permissions.` }, { status: 400 });
	}

	// Merge with existing attendance state (preserve present/setupDeployed flags)
	const existing = new Map((tournament.attendance ?? []).map((a) => [a.gamerTag.toLowerCase(), a]));

	const newAttendance: AttendeeStatus[] = attendees.map((a) => {
		const prev = existing.get(a.gamerTag.toLowerCase());
		return {
			gamerTag: a.gamerTag,
			pledgedSetup: a.bringingSetup.toLowerCase() === 'yes',
			present: prev?.present ?? false,
			setupDeployed: prev?.setupDeployed ?? false,
			registeredAt: a.registeredAt,
			discordId: a.discordId || prev?.discordId || ''
		};
	});

	tournament.attendance = newAttendance;
	await saveTournament(tournament);

	return Response.json({
		ok: true,
		attendance: newAttendance,
		setupCount: newAttendance.filter((a) => a.pledgedSetup).length,
		totalPlayers: newAttendance.length
	});
};

/** PATCH — update attendance flags (present, setupDeployed) */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const { gamerTag, present, setupDeployed } = await request.json() as {
		gamerTag: string;
		present?: boolean;
		setupDeployed?: boolean;
	};

	if (!gamerTag) return Response.json({ error: 'gamerTag required' }, { status: 400 });

	const attendance = tournament.attendance ?? [];
	const idx = attendance.findIndex((a) => a.gamerTag.toLowerCase() === gamerTag.toLowerCase());
	if (idx < 0) return Response.json({ error: 'Attendee not found' }, { status: 404 });

	if (present !== undefined) attendance[idx].present = present;
	if (setupDeployed !== undefined) attendance[idx].setupDeployed = setupDeployed;

	tournament.attendance = attendance;
	await saveTournament(tournament);

	return Response.json({ ok: true, attendee: attendance[idx] });
};
