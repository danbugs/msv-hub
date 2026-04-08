import type { RequestHandler } from './$types';
import { getDiscordConfig, saveDiscordConfig } from '$lib/server/store';
import { updateCronSchedule } from '$lib/server/github';

/** GET — return current Discord config */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
	const config = await getDiscordConfig();
	return Response.json(config);
};

/** POST — update Discord config fields */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const {
		eventSlug,
		attendeeCap,
		registrationDay,
		registrationHour,
		registrationMinute,
		announcementTemplate,
		paused,
		waitlistCreated
	} = body as {
		eventSlug?: string;
		attendeeCap?: 32 | 64;
		registrationDay?: string;
		registrationHour?: number;
		registrationMinute?: number;
		announcementTemplate?: string;
		paused?: boolean;
		waitlistCreated?: boolean;
	};

	// Validate attendeeCap if provided
	if (attendeeCap !== undefined && attendeeCap !== 32 && attendeeCap !== 64) {
		return Response.json({ error: 'attendeeCap must be 32 or 64' }, { status: 400 });
	}

	// Validate registration time fields if provided
	if (registrationDay !== undefined) {
		const valid = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
		if (!valid.includes(registrationDay)) {
			return Response.json({ error: 'registrationDay must be one of: ' + valid.join(', ') }, { status: 400 });
		}
	}
	if (registrationHour !== undefined && (registrationHour < 0 || registrationHour > 23)) {
		return Response.json({ error: 'registrationHour must be 0–23' }, { status: 400 });
	}
	if (registrationMinute !== undefined && (registrationMinute < 0 || registrationMinute > 59)) {
		return Response.json({ error: 'registrationMinute must be 0–59' }, { status: 400 });
	}

	// Load current config so we can detect changes.
	const current = await getDiscordConfig();

	// If a new eventSlug is being set and it differs from the stored one, reset
	// waitlistCreated so the attendee monitor fires for the new event.
	const slugChanged = eventSlug !== undefined && eventSlug !== current.eventSlug;

	const updated = await saveDiscordConfig({
		...(eventSlug !== undefined && { eventSlug }),
		...(attendeeCap !== undefined && { attendeeCap }),
		...(registrationDay !== undefined && { registrationDay }),
		...(registrationHour !== undefined && { registrationHour }),
		...(registrationMinute !== undefined && { registrationMinute }),
		...(announcementTemplate !== undefined && { announcementTemplate }),
		...(paused !== undefined && { paused }),
		...(waitlistCreated !== undefined && { waitlistCreated }),
		...(slugChanged && { waitlistCreated: false, fastestRegPosted: false })
	});

	// Auto-update the cron schedule in .github/workflows/discord-cron.yml
	// whenever registration time changes. Best-effort — errors are swallowed.
	const timeChanged =
		registrationDay !== undefined ||
		registrationHour !== undefined ||
		registrationMinute !== undefined;

	if (timeChanged) {
		await updateCronSchedule(
			updated.registrationDay,
			updated.registrationHour,
			updated.registrationMinute
		);
	}

	return Response.json(updated);
};
