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

| Surface                                                                                                                         | Role     | Why                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------- |
| All public reads + admin reads (`queue`, `enrich-queue`, `vehicles`, `mixtapes list/get`, `submissions review`, `track social`) | agent    | No effect                                            |
| `enrich-sweep`                                                                                                                  | agent    | Idempotent self-heal; no public footprint            |
| `track update` — analysis only (`--status/--bpm/--key/--features`)                                                              | agent    | Machine-measured, internal, overwritable             |
| `track draft` — TikTok/default                                                                                                  | agent    | `SELF_ONLY` inbox draft; a human still posts it      |
| `add` (Spotify playlist + Telegram)                                                                                             | operator | Public, irreversible                                 |
| `track draft --platform youtube`                                                                                                | operator | Direct public upload                                 |
| `track update` — `--note/--video-url/--vibe-x/y` (+ identity `isrc/logId`)                                                      | operator | Editorial voice + map placement — Fluncle's judgment |
| `track video` / `preview-archive` / `observe`                                                                                   | operator | Durable artifacts                                    |
| `mixtapes publish/distribute/delete/create/update/members`                                                                      | operator | Publishes/mutates the spine                          |
| `submissions approve/reject`                                                                                                    | operator | Editorial decision; approve can publish              |
| `auth *`, `backfill *`                                                                                                          | operator | Credentials / bulk mutation                          |

Enforcement is at the route: agent-allowed routes call `requireAdmin` (any principal); publish-/irreversible-class routes call `requireOperator` (403s the agent). The two conditional commands (`track update`, `track draft`) authenticate with `requireAdmin`, then branch on `adminRole` to reject an operator-only field/platform. The CLI on the box runs ungated — an agent-role attempt at an operator route is refused server-side, and the agent relays the 403 in voice (see `SOUL.md`).

## Where it runs

A private, Tailscale-only devbox (admin over OpenSSH on the tailnet; no public inbound TCP). Docker only — deliberately no general dev tooling, for a small blast radius. The gateway runs as a pinned Docker image; state lives in `~/.hermes` (`/opt/data` in the container): `.env`, `config.yaml`, `sessions/`, `memories/`, `skills/`, `logs/`.

## The image

Built from the pinned upstream gateway plus the `fluncle` CLI (installed ungated; the Worker is the boundary). Build context: [`docs/agents/hermes/`](./hermes/) — [`Dockerfile`](./hermes/Dockerfile).

