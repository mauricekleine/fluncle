---
name: fluncle-hermes-operator
description: >-
  Operator runbook for changing Fluncle's self-hosted Hermes chat agent — the Nous Research Hermes gateway that fronts Discord. Use this whenever you need to modify the Hermes agent itself: swap its model, edit its Fluncle voice (SOUL.md), change what it is allowed to do (the operator/agent role boundary), bump its pinned image or the bundled `fluncle` CLI, rotate or add a secret, or run the build / deploy / verify loop on the devbox. Trigger on any mention of the Hermes agent, the Fluncle chat bot, the Discord bot, "what the agent can do", changing its model or voice, rebuilding or redeploying the gateway, or its token — even when "Hermes" is not named. This is the chat presence only; the enrichment, newsletter, and observation agents are separate and out of scope.
---

# Fluncle Hermes operator

Fluncle's Hermes agent is a self-hosted [Nous Research Hermes](https://hermes-agent.nousresearch.com) gateway that fronts Discord and acts on the archive through the authenticated `fluncle` CLI. This skill is the operator's map for **changing** it: which lever to pull for a given change, the invariants not to break, and how a change actually reaches the running bot.

The architecture, security model, and the **exact build / run / verify commands and secret locations** live in `docs/agents/hermes-agent.md` — that doc is the source of truth, and this skill routes to it rather than restating it. Read the doc's relevant section before you touch anything; come here for the decision and the guardrails. The build context (Dockerfile, the versioned `config.yaml`, `SOUL.md`) is `docs/agents/hermes/`.

This is the **chat presence only**. The async enrichment agent, the Friday newsletter agent, and the audio-observation agent are different agents with their own docs under `docs/agents/` — out of scope here.

## The mental model: the repo is the truth, the box is a deploy target

Make every change **in the repo and commit it** — never hand-edit on the box as the canonical version. An on-box edit drifts from git and is erased the next time the box is redeployed or rebuilt; keeping the change in the repo is what makes the security-relevant bits (the role boundary, the voice) reviewable and a rebuilt box identical to the committed state.

From the repo, a change reaches the live bot through **one of two deploy targets**, and picking the right one is most of the job:

