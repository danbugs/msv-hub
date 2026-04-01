/**
 * Background motivational message poster.
 * Posts a random motivational message to #general on Fridays around noon PDT,
 * throttled to once per 48h. Piggybacks on incoming requests via hooks.server.ts.
 */

import { sendMessage } from '$lib/server/discord';
import { getCommunityConfig, getLastMotivationalTs, setLastMotivationalTs, getDiscordConfig } from '$lib/server/store';

const GENERAL_CHANNEL_ID = '1066863005591162961';
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check at most every 30 min
const THROTTLE_HOURS = 48;

let lastCheckMs = 0;
let running = false;

// Auto-detect Pacific offset (7 for PDT, 8 for PST)
function getPacificHour(): number {
	const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
	return Number(formatter.format(new Date()));
}

function getPacificDay(): number {
	const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
	const day = formatter.format(new Date());
	return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[day] ?? -1;
}

export async function runMotivationalIfDue(): Promise<void> {
	const now = Date.now();
	if (now - lastCheckMs < CHECK_INTERVAL_MS || running) return;
	lastCheckMs = now;
	running = true;

	try {
		const config = await getDiscordConfig();
		if (config.paused) return;

		// Only post on Fridays between 11 AM and 1 PM Pacific
		const pacificDay = getPacificDay();
		const pacificHour = getPacificHour();
		if (pacificDay !== 5 || pacificHour < 11 || pacificHour > 13) return;

		const lastTs = await getLastMotivationalTs();
		const hoursSince = (now - lastTs) / (1000 * 60 * 60);
		if (hoursSince < THROTTLE_HOURS) return;

		const communityConfig = await getCommunityConfig();
		const messages = communityConfig.motivationalMessages;
		if (!messages.length) return;

		const pick = messages[Math.floor(Math.random() * messages.length)];
		await sendMessage(GENERAL_CHANNEL_ID, pick);
		await setLastMotivationalTs(now);
	} finally {
		running = false;
	}
}
