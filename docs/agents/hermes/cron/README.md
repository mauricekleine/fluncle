# Hermes automation crons

The version-controlled **source** for the Hermes automation cron jobs (`docs/hermes-automation-brief.md`). The repo is canonical; the box is a deploy target (see the `fluncle-hermes-operator` skill). This directory records the canonical intent so a rebuilt box can be made to match.

Every step is a "read a queue → act per item, idempotently" loop over the `fluncle` CLI. There is **no on-add push**: a new find lands at `enrichment_status = pending` (queue-eligible) and is caught on the next tick.

## The `--no-agent` enrichment cron (LIVE)

`fluncle-enrich` is **live on the box**. It does not carry a prompt: enrichment is pure compute (get → analyze → update, zero LLM tokens), so it is a `--no-agent --script` job. Its script source lives beside the build context at [`../scripts/`](../scripts/) — a bash wrapper (`enrich-sweep.sh`) the cron runner execs by extension, which in turn `exec`s the bun orchestrator (`enrich-sweep.ts`). It is created on the box directly (not in `jobs.json`, which holds the agent jobs).

## The `--no-agent` catalogue-backfill cron (PREPARED, NOT YET WIRED)

`fluncle-backfill` repairs the two music-graph side-channels over already-published findings: the **Discogs** release-id resolve and the **Last.fm love**. Like enrichment it carries no prompt — it is pure HTTP driving (zero LLM tokens) — so it is a `--no-agent --script` job. Its source lives beside the enrich sweep at [`../scripts/`](../scripts/): `backfill-sweep.sh` (the bash entry the runner execs by extension) → `backfill-sweep.ts` (the bun orchestrator).

**The Worker-paced model.** The box holds **no** Discogs/Last.fm vendor keys (those live in the Worker). So the backfill API calls happen **in the Worker**; this driver just **paces** it — one small bounded batch of each source per tick (default `--limit 6`). The Worker carries the per-finding **reliability state** and the **Retry-After backoff**, so the box driver stays dumb and the next tick resumes from durable state. This is what stops the old 429-storm.

| Job                | Schedule  | What it does                                                                                                                                                                                                                                                                                                                  | Server slice                                                    |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `fluncle-backfill` | every 30m | Drive one paced batch of `admin backfills discogs` + `admin backfills lastfm` (each `--limit 6`). The Worker resolves/loves only findings the per-finding reliability gate hasn't done or isn't cooling down, respects each vendor's `Retry-After`, and records the outcome. Idempotent; no-op once the catalogue is drained. | The reliability columns + Retry-After backoff in `backfill.ts`. |

**Every 30m, not 5m:** unlike `fluncle-enrich` (latency-sensitive for new finds), the backfill is a one-time catalogue repair. The 24h base cooldown means a done/tried finding isn't re-hit for a day, so the sweep drains over hours and then goes quiet; a 30m gap lets each vendor's per-minute budget fully recover between ticks. 6 findings/source/tick × 48 ticks/day comfortably drains the backlog within days while never bursting the vendor budget.

