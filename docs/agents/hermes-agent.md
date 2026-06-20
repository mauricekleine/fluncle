# Hermes agent (chat presence)

Fluncle's chat-facing agent: a self-hosted [Nous Research Hermes](https://hermes-agent.nousresearch.com) gateway that fronts chat platforms (Discord first) and acts on the archive **only** through the authenticated `fluncle` CLI. It is the operator's console-in-chat — read the archive freely, propose admin actions behind a human gate.

> This repo is public. Host names, IPs, and secret values are **not** in this doc — they live in the operator's ops notes + 1Password. This doc is the architecture, the security policy, and the change/runbook procedures.

## The one idea

Hermes is not a bot — it is a long-running box that wields the `fluncle` CLI, and **the CLI is the entire trust boundary**. Everything the agent can do reduces to running `fluncle` commands (plus public HTTP reads) while holding one admin token. Discord/Slack are inbound surfaces onto that box. So the security question is not "which integrations" but "what can the agent do with the token, and what stops it." Two controls answer that:

1. **The command gate** (primary) — what the agent may _do_. A wrapper around `fluncle` that denies publish-/irreversible-class commands. See below.
2. **The allow-list** (secondary) — _who_ may talk to the agent (deny-by-default; tight). This bounds exposure and cost, not actions.

The box being private and Tailscale-only (no public inbound TCP) shrinks the network surface but does nothing against an agent that already holds the token and a shell — that is the gate's job.

## Where it runs

A private, Tailscale-only devbox (admin over OpenSSH on the tailnet; no public inbound TCP). Docker only — deliberately no general dev tooling, for a small blast radius. The gateway runs as a pinned Docker image; state lives in `~/.hermes` (`/opt/data` in the container): `.env`, `config.yaml`, `sessions/`, `memories/`, `skills/`, `logs/`.

## The image

Built from the pinned upstream gateway plus the `fluncle` CLI behind the gate. Build context: [`docs/agents/hermes/`](./hermes/) — [`Dockerfile`](./hermes/Dockerfile) + [`fluncle-gate`](./hermes/fluncle-gate).

