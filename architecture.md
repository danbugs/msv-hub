# MSV Hub — Architecture

MSV Hub is a SvelteKit application deployed on Vercel that replaces the Balrog Discord bot and adds a tournament operations dashboard for the Microspacing Vancouver community.

---

## High-Level Overview

```
Browser (dashboard)
      │
      │  HTTPS
      ▼
┌─────────────────────────────────────┐
│         SvelteKit on Vercel         │
│  /dashboard/**  (UI pages)          │
│  /api/**        (API routes)        │
└──┬──────────────┬────────────┬──────┘
   │              │            │
   ▼              ▼            ▼
Upstash        Discord      StartGG
 Redis          REST API      GraphQL
(state)       (bot actions)  (entrant count)
                  │
                  ▼
            Discord Server
```

---

## Components

### 1. SvelteKit App (Vercel)

All logic runs as serverless functions. No persistent process.

| Route | Purpose |
|-------|---------|
| `/dashboard/pre-tournament/discord` | Discord setup UI (config, pre-tournament setup, announcements) |
| `/dashboard/community` | GIF URLs, community config |
| `/dashboard/tournament/swiss` | Run Swiss rounds, report results |
| `/dashboard/tournament/brackets` | Top-8 bracket view |
| `/dashboard/pre-tournament/seed` | Seeding from StartGG |
| `/dashboard/post-tournament` | Post-event wrap-up |
| `/api/discord/config` | GET/POST DiscordConfig in Redis |
| `/api/discord/interactions` | Receives Discord slash command webhooks |
| `/api/discord/pre-tournament-setup` | Locks threads, creates forum posts |
| `/api/discord/announce` | Manual announcement trigger |
| `/api/discord/attendee-check` | Polls StartGG, creates waitlist when capped |
| `/api/discord/cron` | Fires the scheduled announcement |
| `/api/discord/ping` | Ad-hoc message to any channel |
| `/api/tournament/round` | Advance Swiss rounds, report results |

### 2. Upstash Redis

Persistent state across serverless invocations.

| Key | Type | Contents |
|-----|------|----------|
| `discord:config` | Hash/JSON | `DiscordConfig` — event slug, cap, reg time, template, paused, waitlistCreated |
| `community:config` | Hash/JSON | `CommunityConfig` — gifUrls |
| `tournament:active` | JSON | Full tournament state (entrants, rounds, standings, brackets) |

### 3. Discord Integration

#### Slash Commands (guild-scoped, instant registration)

Registered via `/api/discord/register-commands` (one-time call from dashboard).

| Command | Handler |
|---------|---------|
| `/gif` | Picks random URL from Redis `gifUrls` (or hardcoded defaults), replies with embed |
| `/ping` | Responds with "Pong!" |

#### Interaction Endpoint (`POST /api/discord/interactions`)

Discord sends all slash command invocations here as webhooks.

- Signature verified with **tweetnacl** (Ed25519, pure JS — avoids Vercel Web Crypto quirks)
- Responds to PING (type 1) with PONG
- Dispatches APPLICATION_COMMAND (type 2) to the appropriate handler

#### Bot Actions (REST API calls from server)

Used by pre-tournament setup and cron jobs:

- `lockThreadsInChannel(guildId, channelId)` — locks all open threads in a forum channel
- `createForumPost(channelId, name, content)` — creates a new thread in a forum channel
- `sendMessage(channelId, content)` — posts a message to a text channel

### 4. GitHub Actions (Scheduled Jobs)

Two workflows run on a schedule and call Vercel API routes. Protected by `CRON_SECRET` bearer token.

```
discord-attendee-check.yml   — every 5 min
  └─► POST /api/discord/attendee-check
        └─► GET StartGG numEntrants
        └─► if capped: createForumPost(waitlist) + sendMessage(announcements)

discord-cron.yml             — cron schedule (auto-updated when reg time changes)
  └─► POST /api/discord/cron
        └─► buildAnnouncementMessage(slug, cap, template)
        └─► sendMessage(announcements)
```

#### Auto-updating `discord-cron.yml`

When reg time is saved in the Discord Setup page, `updateCronSchedule()` in `src/lib/server/github.ts`:

1. Fetches `.github/workflows/discord-cron.yml` via GitHub Contents API
2. Replaces the `cron:` expression with the new UTC-converted schedule
3. Commits directly to `main` via `PUT /repos/{owner}/{repo}/contents/{path}`

Requires `GITHUB_PAT` (workflow scope) and `GITHUB_REPO` in Vercel env vars.

### 5. StartGG

Queried only by `attendee-check`:

```graphql
query getEventEntrants($slug: String!) {
  event(slug: $slug) { numEntrants }
}
```

Returns current entrant count. When `numEntrants >= attendeeCap`, the waitlist flow fires once (`waitlistCreated` flag prevents repeats).

### 6. Resend (Email / Auth)

OTP-based login. No passwords stored. OTPs print to console in dev if `RESEND_API_KEY` is unset.

---

## Data Flow: Pre-Tournament Weekend

```
Wed morning (auto)
  discord-cron.yml fires
  → POST /api/discord/cron
  → announcement posted to #announcements

Wed–Fri (every 5 min, auto)
  discord-attendee-check.yml fires
  → POST /api/discord/attendee-check
  → polls StartGG
  → if capped: waitlist thread created in #add-me-to-the-waitlist
               cap announcement in #announcements

Tournament day (manual, dashboard)
  1. Discord Setup page → "Run Pre-Tournament Setup"
     → lock old waitlist threads
     → lock old top-8 / dropout / pri-reg threads
     → create new top-8 graphic thread
     → create new dropout thread
     → create new priority-registration thread

  2. Swiss page → "Start Round"
     → generate pairings (Swiss algorithm)
     → assign stations / stream match
     → optional: announce round to selected Discord channel
     → report results match-by-match

  3. After N rounds → auto-transition to brackets phase
```

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `JWT_SECRET` | Yes | Session auth |
| `RESEND_API_KEY` | Prod | Email OTP delivery |
| `EMAIL_FROM` | Prod | Sender address |
| `SEED_TO_EMAILS` | Prod | Admin login emails |
| `STARTGG_TOKEN` | Yes | StartGG API auth |
| `DISCORD_BOT_TOKEN` | Yes | All Discord REST calls |
| `DISCORD_APP_ID` | Yes | Slash command registration |
| `DISCORD_PUBLIC_KEY` | Yes | Interaction signature verification |
| `DISCORD_GUILD_ID` | Yes | Guild-scoped commands |
| `DISCORD_CHANNEL_*` | No | Channel ID overrides (defaults hardcoded) |
| `UPSTASH_REDIS_REST_URL` | Yes | Redis connection |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Redis auth |
| `CRON_SECRET` | Yes | Authenticates GitHub Actions → API calls |
| `APP_URL` | Yes | Live page link in round announcements |
| `GITHUB_PAT` | No | Auto-update cron schedule on reg time change |
| `GITHUB_REPO` | No | `owner/repo` for GITHUB_PAT target |
