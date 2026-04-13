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
- NEVER use negative/aggressive words even as hype: "disgusting", "filthy", "nasty", "sick", "insane", "destroyed", "obliterated". Keep it POSITIVE.
- Don't use overly structured sentences. Be messy, casual.
- Use contractions (don't, can't, won't). Never "do not" or "cannot".
- Typos or informal grammar are OK and even encouraged.`;

/**
 * Generate a short, casual fastest-registrant announcement.
 * Style: brief, goofy, like a friend posting.
 */
export async function generateFastestRegMessage(
	winnerTag: string,
	eventName: string,
	topRunners: string[],
	/** If provided, replaces @winnerTag with <@discordId> in the final message */
	winnerDiscordId?: string
): Promise<string> {
	const client = getClient();
	const runnersUp = topRunners.length > 0 ? `\n\nTop 3 after: ${topRunners.join(', ')}` : '';

	const response = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 100,
		temperature: 1.0,
		messages: [
			{
				role: 'user',
				content: `You're posting in a Smash Bros local Discord (MSV). Someone won "fastest registrant" (first to register when reg opened).

Write a VERY short message (1-2 sentences). Casual, a little goofy, like a friend posting. Max 1 emoji. No caps lock. No "ALERT" or "BREAKING". Keep it lowkey and fun.

${AI_AVOIDANCE}

IMPORTANT: You MUST pick ONE of these styles at random. Do NOT default to the same style every time:
1. NAME PUN — make a pun or wordplay on the winner's name (e.g. "HM ( @raphael ) ? More like, He Must have gotten fastest reg!")
2. GAME REFERENCE — use a Smash/FGC term (frame perfect, buffered input, 0-to-death, tech chase, spot dodge, parry, etc.) but pick a DIFFERENT term each time
3. SIMPLE HYPE — just a casual congrats with personality (e.g. "@Mossayef is our boy and he won fastest registrant!")
4. NARRATIVE — tell a tiny story (e.g. "@Captain L decided to not Captain Lose this one and took fastest registrant!")
5. QUESTION/REACTION — act surprised or ask rhetorically (e.g. "wait, @BrenX1 again?? that's three in a row!")

Pick style number: ${Math.floor(Math.random() * 5) + 1}

Winner: @${winnerTag}
Event: ${eventName}

Output ONLY the message text. Always refer to the winner as @${winnerTag}. Don't include runners-up.`
			}
		]
	});

	let text = response.content[0].type === 'text' ? response.content[0].text : '';
	text = text.trim();

	// Replace @gamerTag with proper Discord mention if we have a valid snowflake
	if (winnerDiscordId && /^\d{17,20}$/.test(winnerDiscordId)) {
		text = text.replace(new RegExp(`@${winnerTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), `<@${winnerDiscordId}>`);
	}

	return text + runnersUp;
}

/**
 * Generate a community message for the Smash Bros Discord #general.
 * Style: a friendly bot (Balrog) that says funny/silly things — NOT pretending to be a player.
 */
export async function generateMotivationalMessage(): Promise<string> {
	const client = getClient();

	const response = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 100,
		temperature: 1.0,
		messages: [
			{
				role: 'user',
				content: `You are Balrog, a Discord bot for a Smash Bros Ultimate local in Vancouver (MSV). Post a short fun message to #general (1-2 sentences).

CRITICAL: You are a bot. Do NOT pretend to be a player or roleplay as having human experiences:
- NEVER say things like "anyone else been labbing...", "I've been feeling...", "I was playing online and..."
- NEVER imply you played, practiced, watched matches, have opinions on tier lists, felt lag, etc.
- You don't have a main, you don't play the game.

DO be: a fun bot that throws out bot-aware jokes, absurd observations, silly hypotheticals, random Smash factoids, encouragements for the community, or nonsense Balrog references.

${AI_AVOIDANCE}

Good vibes (match this register, don't copy):
- "reminder: your Switch dock is the real final boss. hug it tonight."
- "Balrog.exe thinks everyone should bring at least 3 extra cables to MSV. redundancy is beautiful."
- "public service announcement from your favorite bot: stretch those wrists before Monday."
- "if Balrog had hands, he'd be a Kazuya player. luckily he doesn't."
- "funny how the word 'tournament' has the word 'our' in it. community moment."
- "Monday's coming. you know what that means. (it means Monday.)"

Output ONLY the message.`
			}
		]
	});

	return response.content[0].type === 'text' ? response.content[0].text.trim() : 'who else is hyped for next week?';
}
