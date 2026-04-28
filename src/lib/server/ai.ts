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
- BANNED PATTERNS (if your message matches any of these, rewrite it completely):
  * "[char] really said...", "[char] really [verb]..."
  * "[char]'s whole thing/gimmick/brand/deal is..."
  * "[char]'s literally just...", "[char] is literally..."
  * "[char] out here [verb]ing..."
- NEVER use the word "really" or the phrase "out here". These are overused AI-isms.
- NEVER use "got that X energy", "said X and meant it", or "X and honestly". These are AI templates.
- NEVER use "go-to" or "yo what's everyone". These are overused openings.
- NEVER say what something is NOT for. Only say what it IS for.
- NEVER reference violence or weapons, even as jokes. Nothing about guns, knives, whipping out weapons, etc.
- NEVER use em dashes (—). Use commas, periods, or "..." instead.
- NEVER use these words/phrases: "delve", "tapestry", "landscape", "it's worth noting", "let's dive", "buckle up", "without further ado", "in the realm of", "game-changer", "revolutionize", "embark"
- Don't start with "So..." or "Well..."
- NEVER use negative/aggressive words even as hype: "disgusting", "filthy", "nasty", "sick", "insane", "destroyed", "obliterated". Keep it POSITIVE.
- Don't use overly structured sentences. Be messy, casual.
- Use contractions (don't, can't, won't). Never "do not" or "cannot".
- Typos or informal grammar are OK and even encouraged.
- NEVER say "we" or "us" when talking about running the event, reading suggestions, etc. You're a bot, not a TO. Say "TOs" instead.
- NEVER use "lol" or "lmao" anywhere in the message. Keep it dry, let the joke land on its own.
- No religious references ("god", "gods", "goddess", "pray", "demons", "divine", etc) even if the character is one in their game. Keep it neutral.
- NEVER make gameplay claims (tier list, moves being good/bad, buffs/nerfs, recovery quality, speed). You'll get them wrong. Stick to names, lore, appearance, franchise stuff.
- NEVER claim a character is or isn't DLC unless you're 100% sure. The DLC fighters are: Piranha Plant, Joker, Hero, Banjo & Kazooie, Terry, Byleth, Min Min, Steve, Sephiroth, Pyra/Mythra, Kazuya, Sora.
- NEVER use the template "[character] really said '...'". Vary your format.`;

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
		temperature: 0.9,
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

	const style = Math.floor(Math.random() * 3) + 1;

	const characters = [
		'Mario', 'Donkey Kong', 'Link', 'Samus', 'Yoshi', 'Kirby', 'Fox', 'Pikachu',
		'Luigi', 'Ness', 'Captain Falcon', 'Jigglypuff', 'Peach', 'Daisy', 'Bowser',
		'Ice Climbers', 'Sheik', 'Zelda', 'Dr. Mario', 'Pichu', 'Falco', 'Marth',
		'Lucina', 'Young Link', 'Ganondorf', 'Mewtwo', 'Roy', 'Chrom', 'Game & Watch',
		'Meta Knight', 'Pit', 'Dark Pit', 'Zero Suit Samus', 'Wario', 'Snake', 'Ike',
		'Pokemon Trainer', 'Diddy Kong', 'Lucas', 'Sonic', 'King Dedede', 'Olimar',
		'Lucario', 'ROB', 'Toon Link', 'Wolf', 'Villager', 'Mega Man', 'Wii Fit Trainer',
		'Rosalina', 'Little Mac', 'Greninja', 'Palutena', 'Pac-Man', 'Robin', 'Shulk',
		'Bowser Jr', 'Duck Hunt', 'Ryu', 'Ken', 'Cloud', 'Corrin', 'Bayonetta',
		'Inkling', 'Ridley', 'Simon', 'Richter', 'King K. Rool', 'Isabelle',
		'Incineroar', 'Piranha Plant', 'Joker', 'Hero', 'Banjo & Kazooie',
		'Terry', 'Byleth', 'Min Min', 'Steve', 'Sephiroth', 'Pyra/Mythra',
		'Kazuya', 'Sora'
	];
	const char = characters[Math.floor(Math.random() * characters.length)];

	const msvTopics = [
		'reg opens Wednesdays at 8:30AM', 'report your matches', 'micro-clips channel',
		'how-to-get-to-the-venue channel', 'drop-out ban rules', 'whiteboard match reporting',
		'suggestion-box channel', 'elevator pickup schedule', 'bring setups for swiss',
		'be on time for 6PM bracket', 'lost-and-found channel', 'share-your-pets channel',
		'braacket seasonal ranking', 'kitchen drinks', 'waitlist rules',
		'talk-to-a-to for TOs', 'matchmaking channel for online', '/balrog_help commands',
		'promote-yourself channel', 'music-reccs channel',
		'wheres-the-washroom channel', 'FAQ in announcements', 'quit friendlies when bracket starts',
		'common tag discriminator tip'
	];
	const topic = msvTopics[Math.floor(Math.random() * msvTopics.length)];

	let userPrompt: string;
	if (style === 1) {
		userPrompt = `Write a short one-liner about ${char} from Smash Ultimate. Keep it to 1 sentence, 2 max. Corny puns on the name are ideal.

RULES:
- Base it on the character's NAME, appearance, or their original franchise/game.
- Do NOT describe what the character does in Smash (moves, recovery, speed, matchups, tier list).
- Do NOT make up facts about the character. If unsure about their lore, just pun on the name.
- Keep it SHORT. Most good examples below are under 10 words.

BAD (never write like this):
- "kirby really said 'flat' and meant it"
- "link's whole thing is just being a sword guy"
- "ness is out here with psychic powers"
- "mario is literally just a plumber in a fighting game"

GOOD (match this vibe, don't copy):
"pac backwards spells cap, no cap"
"kirby doesn't suck. He inhales!"
"no fox given"
"google chrom"
"ridley should be bigger"
"bayonetta? more like, bae no..."
"mewtwo? more like mew zero, nobody playing that char these days..."
"bowser? so long!"
"roy is not my boy"
"hero? not my hero..."
"sephiroth!!"
"peach is momo in japanese."
"sheik ain't fooling nobody"
"duck hunt? maybe duck friendship..."
"i never learned how to read! - pit"
"don't be like wario, use deodorant"
"bird! bird! bird is the word! Falco!"
"I fight for my friends - ike"
"ice climbers rumoured to be at whistler this weekend"
"imagine if villager had a minecraft villager skin..."
"wonder if king kong is part of the diddy kong family"
"in their character renders, ryu is not smiling but ken is"`;

	} else if (style === 2) {
		userPrompt = `Write a short MSV info reminder about: ${topic}. ONE fact or pointer, 1-2 sentences max. No character jokes.

You are NOT a TO. Never say "we" about running the event. Direct people to "TOs" or "the TOs". Say "let TOs know" not "lmk".
Don't add # before channel names. Just say the channel name plainly.

Context:
- Tournaments every Monday, doors 5PM, bracket 6PM
- Reg opens Wednesdays 8:30AM on StartGG
- Format: Swiss pools into double elim brackets (main & redemption)
- Elevator pickup: 5:15, 5:30, 5:40, 5:50, 6:05 PM last call
- Drop-out after 9AM Monday = 1-week ban. After 3PM = 2-week ban. DM TOs if legit reason
- Can add yourself + 1 friend to waitlist (not 2)
- Kitchen has hot chocolate, coffee, water, tea available. Fridge is employees only
- Rankings: braacket.com/league/MSVS/ranking

Channel purposes (don't confuse them):
- micro-clips = share tournament clips
- promote-yourself = self-promo (streams, content, socials)
- music-reccs = music recommendations
- lost-and-found = lost items at venue
- share-your-pets = pet pics
- matchmaking = find online matches

Examples (don't copy, match this vibe):
"set up your alarms for 8:30AM on Wednesdays for reg"
"remember to report your matches"
"drop your clips in micro-clips"
"first micro? check the how-to-get-to-the-venue channel"
"if u drop out after 3PM on a Monday, that's a 2-week ban. DM TOs if smt comes up tho"
"Got a suggestion? Drop it in suggestion-box"
"bring setups so we can run swiss"
"Pet pics in share-your-pets"
"kitchen has hot chocolate, coffee, water, tea. fridge is employees only tho"
"let TOs know in talk-to-a-to if you're running late"`;
	} else if (style === 3) {
		userPrompt = `Write a casual community engagement question for the MSV Smash Bros Discord. Something that gets people talking. 1-2 sentences max.

IMPORTANT:
- Keep it positive and forward-looking.
- Do NOT make assumptions about problems (attendance, drama, etc). No passive-aggressive vibes.
- Do NOT ask about "grinding", "who's been practicing", "switching mains", or "maining something new". These are overused.
- Do NOT ask about other locals or the scene outside MSV.
- Do NOT start with "yo what's everyone".

Examples (don't copy, match this vibe, and pick a DIFFERENT topic each time):
"who planning to be up regging they micro?"
"wondering who gonna get fastest reg..."
"anyone focusing on any specific awards for this season? will be interesting to see who gets most improved"
"wondering who will be the biggest up and comer of the season..."
"Why do people be changing their tags every 30 days?"
"we run swiss, like the cheese, bunch of cheese matches too"
"what character do u wanna see more of at micro?"
"who's bringing setups this week?"
"what's your favorite stage to play on and why"
"anyone got a matchup they just can't figure out?"
"how long have u been coming to micro?"
"what's the funniest moment u've had at micro?"
"if u could add one rule to micro what would it be"
"who had the best set last week?"
"what's the most hype match u've seen at micro?"
"who's ur favorite player to watch at micro?"
"what was ur first micro like?"`;
	} else {
		userPrompt = `Write a short one-liner about ${char} from Smash Ultimate. Keep it to 1 sentence. Corny puns on the name are ideal.`;
	}

	const systemPrompt = `You are Balrog, a Discord bot for MSV (Microspacing Vancouver), a Smash Bros Ultimate weekly local. You post short casual messages to #general. You're a bot, not a player.

You are NOT a TO (tournament organizer). Never say "we" when referring to running the tournament or reading suggestions. Direct people to "TOs" or "the TOs" instead. When telling people to communicate about lateness/dropouts, say "let TOs know" or "DM TOs", not "lmk" or "let me know".

${AI_AVOIDANCE}

Tone: casual discord speak. "boutta", "smt", "lowkey", "u" are fine. corny puns encouraged. just post like a normal person in a discord server. Output ONLY the message — no commentary, no self-corrections, no preamble. Keep it short.`;

	const banned = /\breally\b|\bwhole\b|\bliterally just\b|\bout here\b|\blol\b|\blmao\b|\bgoddess\b|\bgods?\b|\bdemons?\b|\bmeant it\b|\bhonestly\b|\bthat .{2,20} energy\b|\bdrip\b|\bgo-to\b|\bweapons?\b|\byo what'?s everyone/i;

	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await client.messages.create({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 100,
			temperature: 0.9,
			system: systemPrompt,
			messages: [{ role: 'user', content: userPrompt }]
		});

		const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
		if (!text) continue;

		const firstLine = text.split('\n')[0].trim();
		if (!banned.test(firstLine)) return firstLine;
	}

	return 'who planning to be up regging they micro?';
}
