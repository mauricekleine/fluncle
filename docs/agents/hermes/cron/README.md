# Hermes automation crons

The version-controlled **source** for the Hermes automation cron jobs (`docs/hermes-automation-brief.md`). The repo is canonical; the box is a deploy target (see the `fluncle-hermes-operator` skill). This directory records the canonical intent so a rebuilt box can be made to match.

Every step is a "read a queue → act per item, idempotently" loop over the `fluncle` CLI. There is **no on-add push**: a new find lands at `enrichment_status = pending` (queue-eligible) and is caught on the next tick.

## The `--no-agent` enrichment cron (LIVE)

`fluncle-enrich` is **live on the box**. It does not carry a prompt: enrichment is pure compute (get → analyze → update, zero LLM tokens), so it is a `--no-agent --script` job. Its script source lives beside the build context at [`../scripts/`](../scripts/) — a bash wrapper (`enrich-sweep.sh`) the cron runner execs by extension, which in turn `exec`s the bun orchestrator (`enrich-sweep.ts`). It is created on the box directly (not in `jobs.json`, which holds only the one remaining agent job, the newsletter).

## The `--no-agent` context-note cron (PREPARED, NOT YET WIRED)

`fluncle-context-note` fills the **factual** context note for findings that lack one (the `context_note`), so the observation cron can author a grounded script later. It used to be a full **agent** cron that spent a whole Sonnet session just to drain a queue and POST per finding — pure harness tax (~37k prompt tokens/call to emit ~200). Its only real LLM work — distilling the note — already moved **Worker-side onto Haiku** (#129), so the box no longer needs an agent: it only asks the API what's queued and triggers the Worker endpoint per finding. It carries no prompt and burns **zero LLM tokens on the box**, so it is now a `--no-agent --script` job like enrich/backfill. Its source lives beside them at [`../scripts/`](../scripts/): `context-sweep.sh` (the bash entry the runner execs by extension) → `context-sweep.ts` (the bun orchestrator).

**The Worker-paced model.** The box holds **no** Firecrawl key (the Worker does), and the note-distilling LLM (Haiku) is Worker-side too. So the Firecrawl search + Haiku distill + the quiet `context_note` write all happen **in the Worker**; this driver just **triggers** it — one small bounded batch per tick (`BATCH_CAP` 6). `context_track` is **agent tier** (idempotent on `context:${logId}`), so the box's existing agent-scoped token drives it; no operator token on the box (matching the `fluncle-enrich`/`fluncle-backfill` precedent).

| Job                    | Schedule  | What it does                                                                                                                                                                                                                                                | Server slice                                                              |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `fluncle-context-note` | every 60m | Drain `admin tracks context --queue` (`hasContext=false`, oldest-first); per finding (bounded batch, cap 6/tick): `admin tracks context <id>` → triggers the Worker (Firecrawl + Haiku distill + quiet `context_note` write). Idempotent; no-op when empty. | `context_track` agent-tier endpoint + `hasContext` filter (#86/#88/#129). |

**Every 60m, not 5m:** unlike `fluncle-enrich` (latency-sensitive for new finds), the context note is fuel the hourly observation cron consumes — so an hourly cadence keeps the two in step without paying the Worker (Firecrawl + Haiku) more often than the observation step can use. The sweep no-ops on an empty queue. To create it on a rebuilt box:

```bash
# Deploy the script pair, then create the no-agent cron.
scp docs/agents/hermes/scripts/context-sweep.{sh,ts} <box>:~/.hermes/scripts/
hermes cron create "every 60m" --no-agent --script context-sweep.sh --deliver local
```

## The `--no-agent` catalogue-backfill cron (PREPARED, NOT YET WIRED)

`fluncle-backfill` repairs the two music-graph side-channels over already-published findings: the **Discogs** release-id resolve and the **Last.fm love**. Like enrichment it carries no prompt — it is pure HTTP driving (zero LLM tokens) — so it is a `--no-agent --script` job. Its source lives beside the enrich sweep at [`../scripts/`](../scripts/): `backfill-sweep.sh` (the bash entry the runner execs by extension) → `backfill-sweep.ts` (the bun orchestrator).

**The Worker-paced model.** The box holds **no** Discogs/Last.fm vendor keys (those live in the Worker). So the backfill API calls happen **in the Worker**; this driver just **paces** it — one small bounded batch of each source per tick (default `--limit 6`). The Worker carries the per-finding **reliability state** and the **Retry-After backoff**, so the box driver stays dumb and the next tick resumes from durable state. This is what stops the old 429-storm.

| Job                | Schedule  | What it does                                                                                                                                                                                                                                                                                                                  | Server slice                                                    |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `fluncle-backfill` | every 30m | Drive one paced batch of `admin backfills discogs` + `admin backfills lastfm` (each `--limit 6`). The Worker resolves/loves only findings the per-finding reliability gate hasn't done or isn't cooling down, respects each vendor's `Retry-After`, and records the outcome. Idempotent; no-op once the catalogue is drained. | The reliability columns + Retry-After backoff in `backfill.ts`. |

**Every 30m, not 5m:** unlike `fluncle-enrich` (latency-sensitive for new finds), the backfill is a one-time catalogue repair. The 24h base cooldown means a done/tried finding isn't re-hit for a day, so the sweep drains over hours and then goes quiet; a 30m gap lets each vendor's per-minute budget fully recover between ticks. 6 findings/source/tick × 48 ticks/day comfortably drains the backlog within days while never bursting the vendor budget.

> **Token tier — resolved: agent tier.** The backfills were reclassified from operator to **agent** tier in the Worker route guard (`adminAuth` only, no `operatorGuard`): they are internal + reversible — loving is idempotent, Discogs ids are internal enrichment, neither publishes — so this is a safe role-boundary move that keeps the box **low-privilege**. The box's existing **agent-scoped** token drives the sweep; no operator token on the box (the cleaner long-term fit, matching the `fluncle-enrich` precedent).

To create it on a rebuilt box (after the token tier above is resolved):

```bash
# Deploy the script pair, then create the no-agent cron.
scp docs/agents/hermes/scripts/backfill-sweep.{sh,ts} <box>:~/.hermes/scripts/
hermes cron create "every 30m" --no-agent --script backfill-sweep.sh --deliver local
```

| Job              | Schedule | What it does                                                                                                                                                                                                                                                                   | Server slice                                   |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `fluncle-enrich` | every 5m | Drain `admin tracks enrich --queue`; per finding (bounded batch, cap 4/tick): `tracks get` → `analyze-track.ts` (ffmpeg + DSP on the box) → `admin tracks update --bpm [--key] --features --status done` (or `--status failed` when no preview). Idempotent; no-op when empty. | The existing `admin tracks update` write-back. |

**Every 5m, not hourly:** the sweep burns no tokens and no-ops on an empty queue, so it runs far more often than the hourly agent crons — a new find enriches within minutes. The Worker-side Spinup trigger + SDK + secrets have been **removed** (this is the only path that enriches a find). The image carries `ffmpeg` + `bun`, and the `fluncle-track-enrichment` skill is installed under `~/.hermes/skills/` (→ `/opt/data/skills/`). To recreate it on a rebuilt box:

```bash
# Deploy the script pair, then create the no-agent cron.
scp docs/agents/hermes/scripts/enrich-sweep.{sh,ts} <box>:~/.hermes/scripts/
hermes cron create "every 5m" --no-agent --script enrich-sweep.sh --deliver local
```

## The HYBRID `--no-agent` observation cron (PREPARED, NOT YET WIRED)

`fluncle-observation` renders the spoken recovered-audio observation per finding. Unlike the four pure-trigger sweeps above, this one is a **hybrid**: the queue read, the per-finding metadata gather, and the render delivery are all **deterministic** (the `fluncle` CLI), and only the creative authoring — turning a finding's facts into a script in Fluncle's voice — runs **one `claude -p` call** in the middle. So it is a `--no-agent --script` job like the others (a deterministic wrapper ships the stdout summary), but it spends a little model time on the one step that genuinely needs it. This replaces the old full-**agent** `fluncle-observation` cron (a whole Sonnet session per tick just to drain a queue and POST per finding). Its source lives beside the other sweeps at [`../scripts/`](../scripts/): `observe-sweep.sh` (the bash entry the runner execs by extension) → `observe-sweep.ts` (the bun orchestrator).

**The proven authoring call (the one agentic step).** The middle step is exactly the invocation a live spike validated on the box: the prompt on **stdin** to

```bash
claude -p --model "$OBSERVE_CLAUDE_MODEL" --allowedTools "Read,Glob,Grep" --output-format json
```

— Claude Code on **subscription auth** (`CLAUDE_CODE_OAUTH_TOKEN`, **zero OpenRouter tokens**), with **read-only** tools so it can load the installed `copywriting-fluncle` skill for the voice and read nothing it can mutate. The orchestrator parses the JSON envelope and takes its `.result` field as the script. The **script** then posts that text via `fluncle admin tracks observe <id> --script-file <tmp> --json`; the **Worker** re-scans it (the server-side voice gate), renders ElevenLabs, uploads `observation.{mp3,txt,json}` to R2, and writes back. Claude never posts — it only authors.

**Inputs (deterministic).** The PRIMARY authoring fuel is the finding's stored `context_note` — the firecrawl facts the context sweep distilled (release context, scene, label history). It's read via `fluncle admin tracks context <id> --json`, which returns the stored note (`skipped: true`, NO re-fetch) for a finding that already has one — and every queue item does (`hasContext=true`), so it's a cheap read with no side effect. The finding's identity metadata (`fluncle track get <id> --json`: artists, title, label, release year, galaxy, vibe) is the supporting identity the prose hangs on. A blank or unreadable note degrades gracefully to identity-only authoring. The note is internal creative fuel (never published); the observe endpoint re-scans the authored script through the voice gate at delivery.

| Job                   | Schedule  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Server slice                                                           |
| --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `fluncle-observation` | every 60m | Drain `admin tracks observe --queue` (`hasContext=true AND hasObservation=false`, oldest-first); per finding (bounded batch, cap **3**/tick — observation costs ElevenLabs credits + subscription quota): `track get` → `claude -p` authors the recovered-audio script (read-only tools, `copywriting-fluncle`) → `admin tracks observe --script-file` (the Worker voice-gates + renders + stores). A gate reject is skipped (stays queued). Idempotent; no-op when empty. | `observe_track` flipped to agent tier + `hasObservation` filter (#86). |

**Env knobs.** `OBSERVE_CLAUDE_MODEL` (default `claude-sonnet-4-6`); `OBSERVE_CLAUDE_EFFORT` (optional, passed as `--effort` when set); `DISCORD_ALERT_WEBHOOK` (optional, the claude-auth-failed ping target).

**The claude-auth ping.** If `claude -p` fails with an **auth/quota** signature (distinct from a transient model hiccup — the detection is narrow), the sweep **stops the batch**, leaves the queue **intact** (no data lost — the queue is the durable worklist), and emits a loud `{ ok:false, reason:"claude_auth", … }` summary line plus a best-effort POST to `DISCORD_ALERT_WEBHOOK` ("Fluncle observe-sweep: claude auth failed, re-auth needed") when that env is set. An absent webhook still leaves the loud summary + a nonzero exit.

**Production pre-reqs.** Beyond the image's bun + `fluncle` CLI, the box needs: the `claude` (Claude Code) CLI on PATH and authed via `CLAUDE_CODE_OAUTH_TOKEN` in the cron env (subscription auth), and the `copywriting-fluncle` skill installed for claude-code under `~/.claude/skills/`. `observe_track` is **agent tier** (#86), so the box's existing agent-scoped token drives the delivery POST; no operator token. To create it on a rebuilt box:

```bash
# Deploy the script pair, then create the hybrid no-agent cron.
scp docs/agents/hermes/scripts/observe-sweep.{sh,ts} <box>:~/.hermes/scripts/
hermes cron create "every 60m" --no-agent --script observe-sweep.sh --deliver local --name fluncle-observation
```

**Every 60m, not 5m:** observation is the paid step (ElevenLabs credits + subscription quota), and its input is the context note the hourly context sweep produces — so an hourly cadence keeps the two in step. The cap-3 batch keeps a tick cheap; a fresh eligible finding is caught next tick.

## The agent crons — PREPARED, NOT YET WIRED

The ONE remaining AGENT job in [`jobs.json`](./jobs.json) — the weekly newsletter — is drafted but **not yet wired on the box** (`docs/hermes-automation-brief.md`, Build order #2–#3). The operator wires it on the devbox. (The context-note step is the `--no-agent` `fluncle-context-note` sweep above, and the observation step is the HYBRID `--no-agent` `fluncle-observation` sweep above — neither is an agent job any more.)

| Job                  | Schedule     | What it does                                                                                                                                                                                                         | Server slice                                                                                                           |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fluncle-newsletter` | `0 15 * * 5` | Friday 15:00 Amsterdam (box-TZ pinned): read the discovery window, author the edition (Sonnet + `copywriting-fluncle`), persist a DRAFT via `admin newsletter draft`, then offer a `clarify` Send button in Discord. | `create_edition` (admin tier) + `send_edition` (operator tier) + `list_editions_admin` (admin tier, drafts inclusive). |

The newsletter is the one cron that is **`deliver: discord`** (not `local`): the Friday edition is a crew-feed moment AND the send gate is a `clarify` button the operator must see and tap. It is also the one cron on a **cron expression** (`0 15 * * 5`) rather than an interval, so it depends on the box clock being pinned to `Europe/Amsterdam` — see [The newsletter cron's two extras](#the-newsletter-crons-two-extras-dst--the-clarify-send-gate).

## The newsletter cron's two extras: DST + the clarify send gate

The `--no-agent` sweeps (enrich, context, observation, backfill) are plain box-clock-agnostic intervals. The Friday newsletter adds two mechanics the others don't have:

- **DST-aware Friday 15:00 Amsterdam — solved by the BOX CLOCK, not a TZ field.** Hermes cron has **no per-job timezone** (verified against the upstream cron docs: schedules are relative / `every Nh` / a cron expression / an ISO timestamp, all evaluated against the box clock). So `0 15 * * 5` fires at 15:00 in whatever timezone the box clock reads. To hit 15:00 Amsterdam correctly through the CET⇄CEST flip, **pin the box to `Europe/Amsterdam`** (`TZ=Europe/Amsterdam` on `docker run`, or the host `/etc/localtime`); the OS tz database then handles DST and `0 15 * * 5` is always 15:00 Amsterdam, summer or winter, with zero app-level DST logic. The hourly intervals (enrich/context/observation) are TZ-agnostic, so this pin is invisible to them — but any **future absolute-time cron inherits Amsterdam-local**, so document new ones as such. _Smoke-test before relying on it:_ schedule a one-shot `0 <next-minute> * * *` and confirm it fires at the Amsterdam-local minute; if it evaluates UTC regardless, fall back to two seasonal entries (`0 13 * * 5` summer + `0 14 * * 5` winter, each season-guarded).
- **The `clarify` send gate — persist-then-offer.** The send stays operator-gated: the agent token gets a 403 on `send_edition` server-side, so the cron **cannot** send. Instead it **persists the draft first** (the durable artifact — a missed button never loses the authored work), then calls the built-in `clarify` tool to render a tappable **Send / Hold** button in Discord and blocks for the tap. On **Send** → the agent runs `fluncle admin newsletter send <id>`. On **Hold** or the clarify timeout sentinel (default 600s) → it treats silence as Hold (**never** auto-sends — silence is not consent for a publish-class action); the draft is saved and re-offered on the next Friday tick (the cron's step 1 reads `admin newsletter list` for an unsent draft before authoring a new one). `clarify_timeout` is **global** `agent.` config (not per-call), so keep the default and lean on persist-first + re-offer rather than a long block. _Verify `clarify` is reachable in a `deliver: discord` cron session_ (it is a built-in toolset; a dry run from a scheduled tick settles it).

## The cron mechanism (verified against upstream)

Source: <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron> (fetched 2026-06-21).

- **Where jobs live:** `~/.hermes/cron/jobs.json` on the box. Per-run output is saved to `~/.hermes/cron/output/{job_id}/{timestamp}.md`. (Crons are **not** in `config.yaml` — `config.yaml` only carries cron _defaults_ like `cron.wrap_response` / `cron.script_timeout_seconds`.)
- **Scheduler:** the gateway ticks every 60 s and runs any due job in a **completely fresh, isolated agent session**. The prompt must be self-contained — there is no carried conversation. That is why each `prompt` below restates its whole task.
- **Schedule formats:** relative one-shot (`30m`, `2h`), recurring interval (`every 1h`, `every 5m`), cron expression (`0 * * * *`), or ISO timestamp. The `--no-agent` sweeps use `every 5m` (enrich), `every 30m` (backfill), and `every 60m` (context-note and observation); the weekly newsletter uses a cron expression `0 15 * * 5` (Friday 15:00, evaluated against the **box clock** — which is why the box is pinned to `Europe/Amsterdam`; there is no per-job TZ field).
- **Agent job vs. no-agent job:** an **agent** job carries a `prompt` and reasons through the task (the one agent job left — the weekly newsletter, which authors the edition copy). A **no-agent** job carries `no_agent: true` + a `script` and ships its stdout (the `fluncle-enrich`, `fluncle-backfill`, `fluncle-context-note`, and `fluncle-observation` sweeps). The first three burn **zero** LLM tokens; `fluncle-observation` is the **hybrid** — its script spends one `claude -p` call (subscription auth) on the creative authoring step, deterministic everywhere else.
- **Delivery (`deliver`):** `local` saves the run output under `~/.hermes/cron/output/` with no chat post; `origin`, `discord`, `discord:#channel`, etc. post to a channel; `all` fans out. The queue-drain crons are silent, so they're `local`; the **newsletter is `discord`** (a crew-feed moment, and the `clarify` Send button needs a channel the operator sees).
- **Chaining (`context_from`):** a job can prepend another job's most recent output as context. **Not used** here: the context-note → observation handoff is durable **server state** (the stored `context_note`), not cron-run output, so the observation sweep reads the queue directly rather than chaining off the context cron's stdout. (This is intentional — chaining would couple the two jobs' ticks; the queue decouples them, which is the whole point of the context⊥observation split.)
- **Repeat:** intervals (`every 1h`) and cron expressions repeat **forever** by default; a one-shot runs once. `repeat: <n>` caps the run count. Left `null` here (forever).

## How the operator wires these on the box

**Do not hand-copy `jobs.json` onto the box as the canonical file.** Upstream supports hand-editing it, but the recommended path is to let Hermes create each job through its `cronjob` tool so it assigns the `id` + `next_run_at` and keeps the file well-formed. Recreate each job from this directory's `jobs.json` using one of:

```bash
# On the devbox, over SSH on the tailnet (address in the operator's ops notes).
# The ONE agent job left is the newsletter (first arg is the schedule, second is the prompt).
# (The context-note + observation steps are `--no-agent` script sweeps now — see their sections above.)
# The newsletter: a cron expression, delivered to Discord (the Send button needs a channel).
# Pin the box clock to Europe/Amsterdam FIRST (see "The newsletter cron's two extras").
hermes cron create "0 15 * * 5" "<prompt from jobs.json: fluncle-newsletter>"   --deliver discord
```

or ask the running bot in Discord (`/cron add "0 15 * * 5" "<prompt>"`), or in natural conversation. After creating, confirm with `hermes cron list` and check `~/.hermes/cron/jobs.json`.

### Before wiring (gates from the brief)

1. **CLI admin naming rename — landed (#88, refined by the Convention-B cleanup).** The crons invoke via the `fluncle` CLI; the context command is `fluncle admin tracks context <id|logId>` and the queue shows are the `context --queue` / `observe --queue` worklist views (Convention B §6.4 — no `*-queue` commands). Every job prompt here is pinned to those names.
2. **Smoke-test each command by hand on the box** with the agent token before scheduling it, so a scheduled run isn't the first time it executes:
   - `fluncle admin tracks enrich --queue --json --limit 1` → expect `{ "ok": true, ... }` (the queue the live `--no-agent` sweep already reads).
   - `fluncle admin tracks context --queue --json --limit 1` → expect `{ "ok": true, "tracks": [...] }` (the worklist the `--no-agent` context sweep reads).
   - `fluncle admin tracks context <id> --json` against one `hasContext=false` finding → expect a quiet `context_note` write (no `updated_at` bump).
   - `fluncle admin tracks observe --queue --json --limit 1` → expect `{ "ok": true, "tracks": [...] }` (the worklist the hybrid observation sweep reads).
   - `fluncle admin tracks observe <id> --script-file <one short test script> --json` against one eligible finding → expect a rendered `observation.{mp3,txt,json}` and the voice gate passing.
   - **Observation (the hybrid sweep's authoring step):** `printf 'Say hello in one short sentence.' | claude -p --model "$OBSERVE_CLAUDE_MODEL" --allowedTools "Read,Glob,Grep" --output-format json` → expect a JSON envelope with a non-empty `.result` and **zero OpenRouter spend** (subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`). Confirm the `copywriting-fluncle` skill is installed for claude-code under `~/.claude/skills/`.
   - **Newsletter:** `fluncle admin newsletter list --json` → expect `{ "ok": true, editions: [...] }` (drafts inclusive). Then author one edition end-to-end by hand: `fluncle admin newsletter draft --content-file <edition.json> --subject "<test>" --window-since <iso> --window-until <iso> --json` → expect a `draft` row with a sane `content`. Do NOT send yet. Confirm the agent token gets a **403** on `fluncle admin newsletter send <id> --json` (the operator gate); the operator fires the real send.
3. **Claude Code on the box (observation).** The hybrid observation sweep needs the `claude` CLI on PATH, authed via `CLAUDE_CODE_OAUTH_TOKEN` in the cron env (subscription auth — NOT OpenRouter), and the `copywriting-fluncle` skill installed for claude-code under `~/.claude/skills/`. Optionally set `OBSERVE_CLAUDE_MODEL` (default `claude-sonnet-4-6`), `OBSERVE_CLAUDE_EFFORT`, and `DISCORD_ALERT_WEBHOOK` (the claude-auth-failed ping target) in the cron env.
4. **Box timezone (newsletter).** Pin the box to `Europe/Amsterdam` (`TZ` env on `docker run`, or host `/etc/localtime`) and run the one-shot smoke test from [the newsletter extras](#the-newsletter-crons-two-extras-dst--the-clarify-send-gate) before scheduling `0 15 * * 5`. Confirm the recurring intervals are unaffected.
5. **The `clarify` gate, dry (newsletter).** From the running bot, exercise `clarify("Send edition #N?", [Send, Hold])` in Discord; confirm the buttons render, Hold no-ops, and the timeout sentinel is handled — and that `clarify` is reachable from a `deliver: discord` cron session (not just an interactive DM).
6. **Watch the first few ticks** — `~/.hermes/cron/output/{job_id}/*.md` and `~/.hermes/logs/`. The observation sweep costs ElevenLabs credits + subscription quota per render; confirm the per-tick batch is small (cap 3) and the queue drains as expected before walking away.

### Verify it's healthy

- `hermes cron list` shows `fluncle-enrich` (live) plus the `fluncle-context-note` / `fluncle-backfill` / `fluncle-observation` sweeps and the `fluncle-newsletter` agent job, each with a sane `next_run_at`.
- After a tick, each job's `~/.hermes/cron/output/{job_id}/` has a fresh run with the expected one-line summary (and a no-op when its queue is empty).
- Wire the context-note sweep first (cheaper, no paid render — it only triggers the Worker), then the observation (after the claude/skill pre-reqs above), then the newsletter (gate it on the box-TZ pin + one good hand-authored edition end-to-end first, per `docs/agents/newsletter-agent.md`).
- The newsletter's first live send goes to a **seed/operator-only audience first** (per the RFC's de-risk step) to validate DKIM + the unsubscribe link before any subscriber sees it.

## Keeping this in step

The **newsletter** (`fluncle-newsletter`, agent cron), the **catalogue backfills** (`fluncle-backfill`, `--no-agent` cron), and the **hybrid observation sweep** (`fluncle-observation`, `--no-agent` with one `claude -p` authoring step) have now landed (above); wire them on the box per [How the operator wires these](#how-the-operator-wires-these-on-the-box). Decommission the Spinup newsletter agent (`fluncle-s-newsletter-97bwtd`) + its keys only **after** one good Friday edition has shipped from Hermes — same prove-then-tear-down discipline as the enrichment cutover.
