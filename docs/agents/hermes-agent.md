# Hermes box (the sweep runtime)

The long-lived runtime every Fluncle automation sweep runs in: a container built from the pinned [Nous Research Hermes](https://hermes-agent.nousresearch.com) image, named `hermes`, whose main process (`gateway run`) carries no chat platform and no model. It exists so the host systemd timers have somewhere to `docker exec` into; each sweep acts on the archive **only** through the authenticated `fluncle` CLI and the agent-scoped token.

> This repo is public. Host names, IPs, and secret values are **not** in this doc — they live in the operator's ops notes + 1Password. This doc is the architecture, the security policy, and the change/runbook procedures.

## The one idea

The Hermes box is a long-running container whose sweeps wield the `fluncle` CLI while holding an admin token. The security question is "what can the box do with that token, and what stops it." The answer is that **the token itself is scoped**: the box holds a lower-privilege `agent`-role token, and the Worker refuses every publish-/irreversible-class action for that role **server-side** — regardless of what the box does with the token. The trust boundary lives at the Worker, not on the box.

**Server-side roles are the boundary** — what the token may _do_, enforced at the API. The box's token authenticates as the `agent` role; publish-/irreversible-class routes accept only the `operator` (the human's full token or browser session). A fully-compromised root box still cannot publish, because the credential it holds lacks the authority. Defined in `apps/web/src/lib/server/env.ts` (`adminRole` / `requireOperator`); the operator/agent split is detailed under [Roles](#roles-operator-vs-agent).

There is deliberately **no local command gate**: the box's `fluncle` CLI runs ungated for the sweeps, and an agent-role attempt at a publish command comes back a 403. A box-side wrapper would only duplicate the server policy (two allow-lists to keep in sync) while protecting nothing the scoped token doesn't already. The box being private and Tailscale-only (no public inbound TCP) shrinks the network surface; the scoped token is what defangs a token leak or a prompt injection.

## Roles (operator vs agent)

One admin surface, two roles — the privilege is the role, not the carrier:

- **`operator`** — the human. Carried by the browser grant cookie (Login with Spotify) **or** the full `FLUNCLE_API_TOKEN` Bearer (the operator's own CLI/laptop). Can do everything.
- **`agent`** — the Hermes box's sweeps. Carried by `FLUNCLE_AGENT_TOKEN`. Bounded to the **reversible/internal** surface; everything that publishes, can't be undone, or is editorial/identity/auth is refused (403).

The dividing line: _could a stranger see the result, or could it not be taken back?_ → operator. _Internal and reversible?_ → agent.

| Surface                                                                                                                           | Role     | Why                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| All public reads + admin reads (`queue`, `enrich --queue`, `vehicles`, `mixtapes list/get`, `submissions review`, `track social`) | agent    | No effect                                                              |
| `track update` — analysis only (`--status/--bpm/--key/--features`)                                                                | agent    | Machine-measured, internal, overwritable; the enrich cron's write-back |
| `track draft` — TikTok/default                                                                                                    | agent    | `SELF_ONLY` inbox draft; a human still posts it                        |
| `tracks publish` (Spotify playlist + Telegram)                                                                                    | operator | Public, irreversible                                                   |
| `track draft --platform youtube`                                                                                                  | operator | Direct public upload                                                   |
| `track update` — `--note/--video-url` (+ identity `isrc/logId`)                                                                   | operator | Editorial voice + identity — Fluncle's judgment                        |
| `track video` / `preview` / `observe`                                                                                             | operator | Durable artifacts                                                      |
| `newsletter draft/update/list`                                                                                                    | agent    | Drafts a reversible edition row + reads it back; the cron authors it   |
| `newsletter send`                                                                                                                 | operator | Publish-class: sends the Resend broadcast to the real list             |
| `recordings promote`, `mixtapes update/distribute/resync`                                                                         | operator | Publishes or mutates the spine; minting uses `promote`.                |
| `submissions approve/reject`                                                                                                      | operator | Editorial decision; approve can publish                                |
| `auth *`, `backfill *`                                                                                                            | operator | Credentials / bulk mutation                                            |

**Box-supplied evidence is agent-tier input, not agent-tier authority.** Several vendors — Deezer, Discogs, and MusicBrainz for the catalogue crawl — rate-limit or block per SOURCE IP, and a Cloudflare Worker's egress address is shared with strangers. So the box makes those vendor calls from its own address and hands the response to the Worker, which verifies and writes. The pattern holds the same line in every case: the box supplies bytes, never a verdict. The Worker pins what may be asked for (the crawl's prepare issues the exact MusicBrainz url a claim allows, host pinned), parses a supplied body with the same parser its own fetch feeds, and applies the same gate — the anchor's match gate, the crawl's label rulings and artist rules — before anything is stored. See [docs/catalogue-crawler.md](../catalogue-crawler.md) for the crawl's version and the residual risk it accepts.

Enforcement is at the route: agent-allowed routes call `requireAdmin` (any principal); publish-/irreversible-class routes call `requireOperator` (403s the agent). The two conditional commands (`track update`, `track draft`) authenticate with `requireAdmin`, then branch on `adminRole` to reject an operator-only field/platform. The CLI on the box runs ungated — an agent-role attempt at an operator route is refused server-side with a 403.

## Where it runs

A private, Tailscale-only devbox (admin over OpenSSH on the tailnet; no public inbound TCP). Docker only — deliberately no general dev tooling, for a small blast radius. The container runs a pinned Docker image; state lives in `~/.hermes` (`/opt/data` in the container): `.env`, `config.yaml`, `sessions/`, `memories/`, `skills/`, `logs/`.

## The image

Built from the pinned upstream gateway plus the `fluncle` CLI and the Claude Code CLI (both installed ungated; the Worker is the boundary). Build context: the **repo root** (the `copywriting-fluncle` skill is `COPY`d in, so the context must include `packages/skills/`); Dockerfile at [`docs/agents/hermes/Dockerfile`](./hermes/Dockerfile).

- **The image carries `ffmpeg` + `bun`** so the box can run the audio-analysis enrichment on-box — the lever for the `fluncle-enrich` `--no-agent` cron (it decodes the preview with `ffmpeg` and runs the `analyze-track` DSP with `bun`, no Worker round-trip).
- **The image carries the `claude` (Claude Code) CLI + the whole `packages/skills` set** so every box `claude -p` survives a rebuild: the `fluncle-observation`/`note`/`newsletter` voice crons load `copywriting-fluncle`, and the nightly audit + reviewer agents lean on the operator skills (`fluncle-hermes-operator`, `fluncle-surfaces`, `fluncle-audit-operator`, `fluncle-maintenance`, `taste`, …). The skills are baked at `/opt/claude/skills/<name>` with `CLAUDE_CONFIG_DIR=/opt/claude` (a world-readable config dir), so the non-root cron user finds them without depending on its HOME; the whole tree is ~1 MB, so baking all of it is drift-proof (a new skill needs no Dockerfile change, and no per-run `skills:install`). `claude -p` authenticates from `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth, **not** OpenRouter), injected at run via the secret env-file (§ Secrets) — never baked.
- **The image carries the boat.dev CLI (`boat`) + `openssh-client`** for the `fluncle-render` conductor cron — the box carries no Remotion toolchain, so this cron wakes a separate scale-to-zero boat.dev render box (software GL, no GPU), renders one finding there via a remote `claude -p`, and parks it (`boat ssh`/`scp` shell out to system ssh). `boat` is copied to `/usr/local/bin` (world-traversable, like bun); auth is **not** baked — `BOAT_API_KEY` arrives at run, file-sourced like the claude token (§ Crons, the render conductor); the pre-rename name `BOX_API_KEY` is still accepted. The binary is a checksum-verified release pin rather than a floating install, and every conductor call passes `--no-update` so the pin holds.
- **Pin the upstream** (Hermes is pre-1.0; `latest` can change the gateway's startup and the `--no-agent` runner under you). The base is pinned by its **immutable digest** (`FROM nousresearch/hermes-agent@sha256:…` — the Dockerfile's `FROM` line, with the matching version tag in the comment above it, is the source of truth). Read the current base version and digest from the Dockerfile. The `fluncle` CLI is the **standalone bun-compiled binary** pinned by its `releases/download/v<ver>/fluncle-linux-<arch>` URL, not the `npm -g` thin client (the clip-cut + media-upload commands need the Bun runtime the binary embeds); Claude Code (`@anthropic-ai/claude-code@<ver>`) is pinned the same way. The fluncle + Claude Code pins are auto-bumped (`pin-watch` + `hermes-pin-drift` parse the binary release URL, not an `fluncle@` npm spec), so read the current versions off the Dockerfile, never off this doc; the base image stays a manual, deliberate bump at its line.
- **Review the upstream pin monthly** and bump deliberately (pinning forever = no security patches for a wide Chromium/ffmpeg/Node/Python surface).

```bash
# on the devbox, from the REPO ROOT (the skill COPY needs packages/skills/ in context)
docker build -f docs/agents/hermes/Dockerfile -t fluncle-hermes:v2026.7.7.2 .
```

## Changing what the agent may do

The allow-list lives in one place — the Worker. To move a command across the operator/agent line, change its route guard in `apps/web/src/lib/server/env.ts` consumers: `requireOperator` for operator-only, `requireAdmin` for agent-allowed, or an `adminRole` branch for a field/platform-level split (see the [Roles](#roles-operator-vs-agent) table). It goes through git review and ships with the next Worker deploy; no box rebuild, no second list to keep in sync.

## Secrets

The Worker owns every platform secret (R2, Postiz, Turso, YouTube, Mixcloud, Last.fm, Telegram); the box holds **only** its agent-scoped admin token, the ops-alert webhook, and the sweep credentials. Nothing secret lives in this repo or baked into the image.

- Secrets are pulled from 1Password via the `op` CLI (exact paths + item names in the ops runbook note). The container's **root-owned** secret env-file, mounted with `--env-file` at run, carries only the **agent-scoped** admin bearer (`FLUNCLE_API_TOKEN`) and `DISCORD_ALERT_WEBHOOK` (alerts post through the webhook). The sweep credentials — `CLAUDE_CODE_OAUTH_TOKEN` (the Claude Code subscription token every box `claude -p` authoring step authenticates with) and the other per-sweep keys — live in the shared `0600` sweep secrets file each sweep sources, because the `--no-agent` runner withholds recognized provider credentials from a script's env. The `claude` binary + the skills are baked into the image (§ The image); the tokens arrive at run — never baked.
- The `op` service-account token is the one bootstrap secret — it can't come _from_ 1Password, so it sits in a separate root-only file used only by the secret-population step, kept **out** of the container env.
- **The box never holds the operator token.** The CLI reads `FLUNCLE_API_TOKEN`; on the box that env var holds the value of the **agent-scoped** token (stored in 1Password as `FLUNCLE_AGENT_TOKEN`). The CLI sends it as its Bearer, the Worker recognizes it as the `agent` role, and publish-class actions are refused server-side. The operator's own laptop keeps the full `FLUNCLE_API_TOKEN` (the `operator` role). Both are intentionally **separate** from the admin-cookie signing key (`ADMIN_SESSION_SECRET`, a Worker-only secret), so a box compromise costs only the agent surface and **cannot forge web-admin sessions**.
- Provisioning and rotating the agent token is a generate → `wrangler secret put FLUNCLE_AGENT_TOKEN` (Worker) → store in 1Password → re-populate the secret env-file (its `FLUNCLE_API_TOKEN` = the agent value) → restart loop; the full operator `FLUNCLE_API_TOKEN` rotates independently the same way. The exact recipe (key generation, the env-file path, the restart) is in the ops runbook note.

## Run

`<secret-env-file>` below is the root-owned `op`-populated env-file (§ Secrets); its exact path is in the ops runbook note.

```bash
docker run -d --name hermes --restart unless-stopped \
  --security-opt no-new-privileges --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add KILL --cap-add SETGID --cap-add SETUID \
  --cpus=3 --memory=6g --memory-swap=6g --shm-size=1g \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  -v ~/.hermes:/opt/data \
  --env-file <secret-env-file> \
  fluncle-hermes:v2026.7.7.2 gateway run
```

- **The resource ceiling is `--cpus=3 --memory=6g`, and `--memory-swap` always equals `--memory`** (the host has no swap, so they must match or the cgroup gets unbounded swap it cannot use). A tighter cap throttles CPU periods and OOM-kills the agent while the host sits idle. The same ceiling is the default in [`pin-watch/rebuild-hermes.sh`](./hermes/pin-watch/rebuild-hermes.sh) (`PINWATCH_CPUS` / `PINWATCH_MEMORY_GIB`), which is the only other place a live container is created — and a rebake keeps a HIGHER live ceiling if the operator raised one by hand with `docker update`, so a manual raise is never undone. Change both together.
- **Never mount the Docker socket** — it would hand the agent host root and moot every file-permission control. No in-scope job needs it.
- The capability allow-list is for the inherited s6 entrypoint only: it repairs `/opt/data` ownership, drops the main program to `hermes`, and supervises that process. The gateway needs no network, mount, setcap, or raw-socket capability.
- The container publishes **no** ports. If the Hermes API (`8642`) or dashboard (`9119`) is ever needed, bind to `127.0.0.1`/`tailscale0` only.
- Disable Tailscale node-key expiry on the box (no public fallback → an expired key is a total lockout).

## Self-deploy (the pin-watch timer)

The box keeps its baked CLI pins current **on its own**. `pin-watch` is a host systemd timer because a container cannot rebuild and replace itself cleanly. It hourly compares the `fluncle` + Claude Code pins in this Dockerfile on `main` against the running container's versions; on drift it rebuilds the image, **pre-smokes** it (versions + an agent read + the publish-class role boundary) in throwaway containers BEFORE touching the live one, swaps, post-smokes, and **auto-rolls-back** on any failure — credential-free (the repo is public; secrets are reused from the running container's own env, nothing read from `op`), Discord-alerting on a deploy or rollback, and reporting a `self-deploy` health row to [`/status`](https://www.fluncle.com/status) so the self-maintenance loop is publicly visible. This is the deploy half of the version-currency loop: the [`fluncle-maintenance`](../../packages/skills/fluncle-maintenance) sweep — the `.github/workflows/hermes-pin-drift.yml` GitHub Actions workflow — opens (and on green, merges) a clearly-safe pin bump, and the box self-deploys it. The base image (`FROM`) is **not** watched — a base bump stays a manual operator brake. Runbook + the rollback rail: [`hermes/pin-watch/`](./hermes/pin-watch/).

## Crons (automation)

Hermes is also Fluncle's queue-driven automation orchestrator: scheduled, trusted, no-untrusted-input loops over the `fluncle` CLI. They are versioned at [`docs/agents/hermes/cron/`](./hermes/cron/) (the mechanism `README.md`) with a `.timer`/`.service` pair per cron under [`docs/agents/hermes/<job>-timer/`](./hermes/).

**Deploy model — the schedule is code.** Every automation schedule is a repo-managed host systemd timer/service pair. The sweep code bakes into the image at `/opt/hermes-scripts` and the enrichment DSP skill at `/opt/hermes-skills` — read straight from the baked path, so `/opt/data` never holds a script (no `docker cp`, no volume projection); they auto-update from `main` via the hourly `pin-watch` rebuild. Each `<job>-timer/`'s `ExecStart` is `docker exec -u hermes … bash /opt/hermes-scripts/<sweep>.sh`; the operator installs them all with [`hermes/install-host-timers.sh`](./hermes/install-host-timers.sh). The gateway runs no jobs and no chat platform; it only keeps the container alive.

**The reset boundary.** A bare re-provision restores three layers: **code** (baked into the image, rebuilt from `main`), **schedule** (the host-timer units, laid down by `install-host-timers.sh` from the repo checkout), and **secrets** (re-injected from 1Password by `fluncle-secrets-sync`). The layers themselves are repo-derived, which is what makes them restorable at all.

The nightly backup stores the production database separately from the encrypted box-state archive. The box-state leg covers the gateway database, memories, run history, render-conductor state, and selected env files; it excludes bootstrap material, audit workspaces, and model caches. Use the restore skill for recovery.

Because a host-timer `docker exec` sends stdout to journald (not the gateway runner's `~/.hermes/cron/output/<job>/` files the `/status` prober reads), each sweep SELF-WRITES that freshness marker via the shared [`cron-output.sh`](./hermes/scripts/cron-output.sh) helper, so the prober stays honest and unchanged.

- Host timers run in parallel. Each automation job is a `Type=oneshot` service triggered by a persistent timer and runs its baked script as the unprivileged `hermes` user.
- **The pure-trigger `--no-agent` sweeps (`fluncle-enrich`, `fluncle-backfill`, `fluncle-context-note`) — pure compute/trigger, zero LLM tokens on the box.** `fluncle-enrich` (LIVE, every 5 min) drains the enrich worklist (`fluncle admin tracks enrich --queue`), analyzes each finding on-box (`ffmpeg` + `bun`), and writes the result back via `fluncle admin tracks update`. `fluncle-backfill` (every 30 min) paces the Worker-side Discogs/Last.fm backfills. `fluncle-context-note` (every 60 min) drains the no-context queue (`fluncle admin tracks context --queue`, `hasContext=false`) and triggers `context_track` per finding — the **Worker** runs the Firecrawl search + the Haiku note-distill + the quiet `context_note` write, so the box only triggers. All three run **without** the agent brain (`--no-agent`), so they carry no untrusted-input surface; each runs from a repo-checked-in host systemd timer ([`enrich-timer/`](./hermes/enrich-timer/), [`backfill-timer/`](./hermes/backfill-timer/), [`context-note-timer/`](./hermes/context-note-timer/)), not a gateway cron.
- **`fluncle-observation` — the HYBRID `--no-agent` sweep (every 60 min, idempotent queue drain).** It is a deterministic queue/gather/deliver wrapper around one `claude -p` authoring call. It drains the observe worklist (`fluncle admin tracks observe --queue`, `hasContext=true AND hasObservation=false`), reads each finding's metadata (`fluncle tracks get`), then runs `claude -p --allowedTools "Read,Glob,Grep"` (Claude Code on **subscription** auth via `CLAUDE_CODE_OAUTH_TOKEN` — NOT OpenRouter — with the `copywriting-fluncle` skill, read-only tools) to author the recovered-audio script. The **script** posts it via `fluncle admin tracks observe --script-file`; the Worker voice-gates + renders + stores. Cap 1/tick (paid renders + a generous per-job timeout). The authoring step has no untrusted-input surface (read-only tools, a self-contained prompt) and the delivery stays under the agent ceiling — reversible, internal, no public footprint. Source: `hermes/scripts/observe-sweep.{sh,ts}`; runs from the [`observation-timer/`](./hermes/observation-timer/) host timer. Pre-reqs: the `claude` CLI + `CLAUDE_CODE_OAUTH_TOKEN` + the `copywriting-fluncle` skill baked at `/opt/claude/skills/copywriting-fluncle` (`CLAUDE_CONFIG_DIR=/opt/claude`).
- **`fluncle-render` — the video render CONDUCTOR (`--no-agent`).** Unlike the on-box sweeps, the Hermes box carries no Remotion toolchain: this cron wakes a separate **scale-to-zero boat.dev render box** (the render box — software GL on CPU, no GPU; host map in the ops runbook note), triggers one queued finding's `@fluncle-video` render _there_ via a remote `claude -p`, and parks the box when it finishes. Each tick is quick (<120s — the runner's kill limit) and drives a **detached ~85-min render** through a two-state machine (single-flight by state + an atomic `mkdir` lock; the box renders + **ships to R2/the website, never to social** — the prompt's hard rail AND the operator-tier publish gate both block it). Pre-reqs: the boat.dev CLI baked (§ The image) + `BOAT_API_KEY` + `CLAUDE_CODE_OAUTH_TOKEN` file-sourced from the shared `0600` `~/.fluncle-secrets.env` (op-injected by `fluncle-secrets-sync`, like every other sweep). Source: `hermes/scripts/render-conductor.sh` + `provision-rave-03.sh` + `render-detached.sh`; the full pipeline doctrine is [`docs/agents/render-conductor.md`](./render-conductor.md), the wiring summary [`hermes/cron/README.md`](./hermes/cron/README.md) § the render conductor.
- **`fluncle-newsletter` — the weekly HYBRID `--no-agent` sweep.** Friday 15:00 Amsterdam (the timer's `OnCalendar` carries the `Europe/Amsterdam` zone, so the slot follows CET/CEST): read the discovery window, author the edition with **one** `claude -p` call (subscription auth + `copywriting-fluncle`, zero OpenRouter), **persist a draft** via `fluncle admin newsletter draft` (`create_edition`, agent tier), then post a one-line summary + the `fluncle admin newsletter send <id>` command to the ops-alert Discord webhook. The **send stays operator-only**: the agent token gets a 403 on `send_edition`, so the sweep persists-then-offers and the operator runs the send command (which fires the Worker-side Resend Broadcast + mints the number). `RESEND_*` stays a **Worker secret** — the box never holds it. Source: `hermes/scripts/newsletter-sweep.{sh,ts}`. See [`hermes/cron/README.md`](./hermes/cron/README.md) and the authoring doctrine in [`newsletter-agent.md`](./newsletter-agent.md).
- **The remaining `--no-agent` sweeps** — `fluncle-note` (hybrid, every 10 min — the auto-note), `fluncle-social-capture` (every 10 min — captures the YouTube/TikTok post URLs Postiz withholds on create), `fluncle-publish-advance` (every 30 min — the render → publish auto-advance; **ships DARK behind a default-deny kill switch**, so the tick posts nothing until the operator resumes it), and `fluncle-studio-clip` (every 15 minutes — cuts a mixtape set into framed 9:16 clips → R2). The canonical roster comes from the timer directories, `cron.*` registry entries, and `systemctl list-timers 'fluncle-*'`.
- All automation uses host systemd timers. `fluncle-healthcheck` writes its `/status` row directly because it is the prober.
- **Every box `claude -p` invocation sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.** Headless mode terminates backgrounded Bash tasks after the final result. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and run each job in one foreground call.

## Account posture

The box agent token is ONE shared Claude Max subscription credential used by all box `claude -p` work (the note/observe/newsletter authoring calls and the render box's render), authenticated as `CLAUDE_CODE_OAUTH_TOKEN` — subscription auth, not the API org-tier billing (the published RPM / token-per-minute tables for API org tiers do not apply to subscription OAuth). The render is the dominant consumer: a healthy render measures ~76–98 Opus requests over 22–54 min (peak 8–10 req/min, ~15–22M cache-read tokens).

Use one Anthropic subscription credential for box work. Distribute scheduled calls and avoid concurrent credential use during a live render.

## Verify (smoke test)

```bash
# CLI present
docker run --rm --entrypoint fluncle fluncle-hermes:v2026.7.7.2 version            # -> fluncle <ver>
# agent-allowed read with the agent token + live API (expect {"ok":true,...})
docker run --rm --env-file <secret-env-file> --entrypoint fluncle \
  fluncle-hermes:v2026.7.7.2 admin tracks enrich --queue --json --limit 1
# the server boundary: a publish-class command with the agent token is refused
# (expect a 403 "forbidden" — the operator role is required, not an execution)
docker run --rm --env-file <secret-env-file> --entrypoint fluncle \
  fluncle-hermes:v2026.7.7.2 admin tracks publish <url>
```

## Security posture & limits

- The boundary is the **server-side role**: the box holds only the `agent`-scoped token, and publish-/irreversible-class actions are refused at the Worker for that role. The private no-public-TCP box shrinks the network surface.
- An injected `fluncle admin tracks publish …` (say, from a `claude -p` authoring step steered by fetched content) is refused by the Worker no matter how it is dispatched (the CLI, raw `curl` with the printenv'd token), because the token is `agent`-scoped. There is no local wrapper to bypass; there is nothing the token can do that the server allows.
- **Residual surface:** the sweeps' scoped token. A fully-compromised root box is bounded to the agent role — reads (incl. `enrich-queue`), analysis write-back (`track update`), a TikTok inbox draft. All reversible/internal, none public without the operator; all publish-class is blocked for everyone but the operator.
- The scoped credential remains the publish boundary. Every host-timer sweep already enters the container as `hermes`; the remaining root surface is the gateway container's s6 bootstrap, now bounded by `no-new-privileges` and a minimal capability allow-list. Removing that bootstrap privilege with `USER hermes` is a later attended change: stop the container, run `chown -R 10000:10000` over the `/opt/data` host directory, then start and verify the new image before restoring unattended self-deploys.
- Back up `~/.hermes` as an encrypted/snapshot copy only (it holds the gateway state, memories, and cron markers) — never a plaintext off-box tarball.

## Status

Live: pinned image with the `fluncle` CLI (ungated; the Worker is the boundary); the container env via `op` → the root-owned secret env-file, carrying only the agent-scoped token and the ops-alert webhook; no chat platform and no model — `gateway run` only keeps the container alive for the host timers. The publish boundary is server-side: the Worker rejects publish- and irreversible-class actions made with the box's agent-scoped token. The long-lived container has `no-new-privileges` plus a minimal s6 bootstrap capability allow-list; the attended `USER hermes` cutover remains tracked in [ROADMAP.md](../planning/ROADMAP.md). The host-timer roster includes the pure sweeps, the hybrid note/observation/newsletter sweeps, and the render conductor. The gateway contains no automation jobs. The `/status` prober (`fluncle-healthcheck`) and the image self-deploy (`pin-watch`) run from host systemd timers, not the gateway.
