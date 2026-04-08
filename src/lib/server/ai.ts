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
 * Generate a short, casual fastest-registrant announcement.
 * Style: brief, goofy, like a friend posting — NOT corporate or hype-beast.
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
		max_tokens: 100,
		messages: [
			{
				role: 'user',
				content: `You're a chill community bot for a Smash Bros local called MSV. Someone won "fastest registrant" (first to register when reg opened).

Write a VERY short announcement (1-2 sentences). Be casual and a little goofy, like a friend posting — not corporate, not try-hard. Vary your style: sometimes a pun on their name, sometimes a short quip, sometimes just a simple congrats with personality. No emojis or max 1. No caps lock. No "ALERT" or "BREAKING". Keep it lowkey.

Examples of the vibe (don't copy these):
- "@Mossayef is our boy and he won fastest registrant for MSV#74!"
- "HM ( @raphael ) ? More like, He Must have gotten fastest reg at MSV#70!"
- "The 1 in his name stands for #1 fastest registrant! @BrenX1 wins fastest registrant for MSV#78!"

Winner: ${winner}
Event: ${eventName}

Output ONLY the message. Don't include runners-up — I add those.`
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
