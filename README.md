# MSV Hub

Tournament operations center for Microspacing Vancouver — a weekly Super Smash Bros. Ultimate series.

Centralizes pre-tournament setup (Discord, seeding), tournament management (Swiss rounds, brackets, station assignments), and post-tournament tasks (graphics, VOD, Braacket/StartGG sync) into a single web app.

## Built From

This project consolidates tooling previously spread across several places:

- **[daness](https://github.com/danbugs/daness)** — Swiss pairing engine (ported to TypeScript as `src/lib/server/swiss.ts`)
- **[msv-discord-bot](https://github.com/danbugs/msv-discord-bot)** — Discord pre-tournament automation (in progress)
- **[start.gg API](https://developer.start.gg)** — Event import, seed sync

## Stack

- **SvelteKit** + TypeScript + Tailwind CSS
- **Vercel** (serverless deployment)
- **Resend** for OTP login emails
- **jose** for JWT session tokens

## Setup

```sh
npm install
cp .env.example .env  # edit with your values
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes (prod) | Random secret for signing session tokens |
| `RESEND_API_KEY` | No | Resend API key — OTPs print to console without it |
| `EMAIL_FROM` | No | Sender address (needs verified Resend domain) |
| `SEED_TO_EMAILS` | Yes (prod) | Primary TO email(s), comma-separated |
| `EXTRA_TO_EMAILS` | No | Additional TO email(s), comma-separated |
| `STARTGG_TOKEN` | No | start.gg API bearer token |
| `DISCORD_BOT_TOKEN` | No | Discord bot token for pre-tournament setup |

## Development

```sh
npm run dev           # start dev server
npm run build         # production build
npm run preview       # preview production build
npm run check         # type-check
```

Without `RESEND_API_KEY`, OTP codes are logged to the terminal — enter whatever email you set in `SEED_TO_EMAILS` and check the console for the code.
