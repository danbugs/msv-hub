/**
 * Lightweight AI helpers using Claude Haiku for fun community messages.
 * Used for: fastest registrant announcements, motivational messages.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';

function getClient(): Anthropic {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');
	return new Anthropic({ apiKey });
}

/**
 * Generate a cheesy, fun fastest-registrant announcement for the Discord forum.
 * Style: playful, hype, Smash Bros community vibes. Short (2-4 sentences).
 */
export async function generateFastestRegMessage(
	winner: string,
	eventName: string,
	topRunners: string[]
): Promise<string> {
	const client = getClient();
	const runnersUp = topRunners.length > 0 ? `\n\nTop 3 after: ${topRunners.join(', ')}` : '';

	const response = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 200,
		messages: [
			{
				role: 'user',
				content: `You are writing a fun Discord announcement for a Smash Bros tournament community called "Microspacing Vancouver" (MSV). Someone just won "fastest registrant" — they were the first person to register when registration opened.

Write a SHORT (2-3 sentences max) cheesy, hype announcement. Be creative, playful, and use different styles each time — puns, wordplay, references, dramatic flair, etc. Don't use emojis excessively (1-2 max). The tone should match a fun local Smash community.

Winner: @${winner}
Event: ${eventName}

Just output the announcement text, nothing else. Don't include the top 3 runners-up — I'll append those myself.`
			}
		]
	});

	const text = response.content[0].type === 'text' ? response.content[0].text : '';
	return text.trim() + runnersUp;
}

/**
 * Generate a motivational / community message for the Smash Bros Discord.
 * Style: encouraging, fun, on-topic for fighting game community.
 */
export async function generateMotivationalMessage(): Promise<string> {
	const client = getClient();

	const response = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 150,
		messages: [
			{
				role: 'user',
				content: `You are a friendly community bot for "Microspacing Vancouver" (MSV), a weekly Smash Bros Ultimate local in Vancouver, BC. Write a single short motivational or fun community message (1-2 sentences) to post in the #general Discord channel.

Be varied — sometimes encouraging, sometimes funny, sometimes a hot take prompt, sometimes a question to spark discussion. Keep it natural and not cringe. Don't overuse emojis (0-1 max). Don't mention that you're an AI or bot.

Just output the message, nothing else.`
			}
		]
	});

	return response.content[0].type === 'text' ? response.content[0].text.trim() : 'Keep grinding!';
}
