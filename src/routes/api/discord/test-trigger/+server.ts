/**
 * POST /api/discord/test-trigger
 *
 * Manually triggers Discord actions for testing.
 * All test actions post to #talk-to-balrog or the test waitlist channel.
 * Requires session auth (not cron secret).
 *
 * Body: { action: string, ... }
 */

import type { RequestHandler } from './$types';
import {
	sendMessage, sendMessageWithId, editMessage, buildAnnouncementMessage,
	createForumPost, getLatestForumThread, getMessages, shortenSlug, truncateTo100
} from '$lib/server/discord';
import {
	getDiscordConfig,
	getFastestRegLeaderboard, saveFastestRegLeaderboard, buildLeaderboardText,
	type FastestRegEntry
} from '$lib/server/store';
import { exportAttendees } from '$lib/server/startgg-admin';
import { gql } from '$lib/server/startgg';
import { generateFastestRegMessage, generateMotivationalMessage } from '$lib/server/ai';
import { env } from '$env/dynamic/private';

const STARTGG_API = 'https://api.start.gg/gql/alpha';
const TALK_TO_BALROG = '1317322917129879562';
const TEST_WAITLIST_CHANNEL = '1317322581938016317';
const FASTEST_REG_FORUM_ID = '1193306596332290088';

/** Resolve tournament ID from event slug. */
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
	const match = slug.match(/microspacing-vancouver-(\d+)/i);
	if (match) return `MSV#${match[1]}`;
	return shortenSlug(slug);
}

