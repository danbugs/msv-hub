/**
 * Background attendee check — runs at most once every 5 minutes,
 * piggybacking on any incoming request via hooks.server.ts.
 *
 * When entrants >= attendeeCap, creates a waitlist forum post and announces.
 */

import { env } from '$env/dynamic/private';
import { getDiscordConfig, saveDiscordConfig } from '$lib/server/store';
import { createForumPost, sendMessage, shortenSlug, truncateTo100 } from '$lib/server/discord';

const STARTGG_API = 'https://api.start.gg/gql/alpha';
const WAITLIST_CHANNEL_ID = '1193295598166737118';
const ANNOUNCE_CHANNEL_ID = '1066863301885173800';
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let lastCheckMs = 0;
let running = false;

export async function runAttendeeCheckIfDue(): Promise<void> {
	const now = Date.now();
	if (now - lastCheckMs < CHECK_INTERVAL_MS || running) return;
	lastCheckMs = now;
	running = true;

	try {
		const config = await getDiscordConfig();
		if (!config.eventSlug || config.paused || config.waitlistCreated) return;

		const token = env.STARTGG_TOKEN;
		if (!token) return;

		const res = await fetch(STARTGG_API, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				query: 'query($slug:String!){event(slug:$slug){numEntrants}}',
				variables: { slug: config.eventSlug }
			})
		});
		if (!res.ok) return;
		const json = await res.json();
		const numEntrants = json.data?.event?.numEntrants ?? 0;

		if (numEntrants >= config.attendeeCap) {
			const title = truncateTo100(`Waitlist for ${shortenSlug(config.eventSlug)}`);
			const waitlistNote = config.attendeeCap === 32
				? '\n\nTop 8 of this waitlist get priority registration for next week.'
				: '';
			const content =
				`Answer in the thread if you'd like to be added to the waitlist!${waitlistNote}\n\n` +
				`Please, let me know if you are bringing a setup. For example, "Dantotto setup"`;

			await createForumPost(WAITLIST_CHANNEL_ID, title, content);
			await saveDiscordConfig({ waitlistCreated: true });

			const shortSlugStr = shortenSlug(config.eventSlug);
			await sendMessage(
				ANNOUNCE_CHANNEL_ID,
				`📢 **${shortSlugStr}** just capped! Add yourself to the waitlist: <#${WAITLIST_CHANNEL_ID}>`
			).catch(() => {});
		}
	} finally {
		running = false;
	}
}
