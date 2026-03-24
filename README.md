# MSV Hub

Tournament operations center for Microspacing Vancouver — a weekly Super Smash Bros. Ultimate series.

Centralizes pre-tournament setup (Discord, seeding), tournament management (Swiss rounds, brackets, station assignments), and post-tournament tasks (graphics, VOD, Braacket/StartGG sync) into a single web app.

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
| `SEED_TO_EMAILS` | No | Initial TO email(s), comma-separated |
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

Without `RESEND_API_KEY`, OTP codes are logged to the terminal — use `danilochiarlone@hotmail.com` (or whatever `SEED_TO_EMAILS` is set to) and check the console for the code.
