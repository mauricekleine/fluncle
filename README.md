# Fluncle

> Drum & bass bangers from another dimension.

Fluncle discovers and certifies drum & bass bangers, logs each as a finding, and keeps the full archive across the Galaxy, with fluncle.com as home base.

## Public Surfaces

The same archive, reachable however you like. Every surface reads the same public API and shares the same Log IDs.

| Surface    | Where                                                    | What                                                                                                                   |
| ---------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Web        | <https://www.fluncle.com>                                | The public archive: cover-led, dark, fast. Also `/about`, `/log`, `/log/<id>`                                          |
| Galaxy     | <https://galaxy.fluncle.com>                             | The game: every finding is a star you can fly to                                                                       |
| Public API | `https://www.fluncle.com/api/v1/*`                       | JSON reads and submissions; `/api/*` stays as a permanent alias (see [Web](#web), [Submission Flow](#submission-flow)) |
| RSS        | <https://www.fluncle.com/rss.xml>                        | The 25 most recent findings, for feed readers                                                                          |
| CLI        | `curl -fsSL https://www.fluncle.com/cli/latest.sh \| sh` | The archive in your terminal (see [CLI](#cli))                                                                         |
| SSH        | `ssh rave.fluncle.com`                                   | The rave terminal, a Wish/Bubble Tea app (see [SSH](#ssh))                                                             |
| MCP        | `https://www.fluncle.com/mcp`                            | The archive as agent tools, Streamable HTTP, no auth (see [MCP](#mcp))                                                 |

Crawler and discovery surfaces (all under <https://www.fluncle.com>): `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` (the whole archive in one doc), `/openapi.json`, `/.well-known/api-catalog`, `/.well-known/agent-skills/index.json`, and `/.well-known/mcp/server-card.json`. Public pages also carry schema.org JSON-LD (`WebSite`, `MusicPlaylist`, `MusicGroup`, `FAQPage`, and per-finding `MusicRecording` with the Log ID).

## Monorepo Layout

```text
apps/cli         Bun/TypeScript CLI. Thin client for public reads and admin API calls.
apps/extension   Fluncle Lens, an MV3 Chrome extension. Linkifies fluncle:// coordinates on any page.
apps/raycast     Raycast extension. Thin client that shells out to the CLI.
apps/ssh         Go Wish/Bubble Tea SSH terminal behind ssh rave.fluncle.com. Thin client of the public API.
apps/web         TanStack Start public web app and server-side Fluncle API.
packages/tokens  Shared design tokens (colors, typography, radii, motion) from DESIGN.md.
packages/video   Remotion kit for per-track social videos (the Nostalgic Cosmos).
```

The deployed web app owns the Spotify, Telegram, Turso, and Loops secrets. Every API route is served canonically under `/api/v1/*`, with the bare `/api/*` path kept as a permanent back-compat alias (a shared handler mounted at both paths, not a redirect, so POST bodies survive). Public reads are served by `/api/v1/tracks` (with `since`/`until` discovery windows), `/api/v1/tracks/random`, and `/rss.xml`. Newsletter signups post to `/api/v1/newsletter`, which the web app relays to Loops. Admin mutations are served by authenticated `/api/v1/admin/*` routes. Raycast must keep calling `fluncle`.
Listener submissions are accepted through public `/api/v1/search` and `/api/v1/submissions` routes, then reviewed through authenticated admin submission routes. Approval still publishes only through the existing admin add flow. Optional web accounts are private overlays on the same Log ID spine: signed-in listeners can sync Galaxy lifetime progress, save findings, see their own submissions, export data, and delete the account without changing anonymous Fluncle.

## License

Project source code and documentation are licensed under the [Apache License 2.0](./LICENSE), with attribution notices in [NOTICE](./NOTICE).

The Fluncle name, logo, visual identity, social/profile artwork, generated media assets, track curation data, playlist identity, and other brand assets are not licensed for reuse except where explicitly stated.

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
- Web/API: Wrangler secrets in production, and a local `apps/web/.dev.vars` rendered from `apps/web/.dev.vars.tpl` with 1Password for local Worker previews.

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
bun run --cwd apps/cli fluncle admin track preview-archive <track-id-or-log-id> --file preview.mp3 --source deezer:isrc --mime audio/mpeg
bun run --cwd apps/cli fluncle admin backfill previews --dry-run
bun run --cwd apps/cli fluncle admin submissions
bun run --cwd apps/cli fluncle admin submissions review <submission-id>
bun run --cwd apps/cli fluncle admin submissions reject <submission-id>
bun run --cwd apps/cli fluncle admin submissions approve <submission-id>
bun run --cwd apps/cli fluncle admin auth spotify
bun run --cwd apps/cli fluncle --env local recent --json
```

Database migrations are web workspace commands:

```bash
bun run --cwd apps/web db:generate
bun run --cwd apps/web db:migrate
```

Local migration commands read Turso credentials from `apps/web/.dev.vars` through `apps/web/drizzle.config.ts`. Everyday local dev runs against a per-worktree local libSQL server (`turso dev`) seeded from a production snapshot, so `db:migrate` only ever touches your own worktree's data. See [docs/local-database.md](./docs/local-database.md) for the full picture (`dev`, `db:refresh-dev`, `db:pull-prod`, and the worktree flow).

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

Configuration is environment-driven: `FLUNCLE_SSH_HOST` and `FLUNCLE_SSH_PORT` (defaults `127.0.0.1:2222`), `FLUNCLE_API_URL` (defaults to production), `FLUNCLE_SSH_DATA_DIR` for generated host keys (defaults to `.local`, gitignored), and optional `FLUNCLE_GEOIP_DB` pointing at a MaxMind-compatible `.mmdb` for the connected-crew country codes (lookups render `VOID` without it).

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

The public app is dark-only and centered around the Fluncle cover art. The first page of tracks is server-rendered for crawlers; further pages load from `/api/v1/tracks` with limit/cursor pagination. Track rows open Spotify directly and use Spotify album artwork when available. Optional private accounts live at `/account` and use Better Auth email/password plus a username; email is auth/recovery only, while username is the private Galaxy identity. The public RSS feed is available at `/rss.xml`; crawler and agent surfaces are `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/openapi.json`, `/.well-known/api-catalog`, `/.well-known/agent-skills/index.json`, and `/.well-known/mcp/server-card.json`. These discovery surfaces and the markdown homepage are served ahead of the router in `apps/web/src/lib/server/agent-discovery.ts`.

Private account endpoints are intentionally separate from anonymous archive DTOs: `/api/v1/me` returns `{ ok: true, user: null }` when signed out and only `id`, `username`, `displayUsername`, `createdAt`, and feature flags when signed in. `/api/v1/me/csrf` issues the short-lived `x-fluncle-csrf` token required by cookie-authenticated private account mutations. `/api/v1/me/galaxy-progress`, `/api/v1/me/saved-findings`, `/api/v1/me/submissions`, `/api/v1/me/export`, and `/api/v1/me/delete` require a Better Auth session and use DB-backed rate limits. Account deletion revokes sessions, deletes Better Auth credentials plus private progress and saves, marks the user deleted, and unlinks signed-in submissions while keeping the submission rows as anonymized review history. Discord/Loops copies may have their own processor retention windows.

### Deploy Web To Cloudflare

The web app deploys as a Cloudflare Worker through Wrangler. Keep secrets out of `wrangler.jsonc`; set them as Worker secrets:

```bash
bun run --cwd apps/web wrangler login
bun run --cwd apps/web wrangler secret put FLUNCLE_API_TOKEN
bun run --cwd apps/web wrangler secret put BETTER_AUTH_SECRET
bun run --cwd apps/web wrangler secret put BETTER_AUTH_URL
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

For local Worker previews and local migration commands, render `apps/web/.dev.vars` from the committed `apps/web/.dev.vars.tpl` template. Local web secrets live in a Fluncle 1Password item with fields named exactly like the env vars; the item path is supplied by `FLUNCLE_1PASSWORD_ENV_ITEM` so the public template does not expose vault names. Set `FLUNCLE_1PASSWORD_ACCOUNT` and `FLUNCLE_1PASSWORD_ENV_ITEM` in your shell, keep the 1Password desktop app unlocked, then run `db:secrets`. Leave the `TURSO_DATABASE_URL` pair to `db:refresh-dev` — it seeds a local libSQL database from a production snapshot and points that pair at the local server. The snapshot is pulled by `db:pull-prod`, which reads production credentials from the `Turso Production Credentials` item in the Fluncle 1Password vault (so `op` must be unlocked); see [docs/local-database.md](./docs/local-database.md):

```bash
bun run --cwd apps/web db:secrets
bun run --cwd apps/web db:refresh-dev
bun run --cwd apps/web preview
```

Production keeps using the `fluncle` Turso database through Wrangler secrets. Deploys run through Cloudflare Workers Builds on push to `main`, and migrations apply as part of the deploy step: the Cloudflare **Deploy command** is `bun run --cwd apps/web deploy:cf`, which is the committed script `db:migrate && wrangler deploy`. Prod Turso credentials come from the Cloudflare build/deploy environment, so `db:migrate` runs against `fluncle`. To run a production migration by hand instead, use the `Turso - Production` item in the Fluncle 1Password vault through the `op` CLI, then run `db:migrate` deliberately.

To deploy manually from a checkout (builds locally, no migrate):

```bash
bun run --cwd apps/web deploy
```

After the first deploy, add `fluncle.com` in the Cloudflare Workers custom domains settings.

## MCP

The web Worker also serves a small, stateless [Model Context Protocol](https://modelcontextprotocol.io) server at `https://www.fluncle.com/mcp` (Streamable HTTP, no sessions, no auth): the same archive the public API exposes, handed to agents as tools. It is a thin layer over the internal functions the `/api` routes already use, so validation, the submission rate limit, and the submitter hash stay identical.

Tools: `get_recent_tracks`, `get_random_track`, `search_tracks`, `submit_track`, `subscribe_newsletter`.

The MCP Server Card (SEP-2127) for agent discovery is at `/.well-known/mcp/server-card.json`. The endpoint is intercepted ahead of the router in `apps/web/src/server.ts`; the server lives in `apps/web/src/lib/server/mcp.ts`. The browser-side WebMCP surface (`apps/web/src/lib/webmcp.ts`) mirrors the same tools for agent-driving browsers; keep the two in step.

Point any MCP client at the endpoint, for example:

```json
{
  "mcpServers": {
    "fluncle": { "type": "http", "url": "https://www.fluncle.com/mcp" }
  }
}
```

## Social Video

`packages/video` is a Remotion kit that composes per-track social videos for Fluncle's Findings: 1080×1920 vertical clips that put one banger under the burning eclipse, on-brand with DESIGN.md and VOICE.md. It is built as a kit for a future AI agent to assemble fresh scenes per track, with `NostalgicCosmos` as the exemplar composition.

Render a preview for a track locally:

```bash
bun run social:preview <track-id>
```

This fetches the track, resolves and analyzes a preview clip, extracts the artwork palette, and renders to `packages/video/out/<track-id>.mp4` (props land alongside as `out/<track-id>.props.json`). Add `--skip-render` to stop after the props JSON, `--composition <Id>` to render a registered composition other than the exemplar, or run `bun run --cwd packages/video studio` to scrub the composition live.

Rendering is local-only; publishing the resulting clips to any platform is out of scope. See [packages/video/README.md](./packages/video/README.md) for the machinery, the archive contract, and the pipeline; the creative doctrine lives in the [fluncle-video skill](./packages/skills/fluncle-video).

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

`fluncle admin add` calls `POST /api/v1/admin/tracks` with `Authorization: Bearer <FLUNCLE_API_TOKEN>`. The server checks Turso for duplicates by case-sensitive Spotify track id. It inserts a pending row first, then adds the track to Spotify, then posts to Telegram. Each external operation is retried three times.

If Spotify fails, Telegram is not posted. If Spotify succeeds but Telegram fails, the database row is kept with `posted_to_telegram = false` for later inspection or recovery.

## Submission Flow

Listeners can submit tracks from fluncle.com or with:

```bash
fluncle submit
fluncle submit "Camo & Crooked"
fluncle submit "https://open.spotify.com/track/..."
```

Both clients call `GET /api/v1/search?q=...`, select a visible candidate, then post the selected track to `POST /api/v1/submissions`. Submissions are stored as pending rows with hashed rate-limit keys; rejected rows are kept. Web, CLI, and SSH submissions remain anonymous-compatible; when a browser carries a valid private Better Auth session, the Worker attaches `user_id` server-side so the account can show its own submission history.

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

The CLI also surfaces a passive update hint: after a command finishes it checks (at most once every 24h, cached in `~/.config/fluncle/update-check.json`) whether the published `fluncle` npm version is newer and, if so, prints a one-line update notice to stderr with an install-method-appropriate command (`npm i -g fluncle@latest`, `brew upgrade fluncle`, or the curl installer / GitHub release for the standalone binary). The check is fire-and-forget — it never changes a command's output, exit code, or behavior, and is silent for `--json`, piped/non-TTY output, and CI. Set `FLUNCLE_NO_UPDATE_NOTIFIER=1` to opt out.
