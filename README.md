# Fluncle

Fluncle publishes drum & bass tracks to Fluncle's Finest on Spotify and Telegram, then shows the public archive on fluncle.com.

## Monorepo Layout

```text
apps/cli      Bun/TypeScript CLI. Thin client for public reads and admin API calls.
apps/raycast  Raycast extension. Thin client that shells out to the CLI.
apps/web      TanStack Start public web app and server-side Fluncle API.
```

The deployed web app owns Spotify, Telegram, and Turso secrets. Public reads are served by `/api/tracks` and `/rss.xml`. Admin mutations are served by authenticated `/api/admin/*` routes. Raycast must keep calling `fluncle`.

## Root Workflows

```bash
bun install
bun run dev
bun run build
bun run typecheck
bun run lint
bun run lint:fix
bun run format
bun run format:check
bun run check
bun run check:fix
```

Root scripts are orchestrated with Turborepo. `oxlint` and `oxfmt` run from the root with workspace-aware configs.

## Environment

Fluncle now has two env surfaces:

- Operator machines: optional `~/.config/fluncle/.env.production` for production CLI admin commands and `~/.config/fluncle/.env.local` for local development.
- Web/API: Wrangler secrets in production, and `apps/web/.dev.vars` for local Worker previews.

The public CLI defaults to `https://www.fluncle.com` and the `production` profile. Admin CLI commands need `FLUNCLE_API_TOKEN`. Set `FLUNCLE_API_BASE_URL` only when pointing the CLI at a non-production API.

## CLI

Install the latest standalone CLI release:

```bash
curl -fsSL https://www.fluncle.com/cli/latest.sh | sh
```

```bash
bun run --cwd apps/cli fluncle recent --json
bun run --cwd apps/cli fluncle version --check
bun run --cwd apps/cli fluncle admin add "https://open.spotify.com/track/..." --note "Absolute weapon"
bun run --cwd apps/cli fluncle admin add "https://open.spotify.com/track/..." --dry-run
bun run --cwd apps/cli fluncle admin auth spotify
bun run --cwd apps/cli fluncle --env local recent --json
```

Database migrations are CLI workspace commands:

```bash
bun run --cwd apps/cli db:generate
bun run --cwd apps/cli db:migrate
```

## Raycast

```bash
bun run --cwd apps/raycast build
bun run --cwd apps/raycast lint
bun run --cwd apps/raycast dev
```

Raycast has one required preference:

```text
Fluncle CLI Path
```

Raycast runs with a minimal shell environment, so this should point to a standalone binary rather than a Bun-linked script. Build and install one locally:

```bash
bun run --cwd apps/cli build:local
mkdir -p ~/.config/fluncle
install -m 755 ./apps/cli/dist/fluncle-darwin-arm64 ~/.local/bin/fluncle
```

For production admin Raycast commands, put only operator API settings in `~/.config/fluncle/.env.production`:

```text
FLUNCLE_API_BASE_URL=https://www.fluncle.com
FLUNCLE_API_TOKEN=<admin token>
```

For local development, put local API settings in `~/.config/fluncle/.env.local` and run CLI commands with `--env local`.

Set the preference to:

```text
/Users/maurice/.local/bin/fluncle
```

Then verify:

```bash
fluncle recent --limit 3 --json
```

## Web

```bash
bun run --cwd apps/web dev
bun run --cwd apps/web build
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web preview
bun run --cwd apps/web deploy
```

The public app is dark-only and centered around the Fluncle cover art. Track data is loaded from `/api/tracks` with limit/cursor pagination. Track rows open Spotify directly and use Spotify album artwork when available. The public RSS feed is available at `/rss.xml`.

### Deploy Web To Cloudflare

The web app deploys as a Cloudflare Worker through Wrangler. Keep secrets out of `wrangler.jsonc`; set them as Worker secrets:

```bash
bun run --cwd apps/web wrangler login
bun run --cwd apps/web wrangler secret put FLUNCLE_API_TOKEN
bun run --cwd apps/web wrangler secret put TURSO_DATABASE_URL
bun run --cwd apps/web wrangler secret put TURSO_AUTH_TOKEN
bun run --cwd apps/web wrangler secret put SPOTIFY_CLIENT_ID
bun run --cwd apps/web wrangler secret put SPOTIFY_CLIENT_SECRET
bun run --cwd apps/web wrangler secret put SPOTIFY_REDIRECT_URI
bun run --cwd apps/web wrangler secret put SPOTIFY_PLAYLIST_ID
bun run --cwd apps/web wrangler secret put TELEGRAM_BOT_TOKEN
bun run --cwd apps/web wrangler secret put TELEGRAM_CHANNEL_ID
```

For local Worker previews and local migration commands, copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` and fill in the same values:

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
bun run --cwd apps/web preview
```

Deploy:

```bash
bun run --cwd apps/web deploy
```

After the first deploy, add `fluncle.com` in the Cloudflare Workers custom domains settings.

## Deploy CLI To A VPS

Build a standalone Linux binary locally, copy it to the server, and place API config in the operator user's config directory.

```bash
bun run --cwd apps/cli build:vps
scp ./apps/cli/dist/fluncle ./fluncle.env <host>:/tmp/
```

Run on the server:

```bash
mkdir -p ~/.config/fluncle
install -m 600 /tmp/fluncle.env ~/.config/fluncle/.env.production
sudo install -m 755 /tmp/fluncle /usr/local/bin/fluncle
rm -f /tmp/fluncle /tmp/fluncle.env
```

Verify:

```bash
fluncle recent --limit 1 --json
```

## Publish Flow

`fluncle admin add` calls `POST /api/admin/tracks` with `Authorization: Bearer <FLUNCLE_API_TOKEN>`. The server checks Turso for duplicates by case-sensitive Spotify track id. It inserts a pending row first, then adds the track to Spotify, then posts to Telegram. Each external operation is retried three times.

If Spotify fails, Telegram is not posted. If Spotify succeeds but Telegram fails, the database row is kept with `posted_to_telegram = false` for later inspection or recovery.

## CLI Releases

Standalone CLI release binaries are built by `.github/workflows/cli-release.yml` when CLI changes are pushed to `main`. The first automated release uses `v0.1.0`; later CLI releases bump the minor version, for example `v0.2.0`, `v0.3.0`. The workflow uses Bun compile targets for macOS arm64/x64 and Linux arm64/x64, bakes the release version into the binary, creates the GitHub Release, and uploads the binaries as release assets. The hosted installer at `https://www.fluncle.com/cli/latest.sh` selects the right asset and installs it to `~/.local/bin/fluncle` by default.

The CLI reports its bundled version with `fluncle version`. `fluncle version --check` compares that version against the latest GitHub Release tag.
