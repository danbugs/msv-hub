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

// Common AI writing tells to avoid — these make text obviously AI-generated.
const AI_AVOIDANCE = `CRITICAL STYLE RULES — your message must sound human-written:
- NEVER use em dashes (—). Use commas, periods, or "..." instead.
- NEVER use these words/phrases: "delve", "tapestry", "landscape", "it's worth noting", "let's dive", "buckle up", "without further ado", "in the realm of", "game-changer", "revolutionize", "embark"
- Don't start with "So..." or "Well..."
- Don't use overly structured sentences. Be messy, casual.
- Use contractions (don't, can't, won't). Never "do not" or "cannot".
- Typos or informal grammar are OK and even encouraged.`;

/**
 * Generate a short, casual fastest-registrant announcement.
 * Style: brief, goofy, like a friend posting.
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
				content: `You're posting in a Smash Bros local Discord (MSV). Someone won "fastest registrant" (first to register when reg opened).

Write a VERY short message (1-2 sentences). Casual, a little goofy, like a friend posting. Vary your style: pun on their name, short quip, simple congrats with personality. Max 1 emoji. No caps lock. No "ALERT" or "BREAKING". Keep it lowkey and fun.

${AI_AVOIDANCE}

Examples of the vibe (don't copy these exactly):
- "@Mossayef is our boy and he won fastest registrant for MSV#74!"
- "HM ( @raphael ) ? More like, He Must have gotten fastest reg at MSV#70!"
- "The 1 in his name stands for #1 fastest registrant! @BrenX1 wins fastest registrant for MSV#78!"
- "@Captain L decided to not Captain Lose this one and took fastest registrant for MSV#75!"

Winner: ${winner}
Event: ${eventName}

Output ONLY the message text. Don't include runners-up.`
			}
		]
	});

	const text = response.content[0].type === 'text' ? response.content[0].text : '';
	return text.trim() + runnersUp;
}

/**
 * Generate a community message for the Smash Bros Discord #general.
 * Style: like a regular community member posting, not a bot.
 */
export async function generateMotivationalMessage(): Promise<string> {
	const client = getClient();

	const response = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 100,
		messages: [
			{
				role: 'user',
				content: `You're posting in #general of a Smash Bros Ultimate local Discord in Vancouver (MSV). Write a single short message (1-2 sentences).

Be varied: sometimes encouraging, sometimes a question to spark discussion, sometimes a hot take, sometimes just vibes. Sound like a regular person in the server, not a bot.

${AI_AVOIDANCE}

Examples of the vibe:
- "who's been labbing something new lately?"
- "shoutout to everyone grinding, see you guys monday"
- "real talk, who do you think is the most underrated player at MSV right now?"
- "reminder to stretch your hands before you play. carpal tunnel is no joke"

Output ONLY the message.`
			}
		]
	});

	return response.content[0].type === 'text' ? response.content[0].text.trim() : 'who else is hyped for next week?';
}
