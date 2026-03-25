/**
 * GitHub API helpers.
 *
 * Currently used only to auto-update the discord-cron.yml workflow schedule
 * when the user changes the registration time in Discord config. All operations
 * are best-effort — missing credentials cause a silent no-op rather than an error.
 */

import { env } from '$env/dynamic/private';

const GITHUB_API = 'https://api.github.com';

const DAY_NUM: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6
};

/**
 * Converts a PST registration time to a cron expression in UTC.
 *
 * Uses a fixed -8 offset (PST). This is intentionally 1 hour off during PDT,
 * which is acceptable for the community's use case.
 */
function buildCronExpression(day: string, pstHour: number, minute: number): string {
	const utcHour = (pstHour + 8) % 24;
	// If wrapping past midnight, the UTC day is one day ahead.
	let dayNum = DAY_NUM[day] ?? 3;
	if (utcHour < pstHour) {
		dayNum = (dayNum + 1) % 7;
	}
	return `'${minute} ${utcHour} * * ${dayNum}'`;
}

/**
 * Reads the current discord-cron.yml, replaces the cron expression, and
 * commits the result back via the GitHub Contents API.
 *
 * Silently returns if GITHUB_PAT or GITHUB_REPO are not set.
 */
export async function updateCronSchedule(
	day: string,
	pstHour: number,
	minute: number
): Promise<void> {
	const pat = env.GITHUB_PAT;
	const repo = env.GITHUB_REPO;

	if (!pat || !repo) return;

	const expression = buildCronExpression(day, pstHour, minute);
	const filePath = '.github/workflows/discord-cron.yml';
	const apiUrl = `${GITHUB_API}/repos/${repo}/contents/${filePath}`;

	const headers: HeadersInit = {
		Authorization: `Bearer ${pat}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'Content-Type': 'application/json'
	};

	// Fetch current file to get SHA and content.
	let currentSha: string;
	let currentContent: string;
	try {
		const getRes = await fetch(apiUrl, { headers });
		if (!getRes.ok) {
			console.warn(`github: failed to fetch ${filePath}: ${getRes.status}`);
			return;
		}
		const fileData = (await getRes.json()) as { sha: string; content: string };
		currentSha = fileData.sha;
		currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
	} catch (e) {
		console.warn('github: error fetching workflow file:', e);
		return;
	}

	// Replace the cron: line with the new expression.
	const updated = currentContent.replace(
		/(\s*-\s*cron:\s*)(['"])[^'"]+\2/,
		`$1${expression}`
	);

	if (updated === currentContent) {
		// Nothing changed (expression was already the same).
		return;
	}

	const newContentB64 = Buffer.from(updated, 'utf-8').toString('base64');

	try {
		const putRes = await fetch(apiUrl, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				message: `chore: update announcement cron schedule to ${expression}`,
				content: newContentB64,
				sha: currentSha
			})
		});
		if (!putRes.ok) {
			const body = await putRes.text();
			console.warn(`github: failed to update ${filePath}: ${putRes.status} ${body.slice(0, 200)}`);
		}
	} catch (e) {
		console.warn('github: error committing workflow file:', e);
	}
}
