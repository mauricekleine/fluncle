# Hermes automation crons — PREPARED, NOT YET DEPLOYED

These are the version-controlled **source** for the three Hermes automation cron jobs (`docs/hermes-automation-brief.md`, Build order #1–#3). **Nothing here is live on the box.** The repo is canonical; the box is a deploy target (see the `fluncle-hermes-operator` skill). The operator wires these on the devbox — this directory records the canonical intent so a rebuilt box can be made to match.

The three crons are the queue-driven backbone the brief specifies — no on-add push, every step is a "read a queue → act per item, idempotently" loop over the `fluncle` CLI, hourly. A new finding is caught on the next tick.

| Job                        | Schedule | What it does                                                                                                                                                                | Server slice                                                           |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `fluncle-enrich-self-heal` | every 1h | `fluncle admin tracks enrich --all` — backstop for enrichment that slipped the on-add trigger.                                                                              | `enrich_track` already on the agent tier (#77).                        |
| `fluncle-context-note`     | every 1h | Drain `hasContext=false`, call the context endpoint per finding (Worker-side Firecrawl), write `context_note` quietly.                                                      | `observe_context` agent-tier endpoint + `hasContext` filter (#86).     |
| `fluncle-observation`      | every 1h | Drain `hasContext=true AND hasObservation=false`; author the recovered-audio script (Sonnet + `copywriting-fluncle`) from the stored context note, then `observe --script`. | `observe_track` flipped to agent tier + `hasObservation` filter (#86). |

NOT included (deliberately, per the brief): the Last.fm / Discogs **backfills** (their reliability columns — `lastfmLovedAt`, `discogsStatus` — are not built yet) and the **newsletter** (owned by its own RFC).

## The cron mechanism (verified against upstream)

Source: <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron> (fetched 2026-06-21).

- **Where jobs live:** `~/.hermes/cron/jobs.json` on the box. Per-run output is saved to `~/.hermes/cron/output/{job_id}/{timestamp}.md`. (Crons are **not** in `config.yaml` — `config.yaml` only carries cron _defaults_ like `cron.wrap_response` / `cron.script_timeout_seconds`.)
- **Scheduler:** the gateway ticks every 60 s and runs any due job in a **completely fresh, isolated agent session**. The prompt must be self-contained — there is no carried conversation. That is why each `prompt` below restates its whole task.
- **Schedule formats:** relative one-shot (`30m`, `2h`), recurring interval (`every 1h`, `every 2h`), cron expression (`0 * * * *`), or ISO timestamp. These three use `every 1h`.
- **Agent job vs. no-agent job:** an **agent** job carries a `prompt` and reasons through the task (these three — they read a queue and act per item, and the observation one authors copy). A **no-agent** job carries `no_agent: true` + a `script` and ships its stdout, skipping the LLM (watchdogs / heartbeats — not used here).
- **Delivery (`deliver`):** `local` saves the run output under `~/.hermes/cron/output/` with no chat post; `origin`, `discord`, `discord:#channel`, etc. post to a channel; `all` fans out. These are silent self-heal loops, so they're set to `local`. Switch to `discord` if you want a per-run digest in the crew feed.
- **Chaining (`context_from`):** a job can prepend another job's most recent output as context. **Not used** here: the context-note → observation handoff is durable **server state** (the stored `context_note`), not cron-run output, so the observation cron reads the queue directly rather than chaining off the context cron's stdout. (This is intentional — chaining would couple the two jobs' ticks; the queue decouples them, which is the whole point of the context⊥observation split.)
- **Repeat:** intervals (`every 1h`) and cron expressions repeat **forever** by default; a one-shot runs once. `repeat: <n>` caps the run count. Left `null` here (forever).

## How the operator wires these on the box

**Do not hand-copy `jobs.json` onto the box as the canonical file.** Upstream supports hand-editing it, but the recommended path is to let Hermes create each job through its `cronjob` tool so it assigns the `id` + `next_run_at` and keeps the file well-formed. Recreate each job from this directory's `jobs.json` using one of:

```bash
# On the devbox, over SSH on the tailnet (address in the operator's ops notes).
# CLI form — one per job (name → first arg is the schedule, second is the prompt):
hermes cron create "every 1h" "<prompt from jobs.json: fluncle-enrich-self-heal>" --deliver local
hermes cron create "every 1h" "<prompt from jobs.json: fluncle-context-note>"     --deliver local
hermes cron create "every 1h" "<prompt from jobs.json: fluncle-observation>"       --deliver local
```

or ask the running bot in Discord (`/cron add "every 1h" "<prompt>"`), or in natural conversation. After creating, confirm with `hermes cron list` and check `~/.hermes/cron/jobs.json`.

### Before wiring (gates from the brief)

1. **CLI admin naming rename must land first** (the brief's sole remaining green-light gate, Convention B §4 — sibling PR branch `cli/observe-context-crons`). The crons invoke via the `fluncle` CLI; don't wire a cron to a command name about to move. The context-note job carries a `TODO(cli-rename)` marker — pin the real CLI verb there once the rename merges.
2. **Smoke-test each command by hand on the box** with the agent token before scheduling it, so a scheduled run isn't the first time it executes:
   - `fluncle admin tracks enrich --all --json` → expect `{ "ok": true, ... }`.
   - the context-note fetch (CLI verb per #1, or the `observe_context` endpoint) against one `hasContext=false` finding → expect a quiet `context_note` write.
   - `fluncle admin tracks observe <id> --script-file <one short test script> --json` against one eligible finding → expect a rendered `observation.{mp3,txt,json}` and the voice gate passing.
3. **Watch the first few ticks** — `~/.hermes/cron/output/{job_id}/*.md` and `~/.hermes/logs/`. The observation cron costs ElevenLabs credits per render; confirm the per-tick batch is small and the queue drains as expected before walking away.

### Verify it's healthy

- `hermes cron list` shows all three with a sane `next_run_at`.
- After an hour, each job's `~/.hermes/cron/output/{job_id}/` has a fresh run with the expected one-line summary (and a no-op when its queue is empty).
- The enrich job is the cheapest and safest — enable it first to prove the pattern (brief Build order #1), then the context-note, then the observation.

## Keeping this in step

When the CLI rename lands, update the `TODO(cli-rename)` in `jobs.json`, recreate the affected job on the box, and re-verify. When the backfill reliability columns + the newsletter ship, add their crons here too (the brief and the `fluncle-hermes-operator` skill carry the same reminder).
