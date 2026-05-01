# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MSV Hub is the tournament operations center for Microspacing Vancouver, a weekly Super Smash Bros. Ultimate series. It consolidates pre-tournament Discord automation, Swiss-format tournament management, double-elimination brackets, seeding, and post-tournament tasks into a single SvelteKit web app deployed on Vercel.

## Commands

```sh
npm run dev           # start dev server (Vite)
npm run build         # production build
npm run check         # svelte-kit sync + svelte-check (TypeScript)
npm test              # vitest run (all tests)
npx vitest run src/lib/server/swiss.test.ts   # single test file
```

CI runs `npm run check` then `npm test` on Node 22.

## Architecture

**SvelteKit + Vercel serverless** — no persistent process. All server state lives in **Upstash Redis** (JSON-serialized at known keys like `tournament:active`, `discord:config`, `event:config`).

### Key layers

- **`src/lib/server/store.ts`** — Redis access layer. Defines all config interfaces (`DiscordConfig`, `CommunityConfig`, `EventConfig`, `TOConfig`) and tournament CRUD. Uses `$env/dynamic/private` for credentials. Includes a distributed lock (`acquireLock`/`releaseLock`) for serializing concurrent StartGG reports.
- **`src/lib/server/swiss.ts`** — Swiss pairing engine (ported from Python `daness_v2`). Handles pairing with rematch avoidance, standings calculation, Cinderella bonuses, bracket generation, station assignment, and stream recommendations.
- **`src/lib/types/tournament.ts`** — Core type definitions: `TournamentState`, `SwissRound`, `BracketState`, `BracketMatch`, `FinalStanding`, `AttendeeStatus`. The `TournamentState` is the single source of truth persisted in Redis.
- **`src/lib/server/discord.ts`** — Discord REST helpers (lock threads, create forum posts, send messages).
- **`src/lib/server/startgg.ts`** — StartGG GraphQL client and query definitions.
- **`src/lib/server/startgg-admin.ts`** / **`startgg-reporter.ts`** — StartGG internal REST API operations (bracket split, phase restart, result reporting).
- **`src/lib/server/seeder.ts`** — Elo-based seeding from StartGG historical results.
- **`src/lib/server/ai.ts`** — Claude Haiku for generating Discord community messages (fastest registrant announcements, motivational messages). Has extensive prompt engineering to avoid AI-sounding output.
- **`src/lib/server/auth.ts`** — OTP email auth via Resend + JWT sessions (jose). In dev, OTPs print to console.
- **`src/lib/server/github.ts`** — Auto-updates GitHub Actions cron schedule via Contents API when registration time changes.

### Route structure

- **`/`** — Login page (OTP email flow)
- **`/dashboard/**`** — Auth-gated TO dashboard (redirect to `/` if no session)
- **`/api/auth/**`** — OTP send/verify/logout
- **`/api/discord/**`** — Discord config, interactions webhook, pre-tournament setup, cron, announcements
- **`/api/event/**`** — Automated event creation config and cron (QStash-triggered Tuesday job)
- **`/api/tournament/**`** — Swiss round management, bracket operations, StartGG sync, attendance
- **`/api/seeder/**`** — Elo seeding from StartGG history
- **`/live/[slug]`** — Public live tournament view

### External integrations

- **Upstash Redis** — all persistent state
- **Discord REST API** — bot actions (forum posts, thread locks, messages, slash commands)
- **StartGG GraphQL + internal REST** — entrant data, result reporting, bracket sync
- **Resend** — OTP emails
- **Anthropic (Claude Haiku)** — AI-generated Discord messages
- **QStash** — cron trigger for automated Tuesday event creation
- **GitHub Contents API** — auto-update cron workflow schedules

## Testing

Tests use **Vitest** with Node environment. The setup file (`src/test-setup.ts`) manually loads `.env` into `process.env`. The `$env/dynamic/private` import is aliased to `src/lib/server/__env_shim__.ts` in test config.

Integration tests (e.g., `startgg.integration.test.ts`) hit real APIs and need credentials in `.env`.

## Dev Setup

```sh
cp .env.example .env   # fill in values
npm install
npm run dev
```

Without `RESEND_API_KEY`, OTP codes log to the terminal. Use any email from `SEED_TO_EMAILS` and check console for the code.

## Tech Stack Details

- **Svelte 5** with runes mode enabled (via `svelte.config.js` `dynamicCompileOptions`)
- **Tailwind CSS v4** (via `@tailwindcss/vite` plugin, not PostCSS)
- **UI components**: `src/lib/components/ui/` — shadcn-svelte style (button, badge) with `tailwind-variants`
- **`clsx` + `tailwind-merge`** via `src/lib/utils.ts` for class merging
