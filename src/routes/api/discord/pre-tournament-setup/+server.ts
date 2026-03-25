/**
 * POST /api/discord/pre-tournament-setup
 *
 * Replicates `!do_pre_tournament_setup` from Balrog:
 *   1. Lock all open threads in the waitlist channel.
 *   2. Lock old top-8 graphic threads, create a new one.
 *   3. Lock old "dropping out" threads, create a new one.
 *   4. Lock old priority-registration threads, create a new one.
 *
 * Returns a structured log of every action taken so the UI can show progress.
 */

import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import {
	lockThreadsInChannel,
	createForumPost,
	shortenSlug,
	truncateTo100
} from '$lib/server/discord';
import { getDiscordConfig } from '$lib/server/store';

// Channel IDs — set via env so they can be overridden without code changes.
// Defaults match the hardcoded IDs from Balrog for MSV's actual server.
function channelId(envKey: string, fallback: string): string {
	return (env as Record<string, string | undefined>)[envKey] ?? fallback;
}

// Test channel IDs match Balrog's hardcoded test channels.
// Top-8/dropout/pri-reg have no dedicated test forums, so all forum
// operations in dry-run mode are routed to the test waitlist channel.
const TEST_WAITLIST = '1317322581938016317';

function getChannels(dry: boolean) {
	if (dry) {
		return {
			waitlist: TEST_WAITLIST,
			top8:     TEST_WAITLIST,
			dropout:  TEST_WAITLIST,
			priReg:   TEST_WAITLIST
		};
	}
	return {
		waitlist: channelId('DISCORD_CHANNEL_WAITLIST', '1193295598166737118'),
		top8:     channelId('DISCORD_CHANNEL_TOP8', '1193298151503831163'),
		dropout:  channelId('DISCORD_CHANNEL_DROPOUT', '1193304496583999588'),
		priReg:   channelId('DISCORD_CHANNEL_PRI_REG', '1194324348014698496')
	};
}

interface StepResult {
	step: string;
	ok: boolean;
	detail: string;
}

export const POST: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const dry = url.searchParams.get('dry') === 'true';

	const guildId = env.DISCORD_GUILD_ID;
	if (!guildId) return Response.json({ error: 'DISCORD_GUILD_ID is not configured' }, { status: 500 });

	const config = await getDiscordConfig();
	if (!config.eventSlug) {
		return Response.json(
			{ error: 'No event slug configured — set it in the Discord Setup page first.' },
			{ status: 400 }
		);
	}

	const shortSlug = shortenSlug(config.eventSlug);
	// In dry-run mode use test channel IDs so all real Discord calls happen
	// against safe channels rather than production ones.
	const channels = getChannels(dry);
	const log: StepResult[] = [];

	// Helper: run a step, catch errors, keep going.
	async function step(name: string, fn: () => Promise<string>): Promise<void> {
		try {
			const detail = await fn();
			log.push({ step: name, ok: true, detail: dry ? `[DRY RUN] ${detail}` : detail });
		} catch (e) {
			log.push({ step: name, ok: false, detail: e instanceof Error ? e.message : String(e) });
		}
	}

	// 1. Lock waitlist threads
	await step(
		'Lock waitlist threads',
		async () => {
			const { locked, names } = await lockThreadsInChannel(guildId!, channels.waitlist);
			if (locked === 0) return 'No open waitlist threads to lock.';
			return `Locked ${locked} thread(s): ${names.join(', ')}`;
		}
	);

	// 2. Top-8 graphic forum
	const top8Name = truncateTo100(`Top 8 graphic for ${shortSlug}`);
	await step(
		'Lock top-8 graphic threads',
		async () => {
			const { locked } = await lockThreadsInChannel(guildId!, channels.top8);
			return locked > 0 ? `Locked ${locked} thread(s).` : 'No open threads to lock.';
		}
	);
	await step(
		'Create top-8 graphic thread',
		async () => {
			const thread = await createForumPost(channels.top8, top8Name, 'Reply below w/ your characters and alts for the top 8');
			return `Created "${thread.name}" (${thread.id})`;
		}
	);

	// 3. Dropping-out forum
	const dropoutName = truncateTo100(`Dropping Out from ${shortSlug}?`);
	let dropoutContent = 'Let me know below!';
	if (config.attendeeCap === 32) {
		dropoutContent +=
			'\n\nThe deadline to drop-out without penalty is 9AM on Monday. ' +
			"If you drop out after 9AM but before 3PM, you're banned from next event. " +
			"If you drop out after 3PM, you're banned from the next 2 events. " +
			'For more details, see #faq .';
	} else if (config.attendeeCap === 64) {
		dropoutContent += '\n\nThe deadline to drop-out without penalty is Sunday midnight. ';
	}
	await step(
		'Lock dropping-out threads',
		async () => {
			const { locked } = await lockThreadsInChannel(guildId!, channels.dropout);
			return locked > 0 ? `Locked ${locked} thread(s).` : 'No open threads to lock.';
		}
	);
	await step(
		'Create dropping-out thread',
		async () => {
			const thread = await createForumPost(channels.dropout, dropoutName, dropoutContent);
			return `Created "${thread.name}" (${thread.id})`;
		}
	);

	// 4. Priority-registration forum
	const priRegName = truncateTo100(`Pri. Reg. for ${shortSlug}`);
	const priRegContent =
		config.attendeeCap === 32
			? "If you were in the top 8 for the waitlist for this last micro event, " +
			  "you have priority registration for next week, so, if you can make it, " +
			  "I'll add you to bracket!~ just let me know before Wednesday 'cause reg. goes live then."
			: 'See below!';
	await step(
		'Lock priority-registration threads',
		async () => {
			const { locked } = await lockThreadsInChannel(guildId!, channels.priReg);
			return locked > 0 ? `Locked ${locked} thread(s).` : 'No open threads to lock.';
		}
	);
	await step(
		'Create priority-registration thread',
		async () => {
			const thread = await createForumPost(channels.priReg, priRegName, priRegContent);
			return `Created "${thread.name}" (${thread.id})`;
		}
	);

	const anyFailed = log.some((s) => !s.ok);
	return Response.json({ ok: !anyFailed, log });
};
