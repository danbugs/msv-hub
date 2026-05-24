/**
 * POST /api/event/create-cron
 *
 * Called by QStash every Tuesday at 9 AM PST.
 * Automates the full event creation flow:
 *   1. Clone tournament from template
 *   2. Update short slug
 *   3. Publish homepage, bracket/seeding, registration
 *   4. Look up TO player IDs and register them
 *   5. Increment event counter
 *   6. Update Discord config with new event slug
 *   7. Trigger pre-tournament Discord setup
 *
 * Protected by Authorization: Bearer <CRON_SECRET>.
 *
 * Returns: { ok: boolean, steps: StepResult[], error?: string }
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getEventConfig, saveEventConfig, getDiscordConfig, saveDiscordConfig } from '$lib/server/store';
import {
	cloneTournament,
	publishHomepage,
	publishBracketSeeding,
	publishEvents,
	setRegistrationPublished,
	updateTournamentBasicDetails,
	getTournamentRegistrationInfo,
	registerTOForTournament
} from '$lib/server/startgg-admin';
import { sendMessage } from '$lib/server/discord';
import { gql } from '$lib/server/startgg';
import type { TOConfig } from '$lib/server/store';

interface StepResult {
	step: string;
	ok: boolean;
	detail: string;
}

interface CreateEventOverrides {
	name?: string;
	startDate?: string;
	startHour?: number;
	shortSlug?: string;
	srcTournamentId?: number;
	skipCounterIncrement?: boolean;
	skipDiscordSetup?: boolean;
	attendeeCap?: 32 | 64;
}

function getTimestampsForDate(dateStr: string, hour: number): { startAt: number; endAt: number } {
	const timeStr = `${dateStr}T${String(hour).padStart(2, '0')}:00:00`;

	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Los_Angeles',
		timeZoneName: 'shortOffset'
	});
	const parts = formatter.formatToParts(new Date(`${timeStr}Z`));
	const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-8';
	const offsetMatch = tzPart.match(/GMT([+-]\d+)/);
	const offsetHours = offsetMatch ? parseInt(offsetMatch[1]) : -8;

	const startAt = Math.floor(new Date(`${timeStr}Z`).getTime() / 1000) - offsetHours * 3600;
	const endAt = startAt + 5 * 3600;

	return { startAt, endAt };
}

function getNextMondayTimestamps(): { startAt: number; endAt: number } {
	const now = new Date();

	// Find next Monday in Pacific time
	const pacific = new Date(
		now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
	);

	const dayOfWeek = pacific.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
	// If today is Tuesday (2), next Monday is 6 days away
	let daysUntilMonday = (1 - dayOfWeek + 7) % 7;
	if (daysUntilMonday === 0) daysUntilMonday = 7;

	// Build the target date in Pacific time: next Monday at 6 PM
	const targetDate = new Date(pacific);
	targetDate.setDate(targetDate.getDate() + daysUntilMonday);
	targetDate.setHours(18, 0, 0, 0);

	// Convert to UTC by constructing a date string with the Pacific timezone
	const year = targetDate.getFullYear();
	const month = String(targetDate.getMonth() + 1).padStart(2, '0');
	const day = String(targetDate.getDate()).padStart(2, '0');
	const dateStr = `${year}-${month}-${day}T18:00:00`;

	// Use Intl to get the actual offset for that date in Pacific time
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Los_Angeles',
		timeZoneName: 'shortOffset'
	});
	const parts = formatter.formatToParts(new Date(`${dateStr}Z`));
	const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-8';
	const offsetMatch = tzPart.match(/GMT([+-]\d+)/);
	const offsetHours = offsetMatch ? parseInt(offsetMatch[1]) : -8;

	// startAt = 6 PM Pacific in UTC
	const startAt = Math.floor(new Date(`${dateStr}Z`).getTime() / 1000) - offsetHours * 3600;
	// endAt = 11 PM Pacific in UTC (5 hours later)
	const endAt = startAt + 5 * 3600;

	return { startAt, endAt };
}

async function handleCreateEvent(request: Request, user?: { email: string }) {
	const cronSecret = env.CRON_SECRET;
	const authHeader = request.headers.get('Authorization') ?? '';
	const cronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;
	if (!user && !cronAuth) {
		return Response.json({ ok: false, steps: [], error: 'Unauthorized' }, { status: 401 });
	}

	let overrides: CreateEventOverrides = {};
	try {
		const contentType = request.headers.get('Content-Type') ?? '';
		if (contentType.includes('application/json')) {
			const body = await request.json();
			if (body && typeof body === 'object') overrides = body;
		}
	} catch {
		// No body or invalid JSON — use defaults
	}

	const log: StepResult[] = [];

	async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
		try {
			const detail = await fn();
			log.push({ step: name, ok: true, detail });
			return true;
		} catch (e) {
			log.push({ step: name, ok: false, detail: e instanceof Error ? e.message : String(e) });
			return false;
		}
	}

	const config = await getEventConfig();

	if (config.paused && !overrides.name) {
		return Response.json({ ok: true, steps: [], reason: 'Event creation is paused' });
	}

	const eventNumber = config.nextEventNumber;
	const eventName = overrides.name ?? `Microspacing Vancouver #${eventNumber}`;
	const { startAt, endAt } = overrides.startDate
		? getTimestampsForDate(overrides.startDate, overrides.startHour ?? 18)
		: getNextMondayTimestamps();

	const srcId = overrides.srcTournamentId ?? config.lastCreatedTournamentId ?? config.srcTournamentId;

	// Step 1: Clone tournament
	let tournamentId = 0;
	let tournamentSlug = '';

	const cloneOk = await step('Clone tournament', async () => {
		const result = await cloneTournament({
			name: eventName,
			startAt,
			endAt,
			srcTournamentId: srcId,
			hubIds: config.hubIds,
			discordLink: config.discordLink
		});
		if (!result.ok) throw new Error(result.error ?? 'Clone failed');
		tournamentId = result.tournamentId!;
		tournamentSlug = result.tournamentSlug ?? '';
		return `Created tournament ${tournamentId} (slug: ${tournamentSlug})`;
	});

	if (!cloneOk) {
		return Response.json({ ok: false, steps: log, error: 'Clone failed — aborting' });
	}

	// Give start.gg time to propagate the cloned tournament's events
	await new Promise<void>((r) => setTimeout(r, 5000));

	// Step 2: Update short slug and basic details
	const slugToUse = overrides.shortSlug ?? config.shortSlug;
	await step('Update short slug', async () => {
		const result = await updateTournamentBasicDetails(tournamentId, {
			name: eventName,
			shortSlug: slugToUse,
			startAt,
			endAt,
			discordLink: config.discordLink
		});
		if (!result.ok) throw new Error(result.error ?? 'Failed');
		return `Set short slug to "${slugToUse}"`;
	});

	// Step 3: Publish homepage
	await step('Publish homepage', async () => {
		const result = await publishHomepage(tournamentId);
		if (!result.ok) throw new Error(result.error ?? 'Failed');
		return 'Homepage set to public';
	});

	// Step 4: Publish events (makes events visible on tournament page)
	await step('Publish events', async () => {
		let result = await publishEvents(tournamentId);
		if (!result.ok && result.error === 'No events found') {
			await new Promise<void>((r) => setTimeout(r, 5000));
			result = await publishEvents(tournamentId);
		}
		if (!result.ok) throw new Error(result.error ?? 'Failed');
		return 'Events set to public';
	});

	// Step 5: Publish bracket/seeding
	await step('Publish bracket/seeding', async () => {
		const result = await publishBracketSeeding(tournamentId);
		if (!result.ok) throw new Error(result.error ?? 'Failed');
		return 'Bracket and seeding set to public';
	});

	// Step 6: Open registration
	await step('Open registration', async () => {
		const result = await setRegistrationPublished(tournamentId, true);
		if (!result.ok) throw new Error(result.error ?? 'Failed');
		return 'Registration opened';
	});

	// Step 6: Look up TOs and register them
	const tosToRegister = config.tos.filter((t: TOConfig) => t.autoRegister);

	if (tosToRegister.length > 0 && tournamentSlug) {
		let regInfo: Awaited<ReturnType<typeof getTournamentRegistrationInfo>> = null;

		await step('Fetch registration info', async () => {
			regInfo = await getTournamentRegistrationInfo(tournamentSlug);
			if (!regInfo) throw new Error('Could not discover registration configuration');
			return `eventId=${regInfo.eventId}, phaseId=${regInfo.phaseId}, passTypeId=${regInfo.passTypeId}, options=${regInfo.registrationOptionValueIds.length}`;
		});

		if (regInfo) {
			const updatedTOs = [...config.tos];
			for (const to of tosToRegister) {
				await step(`Register TO: ${to.name}`, async () => {
					const result = await registerTOForTournament(tournamentId, to, regInfo!);
					if (!result.ok) throw new Error(result.error ?? 'Failed');
					// Cache the player ID for future use
					if (result.playerId) {
						const idx = updatedTOs.findIndex((t) => t.discriminator === to.discriminator);
						if (idx >= 0) updatedTOs[idx] = { ...updatedTOs[idx], playerId: result.playerId };
					}
					return `Registered ${to.name} (player ${result.playerId})`;
				});
			}
			// Save updated player IDs
			await saveEventConfig({ tos: updatedTOs });
		}
	}

	// Step 7: Increment counter and save last created tournament
	if (overrides.skipCounterIncrement) {
		log.push({ step: 'Update event config', ok: true, detail: 'Skipped — one-off event' });
	} else {
		await step('Update event config', async () => {
			await saveEventConfig({
				nextEventNumber: eventNumber + 1,
				lastCreatedTournamentId: tournamentId,
				lastCreatedTournamentSlug: tournamentSlug
			});
			return `Next event will be #${eventNumber + 1}`;
		});
	}

	// Step 8: Discover the registration event slug and update Discord config.
	// Micro (cap 32) → Swiss event; Macro (cap 64) → main bracket event.
	let eventSlug = '';

	if (tournamentId) {
		await step('Discover registration event slug', async () => {
			const discordConfig = await getDiscordConfig();
			const isMacro = (overrides.attendeeCap ?? discordConfig.attendeeCap) === 64;

			type TData = { tournament: { events: { id: number; name: string; slug: string }[] } };
			const data = await gql<TData>(
				'query($id:ID!){tournament(id:$id){events{id name slug}}}',
				{ id: tournamentId }
			);
			const events = data?.tournament?.events ?? [];

			const target = isMacro
				? events.find((e) => /main/i.test(e.name))
				: events.find((e) => /swiss/i.test(e.name));

			if (target) {
				eventSlug = target.slug;
				return `Found ${isMacro ? 'main bracket' : 'Swiss'} event: ${eventSlug}`;
			}
			if (events.length > 0) {
				eventSlug = events[0].slug;
				return `No matching event found, using first event: ${eventSlug}`;
			}
			throw new Error('No events found on cloned tournament');
		});
	}

	if (eventSlug) {
		await step('Update Discord config', async () => {
			const discordUpdate: Record<string, unknown> = {
				eventSlug,
				waitlistCreated: false,
				nearCapAlerted: false,
				fastestRegPosted: false
			};
			if (overrides.attendeeCap) discordUpdate.attendeeCap = overrides.attendeeCap;
			await saveDiscordConfig(discordUpdate);
			const capNote = overrides.attendeeCap ? `, attendeeCap=${overrides.attendeeCap}` : '';
			return `Discord event slug set to "${eventSlug}"${capNote}`;
		});
	}

	// Step 9: Trigger pre-tournament Discord setup (uses CRON_SECRET auth)
	if (overrides.skipDiscordSetup) {
		log.push({ step: 'Trigger Discord pre-tournament setup', ok: true, detail: 'Skipped — one-off event' });
	} else {
		await step('Trigger Discord pre-tournament setup', async () => {
			let appUrl = env.APP_URL ?? 'http://localhost:5173';
			if (!/^https?:\/\//i.test(appUrl)) appUrl = `https://${appUrl}`;
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (cronSecret) headers['Authorization'] = `Bearer ${cronSecret}`;
			const res = await fetch(`${appUrl}/api/discord/pre-tournament-setup`, {
				method: 'POST',
				headers
			});
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
			}
			const data = await res.json();
			return data.ok ? 'Pre-tournament setup completed' : `Partial: ${JSON.stringify(data.log?.filter((s: { ok: boolean }) => !s.ok))}`;
		});
	}

	const anyFailed = log.some((s) => !s.ok);

	const TALK_TO_BALROG = '1317322917129879562';
	try {
		if (anyFailed) {
			const failed = log.filter((s) => !s.ok).map((s) => s.step).join(', ');
			await sendMessage(TALK_TO_BALROG, `⚠️ Event creation for **${eventName}** finished with errors.\nFailed steps: ${failed}`);
		} else {
			const url = tournamentSlug ? `https://start.gg/tournament/${tournamentSlug}` : '';
			await sendMessage(TALK_TO_BALROG, `✅ **${eventName}** created successfully!${url ? `\n${url}` : ''}`);
		}
	} catch (_) {
		// Don't fail the whole response if Discord notification fails
	}

	return Response.json({ ok: !anyFailed, steps: log });
}

export const GET: RequestHandler = async ({ request, locals }) => handleCreateEvent(request, locals.user);
export const POST: RequestHandler = async ({ request, locals }) => handleCreateEvent(request, locals.user);
