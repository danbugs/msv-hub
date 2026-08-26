/**
 * POST /api/discord/manual-action
 *
 * Manually trigger real Discord actions and flip the corresponding flags
 * so the automated cron doesn't re-run them.
 *
 * Body: { action: 'waitlist' | 'fastest-reg' }
 * Auth: session (dashboard).
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import {
	createForumPost, sendMessage, sendMessageWithId, editMessage,
	getLatestForumThread, getMessages, shortenSlug, truncateTo100
} from '$lib/server/discord';
import {
	getDiscordConfig, saveDiscordConfig,
	getFastestRegLeaderboard, saveFastestRegLeaderboard, buildLeaderboardText,
	parseLeaderboardEntries,
	type FastestRegEntry
} from '$lib/server/store';
import { exportAttendees } from '$lib/server/startgg-admin';
import { gql } from '$lib/server/startgg';
import { generateFastestRegMessage } from '$lib/server/ai';

const WAITLIST_CHANNEL_ID = '1193295598166737118';
const ANNOUNCE_CHANNEL_ID = '1066863301885173800';
const FASTEST_REG_FORUM_ID = '1193306596332290088';
const TALK_TO_BALROG = '1317322917129879562';

async function resolveTournamentId(eventSlug: string): Promise<number | null> {
	const slugMatch = eventSlug.match(/tournament\/([^/]+)/);
	if (!slugMatch) return null;
	const data = await gql<{ tournament: { id: number } }>(
		'query($slug:String!){tournament(slug:$slug){id}}',
		{ slug: slugMatch[1] }
	);
	return data?.tournament?.id ?? null;
}

function extractEventLabel(slug: string): string {
	const micro = slug.match(/microspacing-vancouver-(\d+)/i);
	if (micro) return `MSV#${micro[1]}`;
	const macro = slug.match(/macrospacing-vancouver-(\d+)/i);
	if (macro) return `Macro#${macro[1]}`;
	return shortenSlug(slug);
}

function mention(tag: string, discordId: string): string {
	return discordId && /^\d{17,20}$/.test(discordId) ? `<@${discordId}>` : tag;
}

function parseRegTimestamp(raw: string): Date | null {
	if (!raw) return null;
	const withComma = raw.replace(/^(\w+ \d{1,2}) (\d{4})/, '$1, $2');
	let ts = new Date(withComma);
	if (!isNaN(ts.getTime())) return ts;
	ts = new Date(raw);
	return isNaN(ts.getTime()) ? null : ts;
}

const DAY_MAP: Record<string, number> = {
	sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json() as { action: string };
	const config = await getDiscordConfig();

	if (!config.eventSlug) {
		return Response.json({ error: 'No event slug configured' }, { status: 400 });
	}

	// ─── Manual Waitlist Creation ───
	if (body.action === 'waitlist') {
		if (config.waitlistCreated) {
			return Response.json({ error: 'Waitlist already created for this event' }, { status: 400 });
		}

		const shortSlugStr = shortenSlug(config.eventSlug);
		const title = truncateTo100(`Waitlist for ${shortSlugStr}`);

		const waitlistNote =
			config.attendeeCap === 32
				? '\n\nTop 8 of this waitlist get priority registration for next week.'
				: '';

		const content =
			`Answer in the thread if you'd like to be added to the waitlist!${waitlistNote}\n\n` +
			`Please, let me know if you are bringing a setup. For example, "Dantotto setup"`;

		await createForumPost(WAITLIST_CHANNEL_ID, title, content);
		await saveDiscordConfig({ waitlistCreated: true, nearCapAlerted: true });

		await sendMessage(
			ANNOUNCE_CHANNEL_ID,
			`📢 **${shortSlugStr}** just capped! Add yourself to the waitlist: <#${WAITLIST_CHANNEL_ID}>`
		).catch(() => {});

		await sendMessage(
			TALK_TO_BALROG,
			`✅ Waitlist manually created for **${shortSlugStr}**`
		).catch(() => {});

		return Response.json({ ok: true, message: `Waitlist created for ${shortSlugStr}` });
	}

	// ─── Manual Fastest Reg ───
	if (body.action === 'fastest-reg') {
		if (config.fastestRegPosted) {
			return Response.json({ error: 'Fastest reg already posted for this event' }, { status: 400 });
		}

		const tournamentId = await resolveTournamentId(config.eventSlug);
		if (!tournamentId) {
			return Response.json({ error: 'Could not resolve tournament ID' }, { status: 400 });
		}

		const attendees = await exportAttendees(tournamentId);
		if (attendees.length === 0) {
			return Response.json({ error: 'Export returned 0 attendees' }, { status: 400 });
		}

		const targetDow = DAY_MAP[config.registrationDay] ?? 3;
		const regThreshold = config.registrationHour * 60 + config.registrationMinute;

		const publicRegs = attendees.filter((a) => {
			const ts = parseRegTimestamp(a.registeredAt);
			if (!ts) return false;
			return ts.getDay() === targetDow && ts.getHours() * 60 + ts.getMinutes() >= regThreshold;
		});

		if (publicRegs.length < 4) {
			return Response.json({
				error: `Only ${publicRegs.length} public registrants (need 4). Total attendees: ${attendees.length}.`
			}, { status: 400 });
		}

		const winner = publicRegs[0];
		const runnersUp = publicRegs.slice(1, 4);
		const eventLabel = extractEventLabel(config.eventSlug);
		const guildId = env.DISCORD_GUILD_ID ?? '';
		if (!guildId) return Response.json({ error: 'DISCORD_GUILD_ID not set' }, { status: 500 });

		const runnerTags = runnersUp.map((r) => r.gamerTag);

		let funMessage: string;
		try {
			funMessage = await generateFastestRegMessage(winner.gamerTag, eventLabel, runnerTags, winner.discordId);
		} catch {
			const winnerMention = mention(winner.gamerTag, winner.discordId);
			funMessage = `${winnerMention} wins fastest registrant for ${eventLabel}!\n\nTop 3 after: ${runnerTags.join(', ')}`;
		}

		const newEntry: FastestRegEntry = {
			eventLabel,
			winnerTag: winner.gamerTag,
			winnerDiscordId: winner.discordId,
			runnersUp: runnersUp.map((r) => ({ tag: r.gamerTag, discordId: r.discordId }))
		};

		let lb = await getFastestRegLeaderboard();
		let threadId = lb?.threadId ?? '';
		let leaderboardMessageId = lb?.leaderboardMessageId ?? '';

		let threadMsgs: Awaited<ReturnType<typeof getMessages>> = [];
		if (threadId) {
			try { threadMsgs = await getMessages(threadId, 50); } catch { threadId = ''; leaderboardMessageId = ''; }
		}
		if (!threadId) {
			const latestThread = await getLatestForumThread(guildId, FASTEST_REG_FORUM_ID);
			if (latestThread) {
				threadId = latestThread.id;
				leaderboardMessageId = '';
				try { threadMsgs = await getMessages(threadId, 50); } catch { threadId = ''; }
			}
		}

		let result: string;

		if (threadId) {
			let existingEntries: FastestRegEntry[] = [];
			if (leaderboardMessageId) {
				const balrogMsg = threadMsgs.find((m) => m.id === leaderboardMessageId);
				if (balrogMsg) existingEntries = parseLeaderboardEntries(balrogMsg.content);
			}
			if (existingEntries.length === 0) {
				const op = threadMsgs.length > 0
					? threadMsgs.reduce((oldest, m) => BigInt(m.id) < BigInt(oldest.id) ? m : oldest)
					: null;
				existingEntries = op ? parseLeaderboardEntries(op.content) : [];
			}

			const allEntries = [...existingEntries];
			if (!allEntries.some((e) => e.eventLabel === newEntry.eventLabel)) {
				allEntries.push(newEntry);
			}
			const leaderboardText = buildLeaderboardText(allEntries);

			let edited = false;
			if (leaderboardMessageId) {
				try { await editMessage(threadId, leaderboardMessageId, leaderboardText); edited = true; } catch { /* stale */ }
			}
			if (!edited) {
				const newMsgId = await sendMessageWithId(threadId, leaderboardText);
				leaderboardMessageId = newMsgId;
			}

			await sendMessage(threadId, funMessage);
			await saveFastestRegLeaderboard({
				entries: allEntries, threadId, leaderboardMessageId,
				seasonNumber: lb?.seasonNumber, updatedAt: Date.now()
			});
			result = `Posted to thread, ${edited ? 'edited' : 'new'} leaderboard (${eventLabel})`;
		} else {
			const entries = [newEntry];
			const leaderboardText = buildLeaderboardText(entries);
			const prevLb = await getFastestRegLeaderboard();
			const seasonNumber = (prevLb?.seasonNumber ?? 0) + 1;
			const threadName = truncateTo100(`Fastest Registrant — Season ${seasonNumber}`);
			const thread = await createForumPost(FASTEST_REG_FORUM_ID, threadName, leaderboardText);
			await sendMessage(thread.id, funMessage);
			const msgs = await getMessages(thread.id, 1);
			await saveFastestRegLeaderboard({
				entries, threadId: thread.id,
				leaderboardMessageId: msgs[0]?.id ?? '', seasonNumber, updatedAt: Date.now()
			});
			result = `Created new forum thread (${eventLabel})`;
		}

		await saveDiscordConfig({ fastestRegPosted: true });

		return Response.json({ ok: true, message: result, winner: winner.gamerTag });
	}

	return Response.json({ error: 'Unknown action. Use: waitlist, fastest-reg' }, { status: 400 });
};
