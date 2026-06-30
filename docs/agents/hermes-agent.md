# Hermes agent (chat presence)

Fluncle's chat-facing agent: a self-hosted [Nous Research Hermes](https://hermes-agent.nousresearch.com) gateway that fronts chat platforms (Discord first) and acts on the archive **only** through the authenticated `fluncle` CLI. It is the operator's console-in-chat — read the archive freely, propose admin actions behind a human gate.

> This repo is public. Host names, IPs, and secret values are **not** in this doc — they live in the operator's ops notes + 1Password. This doc is the architecture, the security policy, and the change/runbook procedures.

## The one idea

Hermes is a long-running box that wields the `fluncle` CLI while holding an admin token. The security question is "what can the agent do with that token, and what stops it." The answer is that **the token itself is scoped**: the box holds a lower-privilege `agent`-role token, and the Worker refuses every publish-/irreversible-class action for that role **server-side** — regardless of what the box does with the token. The trust boundary lives at the Worker, not on the box.

Two controls, outermost (most authoritative) first:

1. **Server-side roles** (the boundary) — what the token may _do_, enforced at the API. The agent's token authenticates as the `agent` role; publish-/irreversible-class routes accept only the `operator` (the human's full token or browser session). A fully-compromised root agent still cannot publish, because the credential it holds lacks the authority. Defined in `apps/web/src/lib/server/env.ts` (`adminRole` / `requireOperator`); the operator/agent split is detailed under [Roles](#roles-operator-vs-agent).
2. **The allow-list** — _who_ may talk to the agent (deny-by-default; tight). Bounds exposure and cost, not authority.

There is deliberately **no local command gate**: the CLI runs ungated on the box, and an agent-role attempt at a publish command comes back a 403 the agent relays in voice. A box-side wrapper would only duplicate the server policy (two allow-lists to keep in sync) while protecting nothing the scoped token doesn't already. The box being private and Tailscale-only (no public inbound TCP) shrinks the network surface; the scoped token is what defangs a token leak or a prompt injection.

## Roles (operator vs agent)

One admin surface, two roles — the privilege is the role, not the carrier:

- **`operator`** — the human. Carried by the browser grant cookie (Login with Spotify) **or** the full `FLUNCLE_API_TOKEN` Bearer (the operator's own CLI/laptop). Can do everything.
- **`agent`** — Hermes and the Discord allow-list. Carried by `FLUNCLE_AGENT_TOKEN`. Bounded to the **reversible/internal** surface; everything that publishes, can't be undone, or is editorial/identity/auth is refused (403).

The dividing line: _could a stranger see the result, or could it not be taken back?_ → operator. _Internal and reversible?_ → agent.

| Surface                                                                                                                           | Role     | Why                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| All public reads + admin reads (`queue`, `enrich --queue`, `vehicles`, `mixtapes list/get`, `submissions review`, `track social`) | agent    | No effect                                                              |
| `track update` — analysis only (`--status/--bpm/--key/--features`)                                                                | agent    | Machine-measured, internal, overwritable; the enrich cron's write-back |
| `track draft` — TikTok/default                                                                                                    | agent    | `SELF_ONLY` inbox draft; a human still posts it                        |
| `add` (Spotify playlist + Telegram)                                                                                               | operator | Public, irreversible                                                   |
| `track draft --platform youtube`                                                                                                  | operator | Direct public upload                                                   |
| `track update` — `--note/--video-url/--vibe-x/y` (+ identity `isrc/logId`)                                                        | operator | Editorial voice + map placement — Fluncle's judgment                   |
| `track video` / `preview` / `observe`                                                                                             | operator | Durable artifacts                                                      |
| `newsletter draft/update/list`                                                                                                    | agent    | Drafts a reversible edition row + reads it back; the cron authors it   |
| `newsletter send`                                                                                                                 | operator | Publish-class: sends the Resend broadcast to the real list             |
| `mixtapes publish/distribute/delete/create/update/members`                                                                        | operator | Publishes/mutates the spine                                            |
| `submissions approve/reject`                                                                                                      | operator | Editorial decision; approve can publish                                |
| `auth *`, `backfill *`                                                                                                            | operator | Credentials / bulk mutation                                            |

Enforcement is at the route: agent-allowed routes call `requireAdmin` (any principal); publish-/irreversible-class routes call `requireOperator` (403s the agent). The two conditional commands (`track update`, `track draft`) authenticate with `requireAdmin`, then branch on `adminRole` to reject an operator-only field/platform. The CLI on the box runs ungated — an agent-role attempt at an operator route is refused server-side, and the agent relays the 403 in voice (see `SOUL.md`).

## Where it runs

A private, Tailscale-only devbox (admin over OpenSSH on the tailnet; no public inbound TCP). Docker only — deliberately no general dev tooling, for a small blast radius. The gateway runs as a pinned Docker image; state lives in `~/.hermes` (`/opt/data` in the container): `.env`, `config.yaml`, `sessions/`, `memories/`, `skills/`, `logs/`.

## The image

Built from the pinned upstream gateway plus the `fluncle` CLI and the Claude Code CLI (both installed ungated; the Worker is the boundary). Build context: the **repo root** (the `copywriting-fluncle` skill is `COPY`d in, so the context must include `packages/skills/`); Dockerfile at [`docs/agents/hermes/Dockerfile`](./hermes/Dockerfile).

- **The image carries `ffmpeg` + `bun`** so the box can run the audio-analysis enrichment on-box — the lever for the `fluncle-enrich` `--no-agent` cron (it decodes the preview with `ffmpeg` and runs the `analyze-track` DSP with `bun`, no Worker round-trip).
- **The image carries the `claude` (Claude Code) CLI + the `copywriting-fluncle` skill** so the `fluncle-observation` `--no-agent` cron's one agentic step (`claude -p` authoring the recovered-audio script in voice) survives a rebuild. The skill is baked at `/opt/claude/skills/copywriting-fluncle` with `CLAUDE_CONFIG_DIR=/opt/claude` (a world-readable config dir), so the non-root cron user finds it without depending on its HOME. `claude -p` authenticates from `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth, **not** OpenRouter), injected at run via the secret env-file (§ Secrets) — never baked.
- **The image carries the box.ascii CLI (`box`) + `openssh-client`** for the `fluncle-render` conductor cron — the box has no GPU/Remotion, so this cron wakes a separate scale-to-zero box.ascii render box, renders one finding there via a remote `claude -p`, and parks it (`box ssh`/`scp` shell out to system ssh). `box` is copied to `/usr/local/bin` (world-traversable, like bun); auth is **not** baked — `BOX_API_KEY` arrives at run, file-sourced like the claude token (§ Crons, the render conductor). box.ascii is pre-1.0 with no installer version pin, so it is the one image dependency that tracks a channel rather than a fixed tag.
- **Pin the upstream tag** (Hermes is pre-1.0; `latest` can change message handling and the model-context startup check under you). Current pin: `nousresearch/hermes-agent:v2026.6.19`. The `fluncle` CLI is the **standalone bun-compiled binary** pinned by its `releases/download/v<ver>/fluncle-linux-<arch>` URL (currently **v0.71.0**), not the `npm -g` thin client (the clip-cut + media-upload commands need the Bun runtime the binary embeds); Claude Code (`@anthropic-ai/claude-code@2.1.196`) is pinned the same way. Bump each deliberately at its line in the Dockerfile — `fluncle-pin-watch` + `hermes-pin-drift` parse the binary release URL, not an `fluncle@` npm spec.
- **Pin the model** at ≥64k context. A model below the floor takes the _whole gateway_ down at startup (upstream issue #24140), not just one feature.
- **Review the upstream pin monthly** and bump deliberately (pinning forever = no security patches for a wide Chromium/ffmpeg/Node/Python surface).

```bash
# on the devbox, from the REPO ROOT (the skill COPY needs packages/skills/ in context)
docker build -f docs/agents/hermes/Dockerfile -t fluncle-hermes:v2026.6.19 .
```

## Changing what the agent may do

The allow-list lives in one place — the Worker. To move a command across the operator/agent line, change its route guard in `apps/web/src/lib/server/env.ts` consumers: `requireOperator` for operator-only, `requireAdmin` for agent-allowed, or an `adminRole` branch for a field/platform-level split (see the [Roles](#roles-operator-vs-agent) table). It goes through git review and ships with the next Worker deploy; no box rebuild, no second list to keep in sync.

## Secrets

The Worker owns every platform secret (R2, Postiz, Turso, YouTube, Mixcloud, Last.fm, Telegram); the agent holds **only** its admin token and the model key. Nothing secret lives in this repo or baked into the image.

- Secrets are pulled from 1Password via the `op` CLI into a **root-owned** secret env-file, mounted with `--env-file` at run (exact path + item names in the ops runbook note). App secrets today: the **agent-scoped** admin bearer, `OPENROUTER_API_KEY` (model), `CLAUDE_CODE_OAUTH_TOKEN` (the Claude Code subscription token the `fluncle-observation` cron's `claude -p` authoring step authenticates with — from the configured 1Password item; subscription auth, distinct from `OPENROUTER_API_KEY`), and the Discord bot token (when wired). The `claude` binary + the `copywriting-fluncle` skill are baked into the image (§ The image); only this token arrives at run — never baked.
- The `op` service-account token is the one bootstrap secret — it can't come _from_ 1Password, so it sits in a separate root-only file used only by the secret-population step, kept **out** of the container env.
- **The box never holds the operator token.** The CLI reads `FLUNCLE_API_TOKEN`; on the box that env var holds the value of the **agent-scoped** token (stored in 1Password as `FLUNCLE_AGENT_TOKEN`). The CLI sends it as its Bearer, the Worker recognizes it as the `agent` role, and publish-class actions are refused server-side. The operator's own laptop keeps the full `FLUNCLE_API_TOKEN` (the `operator` role). Both are intentionally **separate** from the admin-cookie signing key (`ADMIN_SESSION_SECRET`, a Worker-only secret), so a box compromise costs only the agent surface and **cannot forge web-admin sessions**.
- Provisioning and rotating the agent token is a generate → `wrangler secret put FLUNCLE_AGENT_TOKEN` (Worker) → store in 1Password → re-populate the secret env-file (its `FLUNCLE_API_TOKEN` = the agent value) → restart loop; the full operator `FLUNCLE_API_TOKEN` rotates independently the same way. The exact recipe (key generation, the env-file path, the restart) is in the ops runbook note.

## Model

BYO key via OpenRouter (`config.yaml` `model.provider: openrouter`, `model.default: <slug>`, `OPENROUTER_API_KEY` read from the env). Must be ≥64k context and pinned. Current: `anthropic/claude-sonnet-4.6`. Swapping the model is a one-line config change + restart, no rebuild — the versioned baseline is [`docs/agents/hermes/config.yaml`](./hermes/config.yaml).

> Model choice is a **voice** decision, not just cost. A flash/generic model is the _precise anti-Fluncle_ — it slips into third-person "fluncle", prose em-dashes, and chirpy register. Sonnet 4.6 holds the deadpan reliably; `anthropic/claude-haiku-4.5` is the cheaper fallback if traffic ever bites. Whatever is pinned must pass the voice gate (below) before the bot goes public.

## Voice

The agent's identity is **Fluncle**, set always-on via `~/.hermes/SOUL.md` (Hermes personality slot #1, replacing the default identity) — versioned at [`docs/agents/hermes/SOUL.md`](./hermes/SOUL.md). SOUL.md is the thin always-on layer (the cardinal mechanical rules + the Discord/crew-feed register); it **delegates depth** to the `copywriting-fluncle` skill (the full voice canon), which is installed in the agent's skills dir (`/opt/data/skills/`). The skill loads on demand when the agent writes copy-shaped output (a finding note, a recap), so casual replies ride SOUL.md and authored copy pulls the canon.

To change the voice: edit `SOUL.md` (or the `copywriting-fluncle` skill) in the repo, redeploy to `~/.hermes/SOUL.md` / the skills dir, restart, retest. Voice lives in git, never the agent's self-improve loop.

**Redeploying the `copywriting-fluncle` skill.** The agent's skills dir is host-mounted and root-owned, so the skill is updated _through_ Docker from the repo (copy the skill in over SSH, back up + replace the live copy, restart the container), not hand-edited on the box. The agent loads a skill **by name** fresh each session, so a content-replace + restart is the whole update — no manifest step; verify with a directory listing inside the container, then re-render one observation to confirm the new guidance took. The exact copy-in/restart recipe is the operator runbook in the [fluncle-hermes-operator](../../packages/skills/fluncle-hermes-operator) skill (and the ops runbook note).

## Run

`<secret-env-file>` below is the root-owned `op`-populated env-file (§ Secrets); its exact path is in the ops runbook note.

```bash
docker run -d --name hermes --restart unless-stopped \
  --memory=4g --cpus=2 --shm-size=1g \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  -v ~/.hermes:/opt/data \
  --env-file <secret-env-file> \
  fluncle-hermes:v2026.6.19 gateway run
```

- **Never mount the Docker socket** — it would hand the agent host root and moot every file-permission control. No in-scope job needs it.
- For a Discord-only bot, publish **no** ports (the gateway dials out over the Discord WebSocket). If the API (`8642`) or dashboard (`9119`) is ever needed, bind to `127.0.0.1`/`tailscale0` only.
- Disable Tailscale node-key expiry on the box (no public fallback → an expired key is a total lockout).

## Self-deploy (the pin-watch timer)

The box keeps its baked CLI pins current **on its own**. `fluncle-pin-watch` — a host systemd timer on rave-02 (a _host_ timer, not a Hermes cron: a container can't cleanly rebuild and replace itself) — hourly compares the `fluncle` + Claude Code pins in this Dockerfile on `main` against the running container's versions; on drift it rebuilds the image, **pre-smokes** it (versions + an agent read + the publish-class role boundary) in throwaway containers BEFORE touching the live one, swaps, post-smokes, and **auto-rolls-back** on any failure — credential-free (the repo is public; secrets are reused from the running container's own env, nothing read from `op`), Discord-alerting on a deploy or rollback, and reporting a `self-deploy` health row to [`/status`](https://www.fluncle.com/status) so the self-maintenance loop is publicly visible. This is the deploy half of the version-currency loop: the [`fluncle-maintenance`](../../packages/skills/fluncle-maintenance) sweep — the `.github/workflows/hermes-pin-drift.yml` GitHub Actions workflow — opens (and on green, merges) a clearly-safe pin bump, and the box self-deploys it. The base image (`FROM`) is **not** watched — a base bump stays a manual operator brake. Runbook + the rollback rail: [`hermes/pin-watch/`](./hermes/pin-watch/).

## Crons (automation)

Hermes is also Fluncle's queue-driven automation orchestrator: scheduled, trusted, no-untrusted-input loops over the `fluncle` CLI. They are versioned at [`docs/agents/hermes/cron/`](./hermes/cron/) (`jobs.json` + a `README.md` with the operator's wire-on-the-box steps).

- **Mechanism (verified, [upstream cron docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)):** jobs live in `~/.hermes/cron/jobs.json` (**not** `config.yaml`), per-run output under `~/.hermes/cron/output/{job_id}/`; the gateway ticks every 60 s and runs each due job in a **fresh, isolated session** (a job's prompt or script must be self-contained). Schedules are relative / `every Nh` interval / cron expression / ISO timestamp. Jobs are created via Hermes' own `cronjob` tool (`hermes cron create …`, chat `/cron add`, or conversation) — not by hand-editing `jobs.json`. **No agent jobs remain** — every cron is a `--no-agent --script` sweep created on the box directly, so `jobs.json` is now `"jobs": []` (kept only as the mechanism record + source-of-truth pointer); the sweep sources under [`hermes/scripts/`](./hermes/scripts/) are the canonical files, the box the deploy target.
- **The pure-trigger `--no-agent` sweeps (`fluncle-enrich`, `fluncle-backfill`, `fluncle-context-note`) — pure compute/trigger, zero LLM tokens on the box.** `fluncle-enrich` (LIVE, every 5 min) drains the enrich worklist (`fluncle admin tracks enrich --queue`), analyzes each finding on-box (`ffmpeg` + `bun`), and writes the result back via `fluncle admin tracks update`. `fluncle-backfill` (every 30 min) paces the Worker-side Discogs/Last.fm backfills. `fluncle-context-note` (every 60 min) drains the no-context queue (`fluncle admin tracks context --queue`, `hasContext=false`) and triggers `context_track` per finding — the **Worker** runs the Firecrawl search + the Haiku note-distill (#129) + the quiet `context_note` write, so the box only triggers. All three run **without** the agent brain (`--no-agent`), so they carry no untrusted-input surface; each is created on the box directly (`hermes cron create --no-agent …`) and is **not** in `jobs.json`.
- **`fluncle-observation` — the HYBRID `--no-agent` sweep (every 60 min, idempotent queue drain).** No longer a full-agent cron: a deterministic queue/gather/deliver wrapper around **one** `claude -p` authoring call. It drains the observe worklist (`fluncle admin tracks observe --queue`, `hasContext=true AND hasObservation=false`), reads each finding's metadata (`fluncle track get`), then runs `claude -p --allowedTools "Read,Glob,Grep"` (Claude Code on **subscription** auth via `CLAUDE_CODE_OAUTH_TOKEN` — NOT OpenRouter — with the `copywriting-fluncle` skill, read-only tools) to author the recovered-audio script. The **script** posts it via `fluncle admin tracks observe --script-file`; the Worker voice-gates + renders + stores. Cap 1/tick (paid renders + the ~120s runner kill). The authoring step has no untrusted-input surface (read-only tools, a self-contained prompt) and the delivery stays under the agent ceiling — reversible, internal, no public footprint. Source: `hermes/scripts/observe-sweep.{sh,ts}`; created on the box directly, not in `jobs.json`. Pre-reqs: the `claude` CLI + `CLAUDE_CODE_OAUTH_TOKEN` + the `copywriting-fluncle` skill baked at `/opt/claude/skills/copywriting-fluncle` (`CLAUDE_CONFIG_DIR=/opt/claude`).
- **`fluncle-render` — the video render CONDUCTOR (`--no-agent`, LIVE 2026-06-24).** Unlike the on-box sweeps, the Hermes box has no GPU/Remotion: this cron wakes a separate **scale-to-zero box.ascii render box** (the render box; host map in the ops runbook note), triggers one queued finding's `@fluncle-video` render _there_ via a remote `claude -p`, and parks the box when it finishes. Each tick is quick (<120s — the runner's kill limit) and drives a **detached ~85-min render** through a two-state machine (single-flight by state + an atomic `mkdir` lock; the box renders + **ships to R2/the website, never to social** — the prompt's hard rail AND the operator-tier publish gate both block it). Pre-reqs: the box.ascii CLI baked (§ The image) + `BOX_API_KEY` + `CLAUDE_CODE_OAUTH_TOKEN` file-sourced from a `0600` `~/.render-conductor.env`. Source: `hermes/scripts/render-conductor.sh` + `provision-rave-03.sh` + `render-detached.sh`; wiring in [`hermes/cron/README.md`](./hermes/cron/README.md) § the render conductor.
- **`fluncle-newsletter` — the weekly HYBRID `--no-agent` sweep (`0 15 * * 5`, `deliver: discord`).** Friday 15:00 Amsterdam (box clock pinned to `Europe/Amsterdam` — Hermes cron has no per-job TZ field, so DST is solved at the box clock): read the discovery window, author the edition with **one** `claude -p` call (subscription auth + `copywriting-fluncle`, zero OpenRouter), **persist a draft** via `fluncle admin newsletter draft` (`create_edition`, agent tier), then post a one-line Discord summary + the `fluncle admin newsletter send <id>` command. The **send stays operator-only**: the agent token gets a 403 on `send_edition`, so the sweep persists-then-offers and the operator runs the send command (which fires the Worker-side Resend Broadcast + mints the number). The old interactive `clarify` Send button needed the agent loop and is gone with it. `RESEND_*` stays a **Worker secret** — the box never holds it. Source: `hermes/scripts/newsletter-sweep.{sh,ts}`. See [`hermes/cron/README.md`](./hermes/cron/README.md) and the authoring doctrine in [`newsletter-agent.md`](./newsletter-agent.md).
- **The remaining `--no-agent` sweeps** — `fluncle-note` (hybrid, every 10 min — the auto-note), `fluncle-social-capture` (every 10 min — captures the YouTube/TikTok post URLs Postiz withholds on create), and `fluncle-studio-clip` (every 15 min, #215 — cuts a mixtape set into framed 9:16 clips → R2). The canonical, always-current roster (cadence, mode, source) is the table in [`hermes/cron/README.md`](./hermes/cron/README.md) § Cron roster; run `hermes cron list` on the box for live IDs.
- **Host systemd timers (NOT gateway crons).** Two monitoring/infra jobs deliberately run from rave-02 **host** systemd timers rather than the Hermes gateway, so they don't depend on the busy scheduler they manage: `fluncle-pin-watch` (the image self-deploy, [`hermes/pin-watch/`](./hermes/pin-watch/)) and `fluncle-healthcheck` (every 10 min — probes each service → the public `/status` board via `record_health`; moved off the gateway so the prober isn't starved by the sweeps it monitors, [`hermes/healthcheck-timer/`](./hermes/healthcheck-timer/)).

## Verify (smoke test)

```bash
# CLI present
docker run --rm --entrypoint fluncle fluncle-hermes:v2026.6.19 version            # -> fluncle <ver>
# agent-allowed read with the agent token + live API (expect {"ok":true,...})
docker run --rm --env-file <secret-env-file> --entrypoint fluncle \
  fluncle-hermes:v2026.6.19 admin tracks enrich --queue --json --limit 1
# the server boundary: a publish-class command with the agent token is refused
# (expect a 403 "forbidden" — the operator role is required, not an execution)
docker run --rm --env-file <secret-env-file> --entrypoint fluncle \
  fluncle-hermes:v2026.6.19 admin add <url>
```

When the gateway is live, repeat the boundary check **through the agent** ("run `fluncle admin tracks publish …`" must come back as an in-voice refusal off the server 403, not an execution).

### Voice gate (hard requirement before the bot goes public)

A chat reply is a live Fluncle surface. Before public exposure, the pinned model + `SOUL.md` must pass a fixed voice probe: leads with the bodily reaction not a bpm/key description (Oof Test), turns to the crew (Selector's Rule), dry (no `!`, no service-desk register, no "we"-as-company, no third-person "fluncle"), sentence case, emoji only from the sanctioned set and never on data rows, no prose em-dashes (only the `Artist — Title` separator), and a human "would the uncle say this out loud over a tune?" sign-off. Probe by DMing/@mentioning the bot ("what did you find this week?", a greeting, a publish-class command that must be refused in voice, an off-topic question). Voice changes go through git (`SOUL.md` + the skill), never the agent's self-improve loop.

## Security posture & limits

- The boundary is the **server-side role**: the box holds only the `agent`-scoped token, and publish-/irreversible-class actions are refused at the Worker for that role. The private no-public-TCP box shrinks the network surface.
- Indirect prompt injection needs no compromised account (the agent browses untrusted web content) — but an injected `fluncle admin tracks publish …` is refused by the Worker no matter how it is dispatched (the CLI, raw `curl` with the printenv'd token), because the token is `agent`-scoped. There is no local wrapper to bypass; there is nothing the token can do that the server allows.
- **Residual surface:** a fully-compromised root agent is bounded to the agent role — reads (incl. `enrich-queue`), analysis write-back (`track update`), a TikTok inbox draft. All reversible/internal, none public without the operator. Anyone on the Discord allow-list can trigger those same agent-allowed writes (not just reads); all publish-class is blocked for everyone but the operator. (The enrich sweep itself runs `--no-agent`, off the agent brain, so it is not part of this surface.)
- The agent still runs as root _inside the container_, but that no longer grants publish authority (the credential lacks it). Running the agent non-root with the token out of its readable env is now **defense-in-depth** — it protects the agent surface + the token itself — not the publish boundary. Tracked as optional, in [ROADMAP.md](../ROADMAP.md).
- Back up `~/.hermes` as an encrypted/snapshot copy only (it holds `.env` + memory) — never a plaintext off-box tarball.

## Status

Live for the internal crew: pinned image with the `fluncle` CLI (ungated; the Worker is the boundary); secrets via `op` → the root-owned secret env-file; Discord app online (both privileged intents, a tight allow-list); model pinned (`anthropic/claude-sonnet-4.6`); Fluncle voice via `SOUL.md` + the `copywriting-fluncle` skill, voice-gated. The publish boundary is **server-side**: the box holds an `agent`-scoped token and the Worker refuses publish-/irreversible-class actions for that role ([Roles](#roles-operator-vs-agent)) — this supersedes the earlier local-command-gate design and the need for a separate publish-confirm flow. Open (tracked in [ROADMAP.md](../ROADMAP.md), now optional defense-in-depth rather than a public-readiness blocker): non-root-in-container hardening. The full cron roster is **live on the box** ([§ Crons](#crons-automation)): the `fluncle-enrich` / `fluncle-context-note` / `fluncle-backfill` / `fluncle-social-capture` / `fluncle-studio-clip` `--no-agent` sweeps + the hybrid `fluncle-note` / `fluncle-observation` / `fluncle-newsletter` sweeps (the 2026-06-23 cutover, with the newsletter converted from its agent cron on 2026-06-27 — **no agent jobs remain**), and — as of **2026-06-24** — the `fluncle-render` video conductor (it wakes a separate scale-to-zero box.ascii render box, the render box, rendering off the Hermes box entirely). The `/status` prober (`fluncle-healthcheck`) and the image self-deploy (`fluncle-pin-watch`) run from rave-02 **host** systemd timers, not the gateway.
