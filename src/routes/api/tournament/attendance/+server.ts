import type { RequestHandler } from './$types';
import { getActiveTournament, saveTournament, getDiscordConfig, getAttendance, setAttendanceFlags } from '$lib/server/store';
import type { AttendanceFlags } from '$lib/server/store';
import { exportAttendees } from '$lib/server/startgg-admin';
import { gql } from '$lib/server/startgg';
import type { AttendeeStatus } from '$lib/types/tournament';

/** GET — fetch attendance data (from cache or StartGG) */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	const attendance = await getAttendance(tournament);
	return Response.json({
		attendance,
		setupCount: attendance.filter((a) => a.pledgedSetup).length,
		presentCount: attendance.filter((a) => a.present).length,
		setupDeployedCount: attendance.filter((a) => a.setupDeployed).length,
		lateCount: attendance.filter((a) => a.late).length,
		totalPlayers: tournament.entrants.length
	});
};

/** POST — refresh attendance from StartGG export */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const tournament = await getActiveTournament();
	if (!tournament) return Response.json({ error: 'No active tournament' }, { status: 404 });

	// Get tournament ID — try startggEventId, tournament slug, then Discord config slug as fallback
	let tournamentId = 0;
	if (tournament.startggEventId) {
		const eData = await gql<{ event: { tournament: { id: number } } }>(
			'query($id:ID!){event(id:$id){tournament{id}}}', { id: tournament.startggEventId }
		);
		tournamentId = eData?.event?.tournament?.id ?? 0;
	}

	async function resolveFromEventSlug(eventSlug: string): Promise<number> {
		const slugMatch = eventSlug.match(/tournament\/([^/]+)/);
		if (!slugMatch) return 0;
		const tData = await gql<{ tournament: { id: number } }>(
			'query($slug:String!){tournament(slug:$slug){id}}', { slug: slugMatch[1] }
		);
		return tData?.tournament?.id ?? 0;
	}

	if (!tournamentId && tournament.startggEventSlug) {
		tournamentId = await resolveFromEventSlug(tournament.startggEventSlug);
	}
	// Fallback: use Discord config's eventSlug (set when configuring the announcement)
	if (!tournamentId) {
		const config = await getDiscordConfig();
		if (config.eventSlug) {
			tournamentId = await resolveFromEventSlug(config.eventSlug);
		}
	}
	if (!tournamentId) {
		const config = await getDiscordConfig();
		return Response.json({
			error: `Could not resolve tournament ID. Set the event slug in Discord Setup or link the tournament to a StartGG event. (tournament.eventId=${tournament.startggEventId}, tournament.slug=${tournament.startggEventSlug}, discord.slug=${config.eventSlug})`
		}, { status: 400 });
	}

	console.log(`[attendance] Resolved tournament ID: ${tournamentId}`);
	const attendees = await exportAttendees(tournamentId);
	console.log(`[attendance] Export returned ${attendees.length} attendees`);
	if (!attendees.length) {
		return Response.json({ error: `Export returned 0 attendees for tournament ${tournamentId}. Check admin permissions.` }, { status: 400 });
	}

	// Merge with existing attendance state so TO-set flags survive a refresh
	const existing = new Map((await getAttendance(tournament)).map((a) => [a.gamerTag.toLowerCase(), a]));

	const newAttendance: AttendeeStatus[] = attendees.map((a) => {
		const prev = existing.get(a.gamerTag.toLowerCase());
		return {
			gamerTag: a.gamerTag,
			pledgedSetup: a.bringingSetup.toLowerCase() === 'yes',
			present: prev?.present ?? false,
			setupDeployed: prev?.setupDeployed ?? false,
			late: prev?.late ?? false,
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

	const { gamerTag, present, setupDeployed, late } = await request.json() as {
		gamerTag: string;
		present?: boolean;
		setupDeployed?: boolean;
		late?: boolean;
	};

	if (!gamerTag) return Response.json({ error: 'gamerTag required' }, { status: 400 });

	const attendee = (tournament.attendance ?? []).find((a) => a.gamerTag.toLowerCase() === gamerTag.toLowerCase());
	if (!attendee) return Response.json({ error: 'Attendee not found' }, { status: 404 });

	// Written to the per-player flag hash, not the tournament blob — see getAttendance.
	const patch: AttendanceFlags = {};
	if (present !== undefined) patch.present = present;
	if (setupDeployed !== undefined) patch.setupDeployed = setupDeployed;
	if (late !== undefined) patch.late = late;
	const base = { present: attendee.present, late: attendee.late, setupDeployed: attendee.setupDeployed };
	const flags = await setAttendanceFlags(tournament.slug, attendee.gamerTag, base, patch);

	return Response.json({ ok: true, attendee: { ...attendee, ...flags } });
};