- **The Worker** (`apps/web`) — _what the agent may do_. The operator/agent permission boundary is enforced **server-side**, not on the box. A push to `main` auto-deploys it. So "let the agent do X" or "stop the agent doing Y" is a code change to a route's role guard, reviewed in git.
- **The box** — _how the agent runs and sounds_. The model config, the Fluncle voice, the image, and the secrets live on the devbox (reached over SSH on the tailnet; the address is in the operator's ops notes). These ship by redeploying the changed file into the agent's state dir (`~/.hermes`), or rebuilding the image, then restarting the container.

If you remember nothing else: **the publish boundary is server-side.** Reaching for the box to change what the agent is _allowed_ to do is the classic wrong turn — that lever is a Worker role guard, in git.

## Which lever for which change

| You want to…                                                                              | Change this (in the repo)                                                                                       | How it ships                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Allow / forbid an agent action (move a command across the operator↔agent line)            | the route's role guard in `apps/web` (`requireOperator` / `requireAdmin` / an `adminRole` branch — doc § Roles) | push to `main` → Worker auto-deploys. No box change.                                                                                                                                                                                                                                             |
| Swap the model                                                                            | `docs/agents/hermes/config.yaml` (`model.default`, one line; keep ≥64k context)                                 | redeploy config to the box + restart. No rebuild.                                                                                                                                                                                                                                                |
| Change the voice                                                                          | `docs/agents/hermes/SOUL.md` (and/or the `copywriting-fluncle` skill it delegates to)                           | redeploy SOUL.md / the skill to the box + restart, then re-run the voice gate. **Note: the skill ships TWICE** — the agent's host-mounted copy (`~/.hermes/skills/`, `docker cp`) AND the image-baked claude-code copy (`/opt/claude/skills/`, rebuild) the observation cron loads; update both. |
| Bump the upstream pin, the bundled `fluncle` CLI, or the Claude Code CLI                  | `docs/agents/hermes/Dockerfile`                                                                                 | rebuild the image (from the **repo root**, `-f docs/agents/hermes/Dockerfile`) + restart + smoke test.                                                                                                                                                                                           |
| Rotate / add a secret (e.g. the agent token)                                              | follow the doc's § Secrets procedure (secret store → env → restart)                                             | re-populate the env from the secret store + restart.                                                                                                                                                                                                                                             |
| Change who may talk to the bot (the allow-list)                                           | the Discord allowed-users env (doc § Run / ops notes)                                                           | update the env + restart.                                                                                                                                                                                                                                                                        |
| Add / change an automation cron (enrich self-heal, context-note, observation, newsletter) | `docs/agents/hermes/cron/jobs.json` (+ its `README.md`) — the canonical source                                  | recreate each job on the box via Hermes' `cronjob` tool (not hand-edited). See § Crons below.                                                                                                                                                                                                    |

The doc's section headings mirror this table (§ The image, § Changing what the agent may do, § Model, § Voice, § Secrets, § Run), so once you know the lever you know where to read. The automation crons live in the build context at `docs/agents/hermes/cron/` (see § Crons below).

## Invariants (the why, so you don't fight the design)

- **Changes go through git.** The repo is canonical; the box mirrors it. This keeps the role boundary and the voice reviewable and reproducible, and means a rebuilt box matches the committed state. An ad-hoc box edit is a one-off the next deploy erases.
- **The permission boundary is server-side, full stop.** The box deliberately holds only a low-privilege `agent`-scoped token; the Worker refuses publish-/irreversible-class actions for that role. You never make the agent "more powerful" by editing the box — you change a Worker role guard, in git. (This is also why a leaked box token can't publish.)
- **Pin the image and the model.** Hermes is pre-1.0, and a sub-64k-context model takes the whole gateway down at startup, not just one feature. Bump deliberately, never float `latest`, and review the upstream pin periodically for security patches.
- **Voice lives in git, never the agent's self-improve loop.** `SOUL.md` plus the `copywriting-fluncle` skill are the only voice source; letting the agent rewrite its own identity drifts it off-canon with no review.
- **Public repo: no host names, IPs, or secret values in committed files.** Those live in the operator's ops notes and the secret store. The committed docs and this skill stay at the architecture / procedure level — match that when you edit them.

## The change → ship → verify loop

1. **Edit in the repo** and commit; the relevant doc section names the exact file.
2. **Ship to the right target.** A Worker/role change deploys on push to `main`. A box change (config / voice / image / secret) is redeployed to the box and the container restarted — the doc's § Run has the exact commands. Rebuild the image **only** for image/CLI changes; config, voice, and secrets are redeploy-the-file (or re-populate-the-env) + restart, no rebuild.
3. **Verify.** Run the doc's § Verify smoke test (CLI present; an agent-allowed read returns `{ok:true}`; a publish-class command is refused with a 403). For a voice or model change, also run the **voice gate** (doc § Voice gate) and confirm it through the live bot in Discord, not just the container. For a Worker role change, confirm the agent token now gets the new allow/deny against the deployed API.
4. **Quality checks for Worker changes.** Per `AGENTS.md`, run the `apps/web` typecheck / lint / build before pushing — a push to `main` is a production deploy.

## Crons (automation) — prepared, not yet deployed

Hermes is also Fluncle's automation orchestrator (`docs/hermes-automation-brief.md`): hourly, trusted, no-untrusted-input loops over the `fluncle` CLI. The first three crons are **drafted in the repo but not wired on the box** — canonical source at `docs/agents/hermes/cron/` (`jobs.json` + a `README.md` that holds the operator's wire-on-the-box runbook + the verified mechanism). **Nothing is live until the operator wires it.**

- **The hourly three (idempotent queue drains):** enrichment self-heal (`tracks enrich --all`), context-note (drain `hasContext=false`, Worker-side Firecrawl), observation (drain `hasContext=true AND hasObservation=false`, author the recovered-audio script with `copywriting-fluncle`, then `observe --script`). All sit under the agent ceiling — reversible, internal, no public footprint — so scheduling them raises no authority an injection could abuse.
- **The weekly newsletter (`fluncle-newsletter`, `0 15 * * 5`, `deliver: discord`):** Friday 15:00 Amsterdam, author the edition with `copywriting-fluncle`, persist a draft via `fluncle admin newsletter draft` (agent tier), then offer a `clarify` **Send** button in Discord. Two operator-visible extras the hourly crons don't have: (1) **pin the box clock to `Europe/Amsterdam`** — Hermes cron has no per-job TZ field, so `0 15 * * 5` tracks DST only if the box clock is Amsterdam-local (smoke-test the clock before relying on it; any future absolute-time cron then inherits Amsterdam-local); (2) the **send stays operator-only** — the agent token 403s on `newsletter send`, so the operator taps the Send button (or runs `fluncle admin newsletter send <id>`); the cron never auto-sends, a missed tap re-offers next Friday. `RESEND_*` stays a Worker secret. Backfills (Last.fm / Discogs) are **not** yet in this set.
- **Mechanism (verified upstream):** jobs live in `~/.hermes/cron/jobs.json` (**not** `config.yaml`); the gateway ticks every 60 s and runs each due job in a fresh, self-contained agent session. Created via Hermes' `cronjob` tool (`hermes cron create`, chat `/cron add`, conversation) — **not** by hand-copying `jobs.json` onto the box. The repo file is the source of truth; recreate from it.
- **Gate before wiring:** the CLI admin naming rename must land first (the brief's sole green-light; sibling PR `cli/observe-context-crons`). The context-note job carries a `TODO(cli-rename)` marker — pin the real verb after the rename, then recreate that job. Smoke-test each command by hand on the box before scheduling it, and watch the first ticks (`~/.hermes/cron/output/` + `~/.hermes/logs/`); the observation cron spends Cartesia credits per render.

The change still goes through git: edit `docs/agents/hermes/cron/jobs.json`, commit, then recreate on the box. The box is the deploy target, the repo is canonical — same invariant as everything else here.

## When the bot misbehaves

- Runtime logs live under the agent's state dir (`~/.hermes/logs/`, root-owned); the container's stdout shows init + the banner + warnings, not the full agent log.
- A gateway that won't start is usually the model pin below the 64k floor — check `config.yaml`.
- A "refused" publish is the role boundary working as designed: a publish-class command **should** come back 403 for the agent, and the agent relays that in voice. The operator runs those actions with the full token, not the bot.

---

This skill mirrors `docs/agents/hermes-agent.md`; keep them in step when either changes. The automation crons (enrich self-heal, context-note, observation, newsletter) are **drafted** (§ Crons, `docs/agents/hermes/cron/`); the `observe`/agent-tier flips and the newsletter `draft`/`send`/`list` CLI relays have landed. Still to come as the rest of `docs/hermes-automation-brief.md` ships: the Last.fm / Discogs backfill role flips + crons (gated on their reliability columns). Add those levers here when they land.
