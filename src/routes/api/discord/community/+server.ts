/**
 * POST /api/discord/community
 *
 * Handles fun/community Discord actions triggered manually from the hub.
 *
 * Body: { action: 'motivational' | 'dice' | 'yes_or_no' | 'goat' | 'quote' | 'thanks', messages?: string[] }
 *
 * All actions post to #general (1066863005591162961).
 */

import type { RequestHandler } from './$types';
import { sendMessage, getMessages } from '$lib/server/discord';
import { saveCommunityConfig } from '$lib/server/store';

const GENERAL_CHANNEL_ID = '1066863005591162961';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		action: 'motivational' | 'dice' | 'yes_or_no' | 'goat' | 'quote' | 'thanks' | 'save_messages';
		messages?: string[];
	};

	const { action, messages } = body;

	try {
		switch (action) {
			case 'save_messages': {
				if (!Array.isArray(messages)) {
					return Response.json({ error: 'messages must be an array' }, { status: 400 });
				}
				const filtered = messages.map((m) => m.trim()).filter(Boolean);
				await saveCommunityConfig({ motivationalMessages: filtered });
				return Response.json({ ok: true, saved: filtered.length });
			}

			case 'motivational': {
				const pool = Array.isArray(messages) && messages.length > 0
					? messages
					: ['Keep grinding!', 'Every loss is a lesson.', 'The lab never lies.'];
				const pick = pool[Math.floor(Math.random() * pool.length)];
				await sendMessage(GENERAL_CHANNEL_ID, pick);
				return Response.json({ ok: true, sent: pick });
			}

			case 'dice': {
				const roll = Math.floor(Math.random() * 6) + 1;
				await sendMessage(GENERAL_CHANNEL_ID, `🎲 Rolled a ${roll}!`);
				return Response.json({ ok: true, roll });
			}

			case 'yes_or_no': {
				const answer = Math.random() < 0.5 ? 'Yes.' : 'No.';
				await sendMessage(GENERAL_CHANNEL_ID, answer);
				return Response.json({ ok: true, answer });
			}

			case 'goat': {
				const channelMessages = await getMessages(GENERAL_CHANNEL_ID, 100);
				// Find unique non-bot authors
				const authorMap = new Map<string, string>();
				for (const m of channelMessages) {
					if (!m.author.bot && !authorMap.has(m.author.id)) {
						authorMap.set(m.author.id, m.author.username);
					}
				}
				if (authorMap.size === 0) {
					return Response.json({ error: 'No eligible authors found in recent messages.' }, { status: 422 });
				}
				const authors = [...authorMap.values()];
				const chosen = authors[Math.floor(Math.random() * authors.length)];
				await sendMessage(GENERAL_CHANNEL_ID, `@${chosen} is da goat! 🐐`);
				return Response.json({ ok: true, goat: chosen });
			}

			case 'quote': {
				const channelMessages = await getMessages(GENERAL_CHANNEL_ID, 100);
				const eligible = channelMessages.filter((m) => !m.author.bot && m.content.trim().length > 0);
				if (eligible.length === 0) {
					return Response.json({ error: 'No eligible messages found to quote.' }, { status: 422 });
				}
				const picked = eligible[Math.floor(Math.random() * eligible.length)];
				const quoteText = `> ${picked.content}\n— ${picked.author.username}`;
				await sendMessage(GENERAL_CHANNEL_ID, quoteText);
				return Response.json({ ok: true, quoted: picked.content, author: picked.author.username });
			}

			case 'thanks': {
				const responses = ['No worries!', "You're welcome!", 'Anytime 😎', 'All good!', 'You got it!', 'np 👍'];
				const reply = responses[Math.floor(Math.random() * responses.length)];
				await sendMessage(GENERAL_CHANNEL_ID, reply);
				return Response.json({ ok: true, sent: reply });
			}

			default:
				return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json({ error: msg }, { status: 500 });
	}
};
