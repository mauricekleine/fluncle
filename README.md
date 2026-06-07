# Fluncle

> Drum & bass bangers from another dimension.

Fluncle publishes drum & bass tracks to Fluncle's Finest on Spotify and Telegram, then shows the public archive on fluncle.com.

## Monorepo Layout

```text
apps/cli         Bun/TypeScript CLI. Thin client for public reads and admin API calls.
apps/raycast     Raycast extension. Thin client that shells out to the CLI.
apps/ssh         Go Wish/Bubble Tea SSH terminal behind ssh rave.fluncle.com. Thin client of the public API.
apps/web         TanStack Start public web app and server-side Fluncle API.
packages/tokens  Shared design tokens (colors, typography, radii, motion) from DESIGN.md.
packages/video   Remotion kit for per-track social videos (the Nostalgic Cosmos).
```

The deployed web app owns the Spotify, Telegram, Turso, and Loops secrets. Public reads are served by `/api/tracks` (with `since`/`until` discovery windows), `/api/tracks/random`, and `/rss.xml`. Newsletter signups post to `/api/newsletter`, which the web app relays to Loops. Admin mutations are served by authenticated `/api/admin/*` routes. Raycast must keep calling `fluncle`.
Listener submissions are accepted through public `/api/search` and `/api/submissions` routes, then reviewed through authenticated admin submission routes. Approval still publishes only through the existing admin add flow.

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
bun run --cwd apps/cli fluncle list --limit 10
bun run --cwd apps/cli fluncle open
bun run --cwd apps/cli fluncle open playlist --browser
bun run --cwd apps/cli fluncle open telegram --app
bun run --cwd apps/cli fluncle submit
bun run --cwd apps/cli fluncle submit "https://open.spotify.com/track/..."
bun run --cwd apps/cli fluncle version --check
bun run --cwd apps/cli fluncle admin add "https://open.spotify.com/track/..." --note "Absolute weapon"
bun run --cwd apps/cli fluncle admin add "https://open.spotify.com/track/..." --dry-run
bun run --cwd apps/cli fluncle admin submissions
bun run --cwd apps/cli fluncle admin submissions review <submission-id>
bun run --cwd apps/cli fluncle admin submissions reject <submission-id>
bun run --cwd apps/cli fluncle admin submissions approve <submission-id>
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

## SSH

The rave terminal at `ssh rave.fluncle.com` is a Go app built on Wish and Bubble Tea. It serves the public archive over SSH: browse and submit tracks, subscribe to the newsletter, install the CLI. It reads the same public API as the other clients and owns no secrets.

Run it locally and connect from a second terminal:

```bash
cd apps/ssh
go run .
ssh -p 2222 127.0.0.1
```

Configuration is environment-driven: `FLUNCLE_SSH_HOST` and `FLUNCLE_SSH_PORT` (defaults `127.0.0.1:2222`), `FLUNCLE_API_URL` (defaults to production), `FLUNCLE_SSH_DATA_DIR` for generated host keys (defaults to `.local`, gitignored), and optional `FLUNCLE_GEOIP_DB` pointing at a MaxMind-compatible `.mmdb` for the connected-ravers country codes (lookups render `VOID` without it).

Checks:

```bash
go build -C apps/ssh ./...
gofmt -l apps/ssh
go vet -C apps/ssh ./...
```

Production runs as the `fluncle-ssh` systemd service on a dedicated VPS: the app terminates public TCP/22 while administrative OpenSSH listens on 2222 over Tailscale only. Cross-compile and deploy with the `hetzner-devbox` skill, which also documents provisioning and the monthly GeoIP refresh:

```bash
GOOS=linux GOARCH=amd64 go build -C apps/ssh -o dist/fluncle-ssh-linux-x64 .
SERVER_NAME=<tailscale-ip> BINARY_PATH=apps/ssh/dist/fluncle-ssh-linux-x64 \
  FLUNCLE_API_URL=https://www.fluncle.com \
  FLUNCLE_GEOIP_DB=/var/lib/fluncle-ssh/dbip-country-lite.mmdb \
  packages/skills/hetzner-devbox/scripts/deploy-ssh-app-service.sh
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

The public app is dark-only and centered around the Fluncle cover art. The first page of tracks is server-rendered for crawlers; further pages load from `/api/tracks` with limit/cursor pagination. Track rows open Spotify directly and use Spotify album artwork when available. The public RSS feed is available at `/rss.xml`; crawler surfaces are `/robots.txt`, `/sitemap.xml`, and `/llms.txt`.

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
bun run --cwd apps/web wrangler secret put DISCORD_WEBHOOK_URL
bun run --cwd apps/web wrangler secret put LOOPS_API_KEY
bun run --cwd apps/web wrangler secret put LOOPS_TRANSACTIONAL_ID
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

## Social Video

`packages/video` is a Remotion kit that composes per-track social videos for Fluncle's Finest: 1080×1920 vertical clips that put one banger under the burning eclipse, on-brand with DESIGN.md and VOICE.md. It is built as a kit for a future AI agent to assemble fresh scenes per track, with `NostalgicCosmos` as the exemplar composition.

Render a preview for a track locally:

```bash
bun run social:preview <track-id>
```

This fetches the track, resolves and analyzes a preview clip, extracts the artwork palette, and renders to `packages/video/out/<track-id>.mp4` (props land alongside as `out/<track-id>.props.json`). Add `--skip-render` to stop after the props JSON, `--composition <Id>` to render a registered composition other than the exemplar, or run `bun run --cwd packages/video studio` to scrub the composition live.

Rendering is local-only; publishing the resulting clips to any platform is out of scope. See [packages/video/README.md](./packages/video/README.md) for the primitives, hooks, inputProps contract, and the brand grammar, and [docs/video-agent.md](./docs/video-agent.md) for the per-track video agent's instructions.

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

## Submission Flow

Listeners can submit tracks from fluncle.com or with:

```bash
fluncle submit
fluncle submit "Camo & Crooked"
fluncle submit "https://open.spotify.com/track/..."
```

Both clients call `GET /api/search?q=...`, select a visible candidate, then post the selected track to `POST /api/submissions`. Submissions are stored as pending rows with hashed rate-limit keys; rejected rows are kept.

Operators review with:

```bash
fluncle admin submissions
fluncle admin submissions review <submission-id>
fluncle admin submissions reject <submission-id>
fluncle admin submissions approve <submission-id>
```

Approval fetches the submission, runs `fluncle admin add "<spotify-url>" --dry-run`, asks `Publish this submission? (Y/n)`, then runs the real admin add call only after confirmation and marks the submission approved.

## CLI Releases

Standalone CLI release binaries are built by `.github/workflows/cli-release.yml` when CLI changes are pushed to `main`. The first automated release uses `v0.1.0`; later CLI releases bump the minor version, for example `v0.2.0`, `v0.3.0`. The workflow uses Bun compile targets for macOS arm64/x64 and Linux arm64/x64, bakes the release version into the binary, creates the GitHub Release, and uploads the binaries as release assets. The hosted installer at `https://www.fluncle.com/cli/latest.sh` selects the right asset and installs it to `~/.local/bin/fluncle` by default.

The CLI reports its bundled version with `fluncle version`. `fluncle version --check` compares that version against the latest GitHub Release tag.
