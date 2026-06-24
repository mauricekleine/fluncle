# Hermes automation crons

The version-controlled **source** for the Hermes automation cron jobs (`docs/hermes-automation-brief.md`). The repo is canonical; the box is a deploy target (see the `fluncle-hermes-operator` skill). This directory records the canonical intent so a rebuilt box can be made to match.

Every step is a "read a queue → act per item, idempotently" loop over the `fluncle` CLI. There is **no on-add push**: a new find lands at `enrichment_status = pending` (queue-eligible) and is caught on the next tick.

## Cron roster

Live on the box as of the **2026-06-23 cutover** (+ `fluncle-render` wired **2026-06-24**). Every per-finding job is `--no-agent`; the Friday newsletter is the only **agent** job left. `fluncle-render` (the video render conductor, below) conducts renders on a separate scale-to-zero box.ascii box (rave-03), not on the Hermes box itself. "Box authoring" is how much model time the job spends locally: none (a pure deterministic trigger), one `claude -p` call (a hybrid — subscription auth, zero OpenRouter), or a full agent session. Run `hermes cron list` on the box for live job IDs + next-run times.

| Job                    | Cadence             | Mode                   | Box authoring             | What it does                                                         |
| ---------------------- | ------------------- | ---------------------- | ------------------------- | -------------------------------------------------------------------- |
| `fluncle-enrich`       | every 5m            | `--no-agent`           | none (on-box DSP)         | BPM / key / spectral analysis on the box, write-back                 |
| `fluncle-context-note` | every 5m            | `--no-agent`           | none (Worker Haiku)       | Firecrawl facts → distilled `context_note` + a `Texture:` line       |
| `fluncle-note`         | every 10m           | `--no-agent` hybrid    | one `claude -p`           | auto-author the editorial `/log` note (fill-empty-only)              |
| `fluncle-observation`  | every 60m           | `--no-agent` hybrid    | one `claude -p`           | author the recovered-audio script → Worker ElevenLabs render         |
| `fluncle-backfill`     | every 30m           | `--no-agent`           | none (Worker HTTP)        | Discogs id + Last.fm love catalogue repair                           |
| `fluncle-render`       | every 60m           | `--no-agent` conductor | none (remote `claude -p`) | wake rave-03 → render + ship one finding's video → park (LIVE)       |
| `fluncle-newsletter`   | Fri 15:00 Amsterdam | **agent**              | full agent session        | draft + persist the weekly edition (send is an operator Discord tap) |

The per-cron sections below carry the full mechanism, schedule rationale, and the rebuild-from-scratch wiring for each.

## The `--no-agent` enrichment cron (LIVE)

`fluncle-enrich` is **live on the box**. It does not carry a prompt: enrichment is pure compute (get → analyze → update, zero LLM tokens), so it is a `--no-agent --script` job. Its script source lives beside the build context at [`../scripts/`](../scripts/) — a bash wrapper (`enrich-sweep.sh`) the cron runner execs by extension, which in turn `exec`s the bun orchestrator (`enrich-sweep.ts`). It is created on the box directly (not in `jobs.json`, which holds only the one remaining agent job, the newsletter).

## The `--no-agent` context-note cron (LIVE)

