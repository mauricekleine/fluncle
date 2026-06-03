# Fluncle

Fluncle publishes drum & bass tracks to Fluncle's Finest on Spotify and Telegram, then shows the public archive on fluncle.com.

## Monorepo Layout

```text
apps/cli      Bun/TypeScript CLI. Source of truth for publishing mutations.
apps/raycast  Raycast extension. Thin client that shells out to the CLI.
apps/web      TanStack Start public web app for read-only playlist browsing.
```

The CLI owns Spotify, Telegram, and Turso mutations. Raycast must keep calling `fluncle`. The web app may read Turso only through TanStack Start API routes in `apps/web/src/routes/api`; do not use server functions for database access.

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

Copy `.env.example` to `.env.local` and fill the missing values:

```bash
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback
SPOTIFY_PLAYLIST_ID=

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=

TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

VITE_FLUNCLE_SPOTIFY_PLAYLIST_URL=
VITE_FLUNCLE_TELEGRAM_URL=
```

Use a read-only Turso token for web deployments.

## CLI

```bash
bun run --cwd apps/cli fluncle add "https://open.spotify.com/track/..." --note "Absolute weapon"
bun run --cwd apps/cli fluncle add "https://open.spotify.com/track/..." --dry-run
bun run --cwd apps/cli fluncle recent --json
bun run --cwd apps/cli fluncle auth spotify
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
install -m 600 ./.env.local ~/.config/fluncle/.env.local
install -m 755 ./apps/cli/dist/fluncle-darwin-arm64 ~/.local/bin/fluncle
```

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

The public app is dark-only and centered around the Fluncle cover art. Track data is loaded from `/api/tracks` with limit/cursor pagination. Track rows open Spotify directly.

### Deploy Web To Cloudflare

The web app deploys as a Cloudflare Worker through Wrangler. Keep Turso credentials out of `wrangler.jsonc`; set them as Worker secrets with a read-only Turso token:

```bash
bun run --cwd apps/web wrangler login
bun run --cwd apps/web wrangler secret put TURSO_DATABASE_URL
bun run --cwd apps/web wrangler secret put TURSO_AUTH_TOKEN
```

For local Worker previews, copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` and fill in the same read-only Turso values:

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

Build a standalone Linux binary locally, copy it to the server, and place config in the operator user's config directory.

```bash
bun run --cwd apps/cli build:vps
scp ./apps/cli/dist/fluncle ./.env.local <host>:/tmp/
```

Run on the server:

```bash
mkdir -p ~/.config/fluncle
install -m 600 /tmp/.env.local ~/.config/fluncle/.env.local
sudo install -m 755 /tmp/fluncle /usr/local/bin/fluncle
rm -f /tmp/fluncle /tmp/.env.local
```

Verify:

```bash
fluncle --help
fluncle recent --limit 1 --json
```

## Publish Flow

`fluncle add` checks Turso for duplicates by Spotify track id. It inserts a pending row first, then adds the track to Spotify, then posts to Telegram. Each external operation is retried three times.

If Spotify fails, Telegram is not posted. If Spotify succeeds but Telegram fails, the database row is kept with `posted_to_telegram = false` for later inspection or recovery.