> **Token tier (must resolve before wiring).** The backfills are **operator-tier** (`requireOperator` — "credentials / bulk mutation" in the [hermes-agent roles](../../hermes-agent.md#roles-operator-vs-agent) table), but the box normally holds only the **agent-scoped** token. An agent-token sweep is **403'd server-side**. So either (a) provision an **operator-scoped** token for _this cron only_ in `/etc/hermes.env` (deviates from "the box never holds the operator token" — weigh the blast radius), or (b) reclassify the backfills to **agent** tier in the Worker route guard (they are internal + reversible: loving is idempotent, Discogs ids are internal enrichment, neither publishes), which lets the existing agent token drive them. Option (b) is the cleaner long-term fit; it is a deliberate role-boundary change and is **out of scope for the PR that built this cron** — decide it before scheduling the job.

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

## The agent crons — PREPARED, NOT YET WIRED

The two AGENT jobs in [`jobs.json`](./jobs.json) are drafted but **not yet wired on the box** (`docs/hermes-automation-brief.md`, Build order #2–#3). The operator wires them on the devbox.

| Job                    | Schedule | What it does                                                                                                                                                                | Server slice                                                           |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `fluncle-context-note` | every 1h | Drain `hasContext=false` (`admin tracks context --queue`), call `admin tracks context` per finding (Worker-side Firecrawl), write `context_note` quietly.                   | `context_track` agent-tier endpoint + `hasContext` filter (#86/#88).   |
| `fluncle-observation`  | every 1h | Drain `hasContext=true AND hasObservation=false`; author the recovered-audio script (Sonnet + `copywriting-fluncle`) from the stored context note, then `observe --script`. | `observe_track` flipped to agent tier + `hasObservation` filter (#86). |

NOT included here (the Last.fm / Discogs **backfills** are now built — see the `--no-agent` `fluncle-backfill` cron above — and the **newsletter** is owned by its own RFC).

## The cron mechanism (verified against upstream)

Source: <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron> (fetched 2026-06-21).

- **Where jobs live:** `~/.hermes/cron/jobs.json` on the box. Per-run output is saved to `~/.hermes/cron/output/{job_id}/{timestamp}.md`. (Crons are **not** in `config.yaml` — `config.yaml` only carries cron _defaults_ like `cron.wrap_response` / `cron.script_timeout_seconds`.)
- **Scheduler:** the gateway ticks every 60 s and runs any due job in a **completely fresh, isolated agent session**. The prompt must be self-contained — there is no carried conversation. That is why each `prompt` below restates its whole task.
- **Schedule formats:** relative one-shot (`30m`, `2h`), recurring interval (`every 1h`, `every 5m`), cron expression (`0 * * * *`), or ISO timestamp. The two agent jobs use `every 1h`; the `--no-agent` enrich sweep uses `every 5m`.
- **Agent job vs. no-agent job:** an **agent** job carries a `prompt` and reasons through the task (the two hourly jobs — they read a queue and act per item, and the observation one authors copy). A **no-agent** job carries `no_agent: true` + a `script` and ships its stdout, skipping the LLM (the `fluncle-enrich` sweep is the one no-agent job).
- **Delivery (`deliver`):** `local` saves the run output under `~/.hermes/cron/output/` with no chat post; `origin`, `discord`, `discord:#channel`, etc. post to a channel; `all` fans out. These are silent queue-drain loops, so they're set to `local`. Switch to `discord` if you want a per-run digest in the crew feed.
- **Chaining (`context_from`):** a job can prepend another job's most recent output as context. **Not used** here: the context-note → observation handoff is durable **server state** (the stored `context_note`), not cron-run output, so the observation cron reads the queue directly rather than chaining off the context cron's stdout. (This is intentional — chaining would couple the two jobs' ticks; the queue decouples them, which is the whole point of the context⊥observation split.)
- **Repeat:** intervals (`every 1h`) and cron expressions repeat **forever** by default; a one-shot runs once. `repeat: <n>` caps the run count. Left `null` here (forever).

## How the operator wires these on the box

**Do not hand-copy `jobs.json` onto the box as the canonical file.** Upstream supports hand-editing it, but the recommended path is to let Hermes create each job through its `cronjob` tool so it assigns the `id` + `next_run_at` and keeps the file well-formed. Recreate each job from this directory's `jobs.json` using one of:

```bash
# On the devbox, over SSH on the tailnet (address in the operator's ops notes).
# CLI form — one per agent job (first arg is the schedule, second is the prompt):
hermes cron create "every 1h" "<prompt from jobs.json: fluncle-context-note>" --deliver local
hermes cron create "every 1h" "<prompt from jobs.json: fluncle-observation>"  --deliver local
```

or ask the running bot in Discord (`/cron add "every 1h" "<prompt>"`), or in natural conversation. After creating, confirm with `hermes cron list` and check `~/.hermes/cron/jobs.json`.

### Before wiring (gates from the brief)

1. **CLI admin naming rename — landed (#88, refined by the Convention-B cleanup).** The crons invoke via the `fluncle` CLI; the context command is `fluncle admin tracks context <id|logId>` and the queue shows are the `context --queue` / `observe --queue` worklist views (Convention B §6.4 — no `*-queue` commands). Every job prompt here is pinned to those names.
2. **Smoke-test each command by hand on the box** with the agent token before scheduling it, so a scheduled run isn't the first time it executes:
   - `fluncle admin tracks enrich --queue --json --limit 1` → expect `{ "ok": true, ... }` (the queue the live `--no-agent` sweep already reads).
   - `fluncle admin tracks context <id> --json` against one `hasContext=false` finding → expect a quiet `context_note` write (no `updated_at` bump).
   - `fluncle admin tracks observe <id> --script-file <one short test script> --json` against one eligible finding → expect a rendered `observation.{mp3,txt,json}` and the voice gate passing.
3. **Watch the first few ticks** — `~/.hermes/cron/output/{job_id}/*.md` and `~/.hermes/logs/`. The observation cron costs ElevenLabs credits per render; confirm the per-tick batch is small and the queue drains as expected before walking away.

### Verify it's healthy

- `hermes cron list` shows `fluncle-enrich` (live) plus the two agent jobs with a sane `next_run_at`.
- After an hour, each agent job's `~/.hermes/cron/output/{job_id}/` has a fresh run with the expected one-line summary (and a no-op when its queue is empty).
- Wire the context-note first (cheaper, no paid render), then the observation.

## Keeping this in step

When the newsletter ships, add its cron here too (the brief and the `fluncle-hermes-operator` skill carry the same reminder). The backfill reliability columns + their `fluncle-backfill` cron have landed (above).