`fluncle-context-note` fills the **factual** context note for findings that lack one (the `context_note`), so the observation cron can author a grounded script later. It used to be a full **agent** cron that spent a whole Sonnet session just to drain a queue and POST per finding — pure harness tax (~37k prompt tokens/call to emit ~200). Its only real LLM work — distilling the note — already moved **Worker-side onto Haiku** (#129), so the box no longer needs an agent: it only asks the API what's queued and triggers the Worker endpoint per finding. It carries no prompt and burns **zero LLM tokens on the box**, so it is now a `--no-agent --script` job like enrich/backfill. Its source lives beside them at [`../scripts/`](../scripts/): `context-sweep.sh` (the bash entry the runner execs by extension) → `context-sweep.ts` (the bun orchestrator).

**The Worker-paced model.** The box holds **no** Firecrawl key (the Worker does), and the note-distilling LLM (Haiku) is Worker-side too. So the Firecrawl search + Haiku distill + the quiet `context_note` write all happen **in the Worker**; this driver just **triggers** it — one small bounded batch per tick (`BATCH_CAP` 6). `context_track` is **agent tier** (idempotent on `context:${logId}`), so the box's existing agent-scoped token drives it; no operator token on the box (matching the `fluncle-enrich`/`fluncle-backfill` precedent).

| Job                    | Schedule | What it does                                                                                                                                                                                                                                                | Server slice                                                              |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `fluncle-context-note` | every 5m | Drain `admin tracks context --queue` (`hasContext=false`, oldest-first); per finding (bounded batch, cap 6/tick): `admin tracks context <id>` → triggers the Worker (Firecrawl + Haiku distill + quiet `context_note` write). Idempotent; no-op when empty. | `context_track` agent-tier endpoint + `hasContext` filter (#86/#88/#129). |

**Every 5m, like enrich:** the sweep burns **no box tokens** (it only triggers the Worker per queued finding) and no-ops on an empty queue, so a tight cadence is cheap — it gets fresh `context_note` onto a new find within minutes, which is the fuel the downstream `note` + `observation` crons consume. The Worker's Firecrawl + Haiku cost is paid only when a finding is actually queued (rare; most ticks no-op), not per-tick. To create it on a rebuilt box:

```bash
# Deploy the script pair, then create the no-agent cron.
scp docs/agents/hermes/scripts/context-sweep.{sh,ts} <box>:~/.hermes/scripts/
hermes cron create "every 5m" --no-agent --script context-sweep.sh --deliver local
```

## The `--no-agent` catalogue-backfill cron (LIVE)

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

## The HYBRID `--no-agent` observation cron (LIVE)

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

**Production pre-reqs.** The image now carries the `claude` (Claude Code) CLI **and** the `copywriting-fluncle` skill (baked at `/opt/claude/skills/copywriting-fluncle`, discovered via `CLAUDE_CONFIG_DIR=/opt/claude` so the non-root cron user finds it regardless of its HOME — see the Dockerfile + `docs/agents/hermes-agent.md` § The image). So a rebuilt box has both already. The one run-time pre-req is the claude auth token — and it **cannot come from the cron env** (Hermes hard-blocks provider credentials; see **Operational gotchas** below). `observe-sweep.sh` sources it from a `0600` operator-placed file at `${HOME}/.observe-sweep.env` (= `/opt/data/home/.observe-sweep.env`) holding `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth, from `op://Fluncle/CLAUDE_CODE_OAUTH_TOKEN/credential`; **not** OpenRouter) plus optionally `DISCORD_ALERT_WEBHOOK` + `OBSERVE_CLAUDE_MODEL`. `observe_track` is **agent tier** (#86), so the box's existing agent-scoped token drives the delivery POST; no operator token. To create it on a rebuilt box:

```bash
# Deploy the script pair (~/.hermes is hermes-owned 700, so copy IN via docker cp, not scp):
docker cp observe-sweep.sh hermes:/opt/data/scripts/ && docker cp observe-sweep.ts hermes:/opt/data/scripts/
docker exec hermes chown 1000:1000 /opt/data/scripts/observe-sweep.* && docker exec hermes chmod +x /opt/data/scripts/observe-sweep.sh
# Place the 0600 secrets file the script sources (Hermes won't pass the token via env — see Gotchas).
# The value never prints; it flows op -> the file:
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(op read op://Fluncle/CLAUDE_CODE_OAUTH_TOKEN/credential)" \
  | ssh <box> 'docker exec -i hermes sh -c "cat > /opt/data/home/.observe-sweep.env && chown hermes:hermes /opt/data/home/.observe-sweep.env && chmod 600 /opt/data/home/.observe-sweep.env"'
# (append DISCORD_ALERT_WEBHOOK to the same file the same way — optional, for the auth-fail ping.)
hermes cron create "every 60m" --no-agent --script observe-sweep.sh --deliver local --name fluncle-observation
```

**Every 60m, not 5m:** observation is the paid step (ElevenLabs credits + subscription quota), and its input is the context note the hourly context sweep produces — so an hourly cadence keeps the two in step. **`BATCH_CAP=1`** (one finding per tick): the cron runner kills a job at 120s and a single `claude -p` authoring + ElevenLabs render already ≈ that budget (raise the cap only if a healthy run measures well under 120s, or lift `cron.script_timeout_seconds` in `config.yaml`). The queue drains across hourly ticks; a fresh eligible finding is caught next tick.

## The HYBRID `--no-agent` auto-note cron (LIVE)

`fluncle-note` auto-authors a finding's **written editorial note** — the line that shows on its `/log` page (today the operator writes it by hand). It is the written-note **sibling** of `fluncle-observation` and shares its exact hybrid shape: the queue read, the per-finding metadata + context-note gather, and the delivery are all **deterministic** (the `fluncle` CLI), and only the creative authoring — turning a finding's facts into a one-line editorial note in Fluncle's voice — runs **one `claude -p` call** in the middle. Source beside the others at [`../scripts/`](../scripts/): `note-sweep.sh` (the bash entry) → `note-sweep.ts` (the bun orchestrator).

**The authoring call (the one agentic step)** is identical in shape to observation's — prompt on **stdin**, `claude -p --model "$NOTE_CLAUDE_MODEL" --allowedTools "Read,Glob,Grep" --output-format json`, subscription auth, read-only tools so it can load `copywriting-fluncle` for the voice; the orchestrator takes the JSON `.result` as the note. The **script** then posts it via `fluncle admin tracks note <id> --script-file <tmp> --json`; the **Worker** re-scans it through the written-note voice gate and **fills an EMPTY note only** — an operator-written (or previously auto-authored) note is **never** clobbered (the call returns `skipped: true`, a clean no-op). Claude never posts — it only authors.

**Inputs (deterministic)** are the same as observation: the finding's stored `context_note` is the PRIMARY fuel (read via `admin tracks context <id>` — `skipped: true`, no re-fetch, for an already-context'd finding, which every queue item is), and `track get <id>` supplies the identity metadata. A blank/unreadable note degrades to identity-only authoring.

| Job            | Schedule  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Server slice                                               |
| -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `fluncle-note` | every 10m | Drain `admin tracks note --queue` (`hasContext=true AND hasNote=false`, oldest-first); per finding (bounded batch, cap **1**/tick): `track get` → `claude -p` authors the one-line editorial note (read-only tools, `copywriting-fluncle`) → `admin tracks note --script-file` (the Worker voice-gates + **fills an empty note only** + stores). An operator note already on file is a `skipped` no-op (the override wins); a gate reject is skipped (stays queued). Idempotent; no-op when empty. | `note_track` (agent tier) + `hasNote` filter (this slice). |

**Env knobs.** `NOTE_CLAUDE_MODEL` (default `claude-sonnet-4-6`); `NOTE_CLAUDE_EFFORT` (optional, passed as `--effort` when set); `DISCORD_ALERT_WEBHOOK` (optional, the claude-auth-failed ping target). **Production pre-reqs** match observation's: the `claude` CLI + `copywriting-fluncle` skill are baked into the image, and the token is **file-sourced** from a `0600` `${HOME}/.note-sweep.env` (Hermes hard-blocks provider creds from the cron env — see **Operational gotchas**), holding `CLAUDE_CODE_OAUTH_TOKEN` plus optionally `DISCORD_ALERT_WEBHOOK` / `NOTE_CLAUDE_MODEL`. `note_track` is **agent tier**, so the box's existing agent-scoped token drives the delivery POST. The auth-fail ping ("Fluncle note-sweep: claude auth failed, re-auth needed") and the **`BATCH_CAP=1`** under-120s rule are the same as observation. To wire it on a rebuilt box (mirror the observation block above, swapping `observe`→`note`):

```bash
docker cp note-sweep.sh hermes:/opt/data/scripts/ && docker cp note-sweep.ts hermes:/opt/data/scripts/
docker exec hermes chown 1000:1000 /opt/data/scripts/note-sweep.* && docker exec hermes chmod +x /opt/data/scripts/note-sweep.sh
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(op read op://Fluncle/CLAUDE_CODE_OAUTH_TOKEN/credential)" \
  | ssh <box> 'docker exec -i hermes sh -c "cat > /opt/data/home/.note-sweep.env && chown hermes:hermes /opt/data/home/.note-sweep.env && chmod 600 /opt/data/home/.note-sweep.env"'
hermes cron create "every 10m" --no-agent --script note-sweep.sh --deliver local --name fluncle-note
```

## The render conductor cron (LIVE)

**Live as of 2026-06-24** — image `fluncle-hermes:v2026.6.24` bakes the box.ascii CLI + `openssh-client` + `fluncle@0.60.0`; the `fluncle-render` cron is wired (`every 60m`) and proven end-to-end (authed → provisioned a fresh render box from `main` → triggered a detached render → a second tick held on single-flight). Wiring it surfaced several box.ascii CLI realities now handled in the Dockerfile + scripts — see [§ box.ascii CLI quirks (handled)](#boxascii-cli-quirks-handled) at the end of this section.

`fluncle-render` drives the per-finding VIDEO render — but unlike every other sweep (which runs its whole job inside the Hermes box) it is a **conductor**: the Hermes box has no GPU and no Remotion toolchain, so it wakes a separate **scale-to-zero box.ascii render box (rave-03)**, triggers the `@fluncle-video` render of exactly one queued finding _there_ via a remote `claude -p`, and parks the box when the render finishes. The render box renders + **ships to R2 / the website** (sets `video_url`); it **never posts to social** — enforced twice over: the render-queue prompt's hard rail says don't, AND the server-side role boundary makes it impossible (the box carries only the `agent`-scoped token, and `track draft --platform youtube` / every publish-class route is operator-tier → 403, so a misbehaving render agent _cannot_ post). Source at [`../scripts/`](../scripts/): `render-conductor.sh` (the cron entry), `provision-rave-03.sh` (reproduces the render box from clean `main`), `render-detached.sh` (runs on the render box).

**Why a STATE MACHINE, not a blocking job.** A swangle (software-GL) render runs ~85 min, but the `--no-agent` runner kills any job at ~120s (§ Operational gotchas). So the conductor cannot block on the render. Instead the render runs **DETACHED on the render box** (it survives a Hermes container restart — decoupled), and each conductor tick is a quick (<120s) step in a two-state machine persisted under `~/.render-conductor/`:

- **RENDERING** → poll the box for `~/conductor-run.done`; STOP (snapshot) the box when present, return to idle. Still running → NO-OP. Past 2.5h → force-park (stuck guard).
- **IDLE** → if past the hourly start gate AND the queue is non-empty: resume the parked box (or reprovision if box.ascii reclaimed it), inject creds, trigger one detached render → rendering.

**Single-flight (no two renders at once — the hard requirement).** The STATE enforces it (only `idle` starts a render; a `rendering` tick only polls), and an atomic `mkdir` lock is a second guard so two ticks never race the state file (with a stale-lock breaker for a tick the 120s runner killed mid-hold — `flock` is deliberately avoided, it is not portable and adds a util-linux dep). Because a render (~85m) outlasts the hourly tick, the `rendering` no-op branch fires every cycle: it is the primary safety, exercised continuously, not a rare net.

**Cadence + billing.** Hourly: a render STARTS at most once per `START_INTERVAL` (3600s). Because a render finishes mid-interval and the next hourly tick parks the box, there is up to ~35 min of idle-wait per render — worst case ~480 of the 555 box-hours/month on the $20 tier, far less in practice (every tick no-ops once the queue is caught up). Tune `START_INTERVAL` if it ever bites.

**Scale-to-zero + reprovision.** box.ascii reclaims idle boxes AND their snapshots past the archive window, so the render box is **not durable state**. The conductor stores the box id and tries `box resume`; on a 404 it runs `provision-rave-03.sh` — a purge is a ~5-min non-event. `box new --no-auto-stop` (box.ascii rejects `--no-auto-stop` combined with `--ttl`, so there is **no** box-side lifetime backstop — the conductor is the sole stop authority): the conductor owns stop/resume, which it MUST — idle auto-stop could fire during a claude-thinking gap and kill a render, AND the conductor poll-detects "done" by ssh'ing the RUNNING box, so the box has to stay up until the conductor explicitly parks it. A conductor that dies entirely mid-render leaves a running box — mitigated by the container restart policy + the hourly stuck-guard (`MAX_RENDER` force-stop), else an operator cleanup.

**Secrets.** `FLUNCLE_API_TOKEN` (agent-scoped) arrives via the cron env (a custom var passes Hermes' provider-cred blocklist) — used for the queue gate AND injected to the render box. `CLAUDE_CODE_OAUTH_TOKEN` (the render box's `claude -p` auth) is a RECOGNIZED provider cred Hermes hard-blocks from the cron env (§ Operational gotchas), so it — plus `BOX_API_KEY` — is file-sourced from a `0600` `${HOME}/.render-conductor.env`. The conductor injects `CLAUDE_CODE_OAUTH_TOKEN` + `FLUNCLE_API_TOKEN` + `FLUNCLE_GL=swangle` to the render box's `/dev/shm/fluncle.env` on each wake (tmpfs does not survive the stop/resume snapshot — re-injected every cycle, never on argv).

| Job              | Schedule  | What it does                                                                                                                                                                                                                                                                                                                                                        | Server slice                                                                                       |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `fluncle-render` | every 60m | IDLE→ resume/reprovision rave-03, inject creds, trigger one detached `@fluncle-video` render of the queue head (`admin tracks queue`, oldest-first); RENDERING→ poll + park the box on the done-marker. One render at a time (state + `mkdir` lock). The render box ships via `admin tracks video`. Idempotent; no-op on an empty queue / within the hourly window. | `presign_track_video_uploads` + `track video` (agent tier) + the render-queue prompt's hard rails. |

**Pre-reqs.** The image carries `bun` + the `fluncle` CLI + the **box.ascii CLI** + `openssh-client` (the Dockerfile box block). The render box is provisioned from `main` (no image dep). Run-time pre-reqs: the `0600` secrets file + box.ascii auth. To wire it on a rebuilt box:

```bash
# 1. Deploy the three scripts (~/.hermes is hermes-owned 700 — copy IN via docker cp, not scp).
for s in render-conductor.sh provision-rave-03.sh render-detached.sh; do
  docker cp "docs/agents/hermes/scripts/$s" hermes:/opt/data/scripts/
done
docker exec hermes sh -c 'chown 1000:1000 /opt/data/scripts/render-*.sh /opt/data/scripts/provision-rave-03.sh && chmod +x /opt/data/scripts/render-*.sh /opt/data/scripts/provision-rave-03.sh'

# 2. Place the 0600 secrets file (Hermes won't pass these via the cron env). Values never print; op -> the file.
{ printf 'BOX_API_KEY=%s\n' "$(op read op://Fluncle/BOX_API_KEY/credential)"; \
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(op read op://Fluncle/CLAUDE_CODE_OAUTH_TOKEN/credential)"; } \
  | ssh <box> 'docker exec -i hermes sh -c "cat > /opt/data/home/.render-conductor.env && chown hermes:hermes /opt/data/home/.render-conductor.env && chmod 600 /opt/data/home/.render-conductor.env"'

# 3. Create the cron (hourly).
hermes cron create "every 60m" --no-agent --script render-conductor.sh --deliver local --name fluncle-render
```

**Smoke-test before scheduling** (mimic the cron user — `docker exec -u hermes -e HOME=/opt/data/home`, § Operational gotchas):

- `docker exec -u hermes -e HOME=/opt/data/home hermes box login "$(op read op://Fluncle/BOX_API_KEY/credential)"` then `box status` → authed.
- `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/render-conductor.sh` against a non-empty queue → expect `started render of <logId> on <boxid>`; a second immediate run → `render in flight … single-flight hold`. Watch `~/.render-conductor/conductor.log` + the render box's `~/conductor-run.log`.
- Confirm the first render ships (the finding leaves `admin tracks queue`) before walking away. Then schedule + watch a few hourly ticks.

### box.ascii CLI quirks (handled)

Wiring the conductor live surfaced several box.ascii CLI realities a stubbed dry-run (fake `box`) could not — all now handled in the Dockerfile + scripts, recorded so a rebuild does not re-debug them:

- **The installer needs `$SHELL` set + ends in an interactive onboard.** It runs `basename "$SHELL"` under `set -u` ($SHELL unset in a Docker build → exit 2) AND ends with an interactive `box onboard` (sign-in) needing a tty. The Dockerfile sets `SHELL=/bin/sh`, wraps the install `(curl | sh || true)`, and `test -x` the binary; runtime auth is `box login`, never baked.
- **`box new --ttl` is SECONDS (not a duration string) and is mutually exclusive with `--no-auto-stop`** ("use --no-auto-stop by itself"). The conductor REQUIRES `--no-auto-stop` (it poll-detects done by ssh'ing the RUNNING box; a TTL/auto-stop box would vanish mid-poll), so there is no box-side lifetime backstop — the conductor is the sole stop authority.
- **`box status` exits 0 even when unauthenticated**, so it cannot gate the login; the conductor always `box login`s (idempotent).
- **`box ssh` propagates remote pass/fail (0 vs 1) but not the exact exit code** (it prints an error JSON on non-zero). The done-poll keys off that 0/1; failures are checked, not the code.
- **`box ssh 'bash -s' <<heredoc` feeds the script on stdin, and `npx skills add` reads that stdin**, eating the rest of the script (silently skipping the `mkdir`, so the next scp failed on a missing dir). Every provision step gets `</dev/null` + a post-setup dir check.

Operational notes: the cron user is `hermes` (`HOME=/opt/data/home`); `box login` + the box config (`~/.config/ascii/box/config.json`, re-created by the conductor at the cron user's HOME) persist there. Billing tradeoff: up to ~35–60 min idle-wait per render (the box runs until the next hourly tick parks it) → ~480 of the 555 box-h/month worst case, far less in practice (ticks no-op once the queue is caught up). Tune `START_INTERVAL` if it bites.

## The agent cron — the Friday newsletter (LIVE)

The ONE remaining AGENT job in [`jobs.json`](./jobs.json) — the weekly newsletter — is **live on the box** (`fluncle-newsletter`, `0 15 * * 5`). It is the only job that still runs a full agent session; every per-finding step is a `--no-agent` sweep above (the context-note + observation steps used to be agent crons and were converted in the cutover). It authors + persists the Friday edition, then offers the operator a Discord Send/Hold button — it never auto-sends (`send_edition` is operator-tier, so the agent token 403s).

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
- **Schedule formats:** relative one-shot (`30m`, `2h`), recurring interval (`every 1h`, `every 5m`), cron expression (`0 * * * *`), or ISO timestamp. The `--no-agent` sweeps use `every 5m` (enrich and context-note), `every 10m` (note), `every 30m` (backfill), and `every 60m` (observation); the weekly newsletter uses a cron expression `0 15 * * 5` (Friday 15:00, evaluated against the **box clock** — which is why the box is pinned to `Europe/Amsterdam`; there is no per-job TZ field).
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
   - **Observation (the hybrid sweep's authoring step):** `printf 'Say hello in one short sentence.' | claude -p --model "$OBSERVE_CLAUDE_MODEL" --allowedTools "Read,Glob,Grep" --output-format json` → expect a JSON envelope with a non-empty `.result` and **zero OpenRouter spend** (subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`). The `copywriting-fluncle` skill is baked into the image at `/opt/claude/skills/copywriting-fluncle` (`CLAUDE_CONFIG_DIR=/opt/claude`); confirm `claude` lists it as the cron user, e.g. `docker exec hermes ls /opt/claude/skills/`.
   - **Newsletter:** `fluncle admin newsletter list --json` → expect `{ "ok": true, editions: [...] }` (drafts inclusive). Then author one edition end-to-end by hand: `fluncle admin newsletter draft --content-file <edition.json> --subject "<test>" --window-since <iso> --window-until <iso> --json` → expect a `draft` row with a sane `content`. Do NOT send yet. Confirm the agent token gets a **403** on `fluncle admin newsletter send <id> --json` (the operator gate); the operator fires the real send.
3. **Claude Code on the box (observation).** The image bakes the `claude` CLI **and** the `copywriting-fluncle` skill (at `/opt/claude/skills/`, discovered via `CLAUDE_CONFIG_DIR=/opt/claude`), so a rebuilt box has both. The one run-time pre-req is auth — and it does **not** come from the cron env (Hermes hard-blocks provider credentials; see **Operational gotchas**). `observe-sweep.sh` sources it from a `0600` file at `/opt/data/home/.observe-sweep.env`: `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth — NOT OpenRouter — from `op://Fluncle/CLAUDE_CODE_OAUTH_TOKEN/credential`), plus optionally `DISCORD_ALERT_WEBHOOK` (the claude-auth-failed ping), `OBSERVE_CLAUDE_MODEL` (default `claude-sonnet-4-6`), and `OBSERVE_CLAUDE_EFFORT`.
4. **Box timezone (newsletter).** Pin the box to `Europe/Amsterdam` (`TZ` env on `docker run`, or host `/etc/localtime`) and run the one-shot smoke test from [the newsletter extras](#the-newsletter-crons-two-extras-dst--the-clarify-send-gate) before scheduling `0 15 * * 5`. Confirm the recurring intervals are unaffected.
5. **The `clarify` gate, dry (newsletter).** From the running bot, exercise `clarify("Send edition #N?", [Send, Hold])` in Discord; confirm the buttons render, Hold no-ops, and the timeout sentinel is handled — and that `clarify` is reachable from a `deliver: discord` cron session (not just an interactive DM).
6. **Watch the first few ticks** — `~/.hermes/cron/output/{job_id}/*.md` and `~/.hermes/logs/`. The observation sweep costs ElevenLabs credits + subscription quota per render; confirm the per-tick batch is small (`BATCH_CAP=1`) and the queue drains as expected before walking away.

### Verify it's healthy

- `hermes cron list` shows `fluncle-enrich` (live) plus the `fluncle-context-note` / `fluncle-backfill` / `fluncle-observation` sweeps and the `fluncle-newsletter` agent job, each with a sane `next_run_at`.
- After a tick, each job's `~/.hermes/cron/output/{job_id}/` has a fresh run with the expected one-line summary (and a no-op when its queue is empty).
- Wire the context-note sweep first (cheaper, no paid render — it only triggers the Worker), then the observation (after the claude/skill pre-reqs above), then the newsletter (gate it on the box-TZ pin + one good hand-authored edition end-to-end first, per `docs/agents/newsletter-agent.md`).
- The newsletter's first live send goes to a **seed/operator-only audience first** (per the RFC's de-risk step) to validate DKIM + the unsubscribe link before any subscriber sees it.

## Operational gotchas (hard-won — do not re-debug these)

Found the slow way while wiring the hybrid observation sweep end-to-end (2026-06-23). Each cost real debugging; they are documented here so they never have to again.

- **The cron runs as user `hermes`, `HOME=/opt/data/home` — NOT `uid 1000`.** The script files are owned `1000:1000` (and `hermes` execs them fine — they're world-readable), but the `--no-agent` runner spawns them **as `hermes`**. When you reproduce a cron failure with `docker exec`, you MUST mimic that: `docker exec -u hermes -e HOME=/opt/data/home hermes …`. A plain `docker exec` (or `-u 1000`) inherits the **full container env** and a different user, so it passes when the cron fails — a deeply misleading false-green. This wasted a whole debug cycle.

- **Hermes WITHHOLDS provider credentials from `--no-agent` script envs, and you cannot override it.** The runner scrubs its recognized provider/gateway/tool secrets — `CLAUDE_CODE_OAUTH_TOKEN`, `OPENROUTER_API_KEY`, `DISCORD_*` — from spawned scripts via a hard blocklist `_HERMES_PROVIDER_ENV_BLOCKLIST` (the `GHSA-rhgp-j443-p4rf` credential-scrubbing fix). `config.yaml`'s `terminal.env_passthrough` **CANNOT** allowlist them back — the gateway logs `refusing to register … blocked by _HERMES_PROVIDER_ENV_BLOCKLIST` and drops it. Only **unrecognized custom vars** (`FLUNCLE_API_TOKEN`) pass through by default — which is exactly why the CLI sweeps work but `claude -p` got `Not logged in`. **The only way to give `claude -p` its token is the file-source** in `observe-sweep.sh`: a `0600` operator file `/opt/data/home/.observe-sweep.env` holding `CLAUDE_CODE_OAUTH_TOKEN` (+ optionally `DISCORD_ALERT_WEBHOOK`), which the script reads directly, bypassing Hermes' env layer. Do **not** try `env_passthrough` for these — it is blocked by design.

- **The runner kills a `--no-agent` job at ~120s, and strips `PATH`.** `BATCH_CAP=1` in `observe-sweep.ts` keeps a tick (one `claude -p` authoring + one ElevenLabs render) under the kill; raising it risks a timeout. The limit is tunable via `cron.script_timeout_seconds` in `config.yaml` if a healthy tick genuinely needs more. The stripped `PATH` is why every sweep wrapper re-exports `PATH` + pins `BUN_BIN`/`FLUNCLE_BIN`.

- **`/opt/data/config.yaml` is HERMES-MANAGED — never hand-edit the expanded file.** The gateway reads the small operator config, backs it up as `config.yaml.bak-<ts>`, and writes a normalized **~12.6 KB expanded** version (all defaults + comments) back to `/opt/data/config.yaml`. Deploy the **small operator source** (the repo `docs/agents/hermes/config.yaml`, model + discord + any overrides) — a `docker cp` of the small file over the expanded one is safe; Hermes re-expands it on the next restart. Don't panic at the size delta (a `.bak` is the true previous operator config).

- **`~/.hermes` is `hermes`-owned mode 700 — copy IN with `docker cp`, not `scp`.** `admin` cannot write the mount directly; `docker cp <file> hermes:/opt/data/...` (runs as the daemon) is the deploy path. Secrets (the token, the webhook) flow `op read | ssh 'docker exec -i hermes sh -c "cat > …"'` so the value never prints.

## Keeping this in step

The **newsletter** (`fluncle-newsletter`, agent cron), the **catalogue backfills** (`fluncle-backfill`, `--no-agent` cron), and the **hybrid observation sweep** (`fluncle-observation`, `--no-agent` with one `claude -p` authoring step) have now landed (above); wire them on the box per [How the operator wires these](#how-the-operator-wires-these-on-the-box). Decommission the Spinup newsletter agent (`fluncle-s-newsletter-97bwtd`) + its keys only **after** one good Friday edition has shipped from Hermes — same prove-then-tear-down discipline as the enrichment cutover.