- **Pin the upstream tag** (Hermes is pre-1.0; `latest` can change message handling and the model-context startup check under you). Current pin: `nousresearch/hermes-agent:v2026.6.19`.
- **Pin the model** at ≥64k context. A model below the floor takes the _whole gateway_ down at startup (upstream issue #24140), not just one feature.
- **Review the upstream pin monthly** and bump deliberately (pinning forever = no security patches for a wide Chromium/ffmpeg/Node/Python surface).

```bash
# on the devbox, from the build context (Dockerfile + fluncle-gate present)
docker build -t fluncle-hermes:v2026.6.19 .
```

## The command gate

The agent's `terminal` tool calls `fluncle`, which is the [`fluncle-gate`](./hermes/fluncle-gate) wrapper; the real CLI is `fluncle-real`. Policy: **public/read commands pass through; the `admin` namespace is deny-by-default with a tight allow-list.** Blocked commands are publish- or irreversible-class — the wrapper exits non-zero with a message telling the agent to ask the operator, who runs them by hand.

This restores the `AGENTS.md` rule ("ask before changes that publish to Spotify/Telegram/Discord/Cloudflare") for an otherwise-autonomous agent.

**Allowed autonomously**

- All non-`admin` commands (public reads/submits): `version`, `recent`, `get`, `random`, `mixtapes`, `open`, `subscribe`, `submit`, `about`.
- Admin reads: `admin queue`, `admin enrich-queue`, `admin vehicles`, `admin mixtapes list`, `admin mixtapes get`, `admin submissions review`, `admin track social`.
- `admin enrich-sweep` — the idempotent internal enrichment self-heal (no public effect).
- `admin track draft` — TikTok/default only (a `SELF_ONLY` inbox draft).
- `admin track update` — analysis write-back only: `--status`, `--bpm`, `--key`, `--features` (`--json` allowed).

**Blocked (→ "ask the operator", exit 87)**

- `admin add` (publishes to the Spotify playlist + Telegram).
- `admin track draft --platform youtube` (direct public upload).
- `admin track update` with any non-analysis flag (`--note`, `--video-url`, `--vibe-x/y`, …).
- `admin track video`, `admin track preview-archive`, `admin track observe`.
- `admin mixtapes publish | publish-youtube | distribute | delete | create | update | members`.
- `admin submissions approve | reject`.
- `admin auth *`, `admin backfill *`.
- Anything else under `admin` (deny-by-default — a new admin command is blocked until explicitly allowed here).

### How to change the gate

1. Edit [`docs/agents/hermes/fluncle-gate`](./hermes/fluncle-gate). Keep the allow-list tight — **when in doubt, deny.** New `admin` commands are blocked automatically; you only ever add to the allow-list deliberately.
2. Rebuild the image (above) and redeploy (restart the container on the new image).
3. Re-run the gate smoke test (below) to confirm the new policy.
4. Commit the change — the gate is the security boundary, so it goes through git review, never an ad-hoc edit on the box.

## Secrets

The Worker owns every platform secret (R2, Postiz, Turso, YouTube, Mixcloud, Last.fm, Telegram); the agent holds **only** its admin token and the model key. Nothing secret lives in this repo or baked into the image.

- Secrets are pulled from 1Password via the `op` CLI into a **root-owned** `/etc/hermes.env`, mounted with `--env-file` at run. App secrets today: `FLUNCLE_API_TOKEN` (the admin bearer), `OPENROUTER_API_KEY` (model), and the Discord bot token (when wired).
- The `op` service-account token is the one bootstrap secret — it can't come _from_ 1Password, so it sits in a separate root-only file used only by the secret-population step, kept **out** of the container env.
- `FLUNCLE_API_TOKEN` is the admin API bearer. It is intentionally **separate** from the admin-cookie signing key (`ADMIN_SESSION_SECRET`, a Worker-only secret) — so a box compromise costs the API surface (gated by the wrapper) but **cannot forge web-admin sessions**. Rotate with `wrangler secret put FLUNCLE_API_TOKEN`, then re-populate `/etc/hermes.env`.

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
# allow path + CLI present
docker run --rm --entrypoint fluncle fluncle-hermes:v2026.6.19 version            # -> fluncle <ver>
# gate denies a publish-class command (expect a BLOCKED message, exit 87)
docker run --rm --entrypoint fluncle fluncle-hermes:v2026.6.19 admin add <url>
# allow path + token + live API (expect {"ok":true,...})
docker run --rm --env-file /etc/hermes.env --entrypoint fluncle \
  fluncle-hermes:v2026.6.19 admin enrich-queue --json --limit 1
```

When the gateway is live, repeat the gate check **through the agent** ("run `fluncle admin add …`" must come back as a refusal-to-the-operator, not an execution).

### Voice gate (hard requirement before the bot goes public)

A chat reply is a live Fluncle surface. Before public exposure, the pinned model + `SOUL.md` must pass a fixed voice probe: leads with the bodily reaction not a bpm/key description (Oof Test), turns to the crew (Selector's Rule), dry (no `!`, no service-desk register, no "we"-as-company, no third-person "fluncle"), sentence case, emoji only from the sanctioned set and never on data rows, no prose em-dashes (only the `Artist — Title` separator), and a human "would the uncle say this out loud over a tune?" sign-off. Probe by DMing/@mentioning the bot ("what did you find this week?", a greeting, a publish-class command that must be refused in voice, an off-topic question). Voice changes go through git (`SOUL.md` + the skill), never the agent's self-improve loop.

## Security posture & limits

- Primary control is the **command gate**; the private no-public-TCP box is secondary.
- Indirect prompt injection needs no compromised account (the agent browses untrusted web content) — the gate is what stops an injected `fluncle admin add …`.
- **Honest limit:** the agent runs as root _inside the container_, so the gate is a strong guard against injection/accidental invocation (the model would have to be induced to deliberately overwrite the wrapper — conspicuous and multi-step), not a hard sandbox against a fully adversarial root agent. Hardening to a non-root agent user is the next step and is tracked, not done.
- Back up `~/.hermes` as an encrypted/snapshot copy only (it holds `.env` + memory) — never a plaintext off-box tarball.

## Status

Done: pinned image with the `fluncle` CLI behind the command gate; secrets via `op` → `/etc/hermes.env`; gate verified (deny + allow + live token). Not yet: model wired in `config.yaml`; the Discord app (bot token, both privileged intents, allow-list); the voice persona + voice gate; non-root hardening; sweep scheduling.