- **Pin the upstream tag** (Hermes is pre-1.0; `latest` can change message handling and the model-context startup check under you). Current pin: `nousresearch/hermes-agent:v2026.6.19`.
- **Pin the model** at ≥64k context. A model below the floor takes the _whole gateway_ down at startup (upstream issue #24140), not just one feature.
- **Review the upstream pin monthly** and bump deliberately (pinning forever = no security patches for a wide Chromium/ffmpeg/Node/Python surface).

```bash
# on the devbox, from the build context (Dockerfile present)
docker build -t fluncle-hermes:v2026.6.19 .
```

## Changing what the agent may do

The allow-list lives in one place — the Worker. To move a command across the operator/agent line, change its route guard in `apps/web/src/lib/server/env.ts` consumers: `requireOperator` for operator-only, `requireAdmin` for agent-allowed, or an `adminRole` branch for a field/platform-level split (see the [Roles](#roles-operator-vs-agent) table). It goes through git review and ships with the next Worker deploy; no box rebuild, no second list to keep in sync.

## Secrets

The Worker owns every platform secret (R2, Postiz, Turso, YouTube, Mixcloud, Last.fm, Telegram); the agent holds **only** its admin token and the model key. Nothing secret lives in this repo or baked into the image.

- Secrets are pulled from 1Password via the `op` CLI into a **root-owned** `/etc/hermes.env`, mounted with `--env-file` at run. App secrets today: the **agent-scoped** admin bearer, `OPENROUTER_API_KEY` (model), and the Discord bot token (when wired).
- The `op` service-account token is the one bootstrap secret — it can't come _from_ 1Password, so it sits in a separate root-only file used only by the secret-population step, kept **out** of the container env.
- **The box never holds the operator token.** The CLI reads `FLUNCLE_API_TOKEN`; on the box that env var holds the value of the **agent-scoped** token (stored in 1Password as `FLUNCLE_AGENT_TOKEN`). The CLI sends it as its Bearer, the Worker recognizes it as the `agent` role, and publish-class actions are refused server-side. The operator's own laptop keeps the full `FLUNCLE_API_TOKEN` (the `operator` role). Both are intentionally **separate** from the admin-cookie signing key (`ADMIN_SESSION_SECRET`, a Worker-only secret), so a box compromise costs only the agent surface and **cannot forge web-admin sessions**.
- Provision the agent token: `openssl rand -base64 32` → `wrangler secret put FLUNCLE_AGENT_TOKEN` (Worker) + store it in 1Password → re-populate `/etc/hermes.env` (its `FLUNCLE_API_TOKEN` = the agent value) → restart the container. Rotate the same way. The full `FLUNCLE_API_TOKEN` rotates independently with `wrangler secret put FLUNCLE_API_TOKEN`.

## Model

BYO key via OpenRouter (`config.yaml` `model.provider: openrouter`, `model.default: <slug>`, `OPENROUTER_API_KEY` read from the env). Must be ≥64k context and pinned. Current: `anthropic/claude-sonnet-4.6`. Swapping the model is a one-line config change + restart, no rebuild — the versioned baseline is [`docs/agents/hermes/config.yaml`](./hermes/config.yaml).

> Model choice is a **voice** decision, not just cost. A flash/generic model is the _precise anti-Fluncle_ — it slips into third-person "fluncle", prose em-dashes, and chirpy register. Sonnet 4.6 holds the deadpan reliably; `anthropic/claude-haiku-4.5` is the cheaper fallback if traffic ever bites. Whatever is pinned must pass the voice gate (below) before the bot goes public.

## Voice

The agent's identity is **Fluncle**, set always-on via `~/.hermes/SOUL.md` (Hermes personality slot #1, replacing the default identity) — versioned at [`docs/agents/hermes/SOUL.md`](./hermes/SOUL.md). SOUL.md is the thin always-on layer (the cardinal mechanical rules + the Discord/crew-feed register); it **delegates depth** to the `copywriting-fluncle` skill (the full voice canon), which is installed in the agent's skills dir (`/opt/data/skills/`). The skill loads on demand when the agent writes copy-shaped output (a finding note, a recap), so casual replies ride SOUL.md and authored copy pulls the canon.

To change the voice: edit `SOUL.md` (or the `copywriting-fluncle` skill) in the repo, redeploy to `~/.hermes/SOUL.md` / the skills dir, restart, retest. Voice lives in git, never the agent's self-improve loop.

## Run

```bash
docker run -d --name hermes --restart unless-stopped \
  --memory=4g --cpus=2 --shm-size=1g \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  -v ~/.hermes:/opt/data \
  --env-file /etc/hermes.env \
  fluncle-hermes:v2026.6.19 gateway run
```

- **Never mount the Docker socket** — it would hand the agent host root and moot every file-permission control. No in-scope job needs it.
- For a Discord-only bot, publish **no** ports (the gateway dials out over the Discord WebSocket). If the API (`8642`) or dashboard (`9119`) is ever needed, bind to `127.0.0.1`/`tailscale0` only.
- Disable Tailscale node-key expiry on the box (no public fallback → an expired key is a total lockout).

## Verify (smoke test)

```bash
# CLI present
docker run --rm --entrypoint fluncle fluncle-hermes:v2026.6.19 version            # -> fluncle <ver>
# agent-allowed read with the agent token + live API (expect {"ok":true,...})
docker run --rm --env-file /etc/hermes.env --entrypoint fluncle \
  fluncle-hermes:v2026.6.19 admin enrich-queue --json --limit 1
# the server boundary: a publish-class command with the agent token is refused
# (expect a 403 "forbidden" — the operator role is required, not an execution)
docker run --rm --env-file /etc/hermes.env --entrypoint fluncle \
  fluncle-hermes:v2026.6.19 admin add <url>
```

When the gateway is live, repeat the boundary check **through the agent** ("run `fluncle admin tracks publish …`" must come back as an in-voice refusal off the server 403, not an execution).

### Voice gate (hard requirement before the bot goes public)

A chat reply is a live Fluncle surface. Before public exposure, the pinned model + `SOUL.md` must pass a fixed voice probe: leads with the bodily reaction not a bpm/key description (Oof Test), turns to the crew (Selector's Rule), dry (no `!`, no service-desk register, no "we"-as-company, no third-person "fluncle"), sentence case, emoji only from the sanctioned set and never on data rows, no prose em-dashes (only the `Artist — Title` separator), and a human "would the uncle say this out loud over a tune?" sign-off. Probe by DMing/@mentioning the bot ("what did you find this week?", a greeting, a publish-class command that must be refused in voice, an off-topic question). Voice changes go through git (`SOUL.md` + the skill), never the agent's self-improve loop.

## Security posture & limits

- The boundary is the **server-side role**: the box holds only the `agent`-scoped token, and publish-/irreversible-class actions are refused at the Worker for that role. The private no-public-TCP box shrinks the network surface.
- Indirect prompt injection needs no compromised account (the agent browses untrusted web content) — but an injected `fluncle admin tracks publish …` is refused by the Worker no matter how it is dispatched (the CLI, raw `curl` with the printenv'd token), because the token is `agent`-scoped. There is no local wrapper to bypass; there is nothing the token can do that the server allows.
- **Residual surface:** a fully-compromised root agent is bounded to the agent role — reads, `enrich-sweep`, analysis write-back, a TikTok inbox draft. All reversible/internal, none public without the operator. Anyone on the Discord allow-list can trigger those same agent-allowed writes (not just reads); all publish-class is blocked for everyone but the operator.
- The agent still runs as root _inside the container_, but that no longer grants publish authority (the credential lacks it). Running the agent non-root with the token out of its readable env is now **defense-in-depth** — it protects the agent surface + the token itself — not the publish boundary. Tracked as optional, in [ROADMAP.md](../ROADMAP.md).
- Back up `~/.hermes` as an encrypted/snapshot copy only (it holds `.env` + memory) — never a plaintext off-box tarball.

## Status

Live for the internal crew: pinned image with the `fluncle` CLI (ungated; the Worker is the boundary); secrets via `op` → `/etc/hermes.env`; Discord app online (both privileged intents, a tight allow-list); model pinned (`anthropic/claude-sonnet-4.6`); Fluncle voice via `SOUL.md` + the `copywriting-fluncle` skill, voice-gated. The publish boundary is **server-side**: the box holds an `agent`-scoped token and the Worker refuses publish-/irreversible-class actions for that role ([Roles](#roles-operator-vs-agent)) — this supersedes the earlier local-command-gate design and the need for a separate publish-confirm flow. Open (tracked in [ROADMAP.md](../ROADMAP.md), now optional defense-in-depth rather than a public-readiness blocker): non-root-in-container hardening, and scheduling the enrich-sweep.
