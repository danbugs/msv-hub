import { readFileSync } from 'node:fs';
try {
	const env = readFileSync('.env', 'utf8');
	for (const line of env.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) process.env[m[1]] = m[2];
	}
} catch {}

const TOKEN = process.env.STARTGG_TOKEN;
// Query the set to find its event, then query all events in that tournament
const res = await fetch('https://api.start.gg/gql/alpha', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
	body: JSON.stringify({
		query: `query { set(id: "101576673") { id event { id name tournament { events { id name } } } } }`
	})
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