function mentionStr(tag: string, discordId: string): string {
	return discordId ? `<@${discordId}>` : tag;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json() as {
		action: string;
		eventSlug?: string;
		tournamentId?: number;
		/** For manual fastest-reg: whether to post to real forum (true) or talk-to-balrog (false/default) */
		postToReal?: boolean;
	};
	const { action } = body;
	const config = await getDiscordConfig();
	const effectiveSlug = body.eventSlug?.trim() || config.eventSlug;

	// -----------------------------------------------------------------------
	// Test announcement
	// -----------------------------------------------------------------------
	if (action === 'announcement') {
		if (!effectiveSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const message = buildAnnouncementMessage(effectiveSlug, config.attendeeCap, config.announcementTemplate);
		await sendMessage(TALK_TO_BALROG, `[TEST] ${message}`);
		return Response.json({ ok: true, action: 'announcement', message: 'Sent to #talk-to-balrog' });
	}

	// -----------------------------------------------------------------------
	// Test attendee check (dry run)
	// -----------------------------------------------------------------------
	if (action === 'attendee-check') {
		if (!effectiveSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const token = env.STARTGG_TOKEN;
		if (!token) return Response.json({ error: 'STARTGG_TOKEN not set' }, { status: 500 });
		const res = await fetch(STARTGG_API, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				query: 'query($slug:String!){event(slug:$slug){numEntrants}}',
				variables: { slug: effectiveSlug }
			})
		});
		const json = await res.json();
		const numEntrants = json.data?.event?.numEntrants ?? 0;
		return Response.json({
			ok: true, action: 'attendee-check',
			entrants: numEntrants, cap: config.attendeeCap,
			wouldFire: numEntrants >= config.attendeeCap,
			waitlistAlreadyCreated: config.waitlistCreated
		});
	}

	// -----------------------------------------------------------------------
	// Test waitlist
	// -----------------------------------------------------------------------
	if (action === 'waitlist-test') {
		if (!effectiveSlug) return Response.json({ error: 'No event slug configured' }, { status: 400 });
		const title = truncateTo100(`[TEST] Waitlist for ${shortenSlug(effectiveSlug)}`);
		const content =
			`[TEST] Answer in the thread if you'd like to be added to the waitlist!\n\n` +
			`Top 8 of this waitlist get priority registration for next week.\n\n` +
			`Please, let me know if you are bringing a setup. For example, "Dantotto setup"`;
		await createForumPost(TEST_WAITLIST_CHANNEL, title, content);
		await sendMessage(TALK_TO_BALROG, `[TEST] 📢 Event just capped! Waitlist posted to test channel.`);
		return Response.json({ ok: true, action: 'waitlist-test', message: 'Waitlist post created in test channel' });
	}

	// -----------------------------------------------------------------------
	// Test AI motivational (Haiku-generated, posts to talk-to-balrog)
	// -----------------------------------------------------------------------
	if (action === 'motivational-ai') {
		const message = await generateMotivationalMessage();
		await sendMessage(TALK_TO_BALROG, message);
		return Response.json({ ok: true, action: 'motivational-ai', message });
	}

	// -----------------------------------------------------------------------
	// Manual fastest-reg for a specific tournament
	// Posts to the real forum (if postToReal=true) or talk-to-balrog (default).
	// Provide eventSlug or tournamentId.
	// -----------------------------------------------------------------------
	if (action === 'fastest-reg') {
		if (!effectiveSlug) return Response.json({ error: 'No event slug' }, { status: 400 });

		let tournamentId = body.tournamentId ?? null;
		if (!tournamentId) {
			tournamentId = await resolveTournamentId(effectiveSlug);
		}
		if (!tournamentId) return Response.json({ error: 'Could not resolve tournament ID' }, { status: 400 });

		const attendees = await exportAttendees(tournamentId);
		if (attendees.length === 0) {
			return Response.json({ error: 'Export returned 0 attendees' }, { status: 400 });
		}

		// Filter to public reg only: must be on the registration day AND at/after reg time
		const DAY_MAP: Record<string, number> = {
			sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
		};
		const targetDow = DAY_MAP[config.registrationDay] ?? 3;
		const regThreshold = config.registrationHour * 60 + config.registrationMinute;

		// Parse "April 8 2026 8:30 AM" → add comma: "April 8, 2026 8:30 AM"
		function parseRegTs(raw: string): Date | null {
			if (!raw) return null;
			const withComma = raw.replace(/^(\w+ \d{1,2}) (\d{4})/, '$1, $2');
			let ts = new Date(withComma);
			if (!isNaN(ts.getTime())) return ts;
			ts = new Date(raw);
			return isNaN(ts.getTime()) ? null : ts;
		}

		const publicRegs = attendees.filter((a) => {
			const ts = parseRegTs(a.registeredAt);
			if (!ts) return false;
			const pstStr = ts.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
			const pst = new Date(pstStr);
			const dow = pst.getDay();
			return dow === targetDow && pst.getHours() * 60 + pst.getMinutes() >= regThreshold;
		});

		if (publicRegs.length < 4) {
			// Debug: show first 10 attendees with parsed dates for troubleshooting
			const debugLines = attendees.slice(0, 10).map((a) => {
				const ts = parseRegTs(a.registeredAt);
				let pstInfo = 'unparseable';
				if (ts) {
					const pst = new Date(ts.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
					pstInfo = `dow=${pst.getDay()} ${pst.getHours()}:${String(pst.getMinutes()).padStart(2, '0')}`;
				}
				return `${a.gamerTag}: raw="${a.registeredAt}" → ${pstInfo}`;
			}).join('\n');
			return Response.json({
				error: `Only ${publicRegs.length} public registrants (need 4). Total: ${attendees.length}. Target: dow=${targetDow} >=${config.registrationHour}:${String(config.registrationMinute).padStart(2, '0')}\n\nFirst 10:\n${debugLines}`
			}, { status: 400 });
		}

		const winner = publicRegs[0];
		const runnersUp = publicRegs.slice(1, 4);
		const eventLabel = extractEventLabel(effectiveSlug);
		const winnerMention = mentionStr(winner.gamerTag, winner.discordId);
		const runnerMentions = runnersUp.map((r) => mentionStr(r.gamerTag, r.discordId));

		let funMessage: string;
		try {
			funMessage = await generateFastestRegMessage(winnerMention, eventLabel, runnerMentions);
		} catch {
			funMessage = `${winnerMention} wins fastest registrant for ${eventLabel}!\n\nTop 3 after: ${runnerMentions.join(', ')}`;
		}

		if (!body.postToReal) {
			// Test mode — post to talk-to-balrog
			await sendMessage(TALK_TO_BALROG, `[TEST fastest-reg for ${eventLabel}]\n\n${funMessage}`);
			return Response.json({
				ok: true, action: 'fastest-reg', test: true,
				eventLabel, winner: winner.gamerTag,
				runnersUp: runnersUp.map((r) => r.gamerTag),
				message: funMessage
			});
		}

		// Real mode — post to forum + update leaderboard
		const guildId = env.DISCORD_GUILD_ID ?? '';
		const newEntry: FastestRegEntry = {
			eventLabel,
			winnerTag: winner.gamerTag,
			winnerDiscordId: winner.discordId,
			runnersUp: runnersUp.map((r) => ({ tag: r.gamerTag, discordId: r.discordId }))
		};

		let lb = await getFastestRegLeaderboard();

		if (lb && lb.threadId) {
			lb.entries.push(newEntry);
			const leaderboardText = buildLeaderboardText(lb.entries);

			let edited = false;
			if (lb.leaderboardMessageId) {
				try {
					await editMessage(lb.threadId, lb.leaderboardMessageId, leaderboardText);
					edited = true;
				} catch { /* not Balrog's message — post new */ }
			}
			if (!edited) {
				const newMsgId = await sendMessageWithId(lb.threadId, leaderboardText);
				lb.leaderboardMessageId = newMsgId;
			}

			await sendMessage(lb.threadId, funMessage);
			await saveFastestRegLeaderboard(lb);
		} else {
			const leaderboardText = buildLeaderboardText([newEntry]);
			const threadName = truncateTo100(`Fastest Registrant — Season`);
			const thread = await createForumPost(FASTEST_REG_FORUM_ID, threadName, leaderboardText);
			await sendMessage(thread.id, funMessage);

			const msgs = await getMessages(thread.id, 1);
			await saveFastestRegLeaderboard({
				entries: [newEntry],
				threadId: thread.id,
				leaderboardMessageId: msgs[0]?.id ?? '',
				updatedAt: Date.now()
			});
		}

		return Response.json({
			ok: true, action: 'fastest-reg', test: false,
			eventLabel, winner: winner.gamerTag,
			runnersUp: runnersUp.map((r) => r.gamerTag)
		});
	}

	// -----------------------------------------------------------------------
	// New season — create a fresh leaderboard forum post
	// -----------------------------------------------------------------------
	if (action === 'new-season') {
		const guildId = env.DISCORD_GUILD_ID ?? '';
		if (!guildId) return Response.json({ error: 'DISCORD_GUILD_ID not set' }, { status: 400 });

		// Lock the old thread if it exists
		const oldLb = await getFastestRegLeaderboard();
		if (oldLb?.threadId) {
			try {
				const { lockThread } = await import('$lib/server/discord');
				await lockThread(oldLb.threadId);
			} catch { /* best effort */ }
		}

		// Create new forum thread with empty leaderboard
		const threadName = truncateTo100(`Fastest Registrant — New Season`);
		const thread = await createForumPost(FASTEST_REG_FORUM_ID, threadName, 'No fastest registrant data yet. Season starts now!');

		const msgs = await getMessages(thread.id, 1);
		await saveFastestRegLeaderboard({
			entries: [],
			threadId: thread.id,
			leaderboardMessageId: msgs[0]?.id ?? '',
			updatedAt: Date.now()
		});

		return Response.json({ ok: true, action: 'new-season', message: `New season thread created: ${thread.name}` });
	}

	return Response.json({
		error: 'Unknown action. Use: announcement, attendee-check, waitlist-test, motivational-ai, fastest-reg, new-season'
	}, { status: 400 });
};
