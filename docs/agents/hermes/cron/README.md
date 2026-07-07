# Hermes automation crons

The version-controlled **source** for the Hermes automation cron jobs. The repo is canonical; the box is a deploy target (see the `fluncle-hermes-operator` skill). This directory records the canonical intent so a rebuilt box can be made to match.

Every step is a "read a queue → act per item, idempotently" loop over the `fluncle` CLI. There is **no on-add push**: a new find lands at `enrichment_status = pending` (queue-eligible) and is caught on the next tick.

## Cron roster

Live on the box as of the **2026-06-23 cutover** (+ `fluncle-render` wired **2026-06-24**, the newsletter converted off the agent **2026-06-27**). **Every** job is `--no-agent`; **no agent jobs remain** (`jobs.json` is `"jobs": []`). `fluncle-render` (the video render conductor, below) conducts renders on a separate scale-to-zero box.ascii box (rave-03), not on the Hermes box itself. "Box authoring" is how much model time the job spends locally: none (a pure deterministic trigger) or one `claude -p` call (a hybrid — subscription auth, zero OpenRouter). Run `hermes cron list` on the box for live job IDs + next-run times.

| Job                      | Cadence             | Mode                   | Box authoring             | What it does                                                                                                                                                  |
| ------------------------ | ------------------- | ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fluncle-enrich`         | every 5m            | `--no-agent`           | none (on-box DSP)         | BPM / key / spectral analysis on the box, write-back                                                                                                          |
| `fluncle-embed` ⏳       | every 5m            | `--no-agent`           | none (on-box torch/MuQ)   | MuQ-large audio embedding (1024-d) → sonic "more like this" + clusters (**PREPARED**, awaiting the MuQ image layer — see § below)                             |
| `fluncle-capture` ⏳     | every 5m            | host systemd timer     | none (yt-dlp → R2)        | capture each finding's full song once → the PRIVATE `fluncle-source-audio` bucket (yt-dlp via a residential proxy; a NON-BLOCKING side-channel — see § below) |
| `fluncle-context-note`   | every 5m            | `--no-agent`           | none (Worker Haiku)       | Firecrawl facts → distilled `context_note` + a `Texture:` line                                                                                                |
| `fluncle-note`           | every 10m           | `--no-agent` hybrid    | one `claude -p`           | auto-author the editorial `/log` note (fill-empty-only)                                                                                                       |
| `fluncle-observation`    | every 60m           | `--no-agent` hybrid    | one `claude -p`           | author the recovered-audio script → Worker Cartesia render                                                                                                    |
| `fluncle-backfill`       | every 30m           | `--no-agent`           | none (Worker HTTP)        | Discogs id + Last.fm love catalogue repair                                                                                                                    |
| `fluncle-social-capture` | every 10m           | `--no-agent`           | none (curl, box-authored) | capture YouTube/TikTok post URLs from Postiz → write back                                                                                                     |
| `fluncle-render`         | every 60m           | `--no-agent` conductor | none (remote `claude -p`) | wake rave-03 → render + ship one finding's video → park (LIVE)                                                                                                |
| `fluncle-healthcheck`    | every 10m           | host systemd timer     | none (probes only)        | probe each service → Discord-ping on a status flip → POST the `/status` snapshot (a rave-02 HOST timer, not a gateway cron — see § The healthcheck prober)    |
| `fluncle-live`           | every 1m            | `--no-agent`           | none (Twitch poll)        | poll Twitch Helix for `flunclelive` → POST the live state for the cross-surface callout                                                                       |
| `fluncle-studio-clip`    | every 15m           | `--no-agent`           | none (ffmpeg cut)         | cut a mixtape set → framed 9:16 clips → ship each to R2 (#215)                                                                                                |
| `fluncle-newsletter`     | Fri 15:00 Amsterdam | `--no-agent` hybrid    | one `claude -p`           | draft + persist the weekly edition (send is an operator-run command)                                                                                          |
| `fluncle-backup`         | every 24h           | `--no-agent`           | none (dump + R2)          | dump the prod DB → gzip → a PRIVATE R2 bucket (owned off-site backup) + prune to 30 daily / 12 monthly (§ The database-backup cron)                           |

The per-cron sections below carry the full mechanism, schedule rationale, and the rebuild-from-scratch wiring for each. In the deploy recipes, `<box>` and `op://<vault>/…` are operator placeholders — substitute your own host and 1Password vault; the exact item paths live in the ops runbook note in 1Password (this repo is open source, so concrete hosts/vault names stay out of it).

## The `--no-agent` enrichment cron (LIVE)

`fluncle-enrich` is **live on the box**. It does not carry a prompt: enrichment is pure compute (get → analyze → update, zero LLM tokens), so it is a `--no-agent --script` job. Its script source lives beside the build context at [`../scripts/`](../scripts/) — a bash wrapper (`enrich-sweep.sh`) the cron runner execs by extension, which in turn `exec`s the bun orchestrator (`enrich-sweep.ts`). It is created on the box directly (not in `jobs.json`, which now holds no jobs — every cron, including the newsletter, is a `--no-agent` sweep).

## The `--no-agent` audio-embedding cron (PREPARED — not yet deployed)

`fluncle-embed` computes a **MuQ-large audio embedding** (1024-d) per finding — the sonic-similarity space behind the `/log` "more like this" row and the future browse-by-feel clusters + the game's solar systems (docs/audio-embedding-rfc.md). Like enrichment it carries no prompt — the embedding is pure on-box compute (**zero LLM tokens**) — so it is a `--no-agent --script` job. Its source lives beside the enrich sweep at [`../scripts/`](../scripts/): `embed-sweep.sh` (the bash entry the runner execs by extension) → `embed-sweep.ts` (the bun orchestrator) → `embed-track.py` (the MuQ inference, run under the baked venv).

**On-box torch, unlike the Worker-paced sweeps.** MuQ runs **on the box** (torch, ~16s/track on 2 cores / ~8s on the CPX32's 4, ~2.85 GB peak — spike-validated on rave-02). The orchestrator drains `admin tracks embed --queue` (`hasEmbedding=false`, oldest-first), downloads each finding's preview from the Worker's self-refreshing `/api/preview/<id>` relay, runs one `embed-track.py` over the batch (the MuQ model load amortized), and writes each 1024-d vector back through `admin tracks update <id> --embedding-file`. `update_track` is **agent tier** (the vector is an analysis field, like `features`), so the box's existing agent-scoped token drives it; no operator token, matching the `fluncle-enrich` precedent. Idempotent: the queue is `embedding_json IS NULL`, so an embedded finding is already out of it.

| Job             | Schedule | What it does                                                                                                                                                                                                                                                                               | Server slice                                                                               |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `fluncle-embed` | every 5m | Drain `admin tracks embed --queue` (`hasEmbedding=false`, oldest-first); per finding (bounded batch, cap 3/tick): fetch `/api/preview/<id>` → `embed-track.py` (ffmpeg decode + MuQ mean-pool + L2-normalize, on the box) → `admin tracks update <id> --embedding-file`. No-op when empty. | The `embedding_json` column + the agent-tier `update_track` write + `hasEmbedding` filter. |

**Two gates before wiring (operator).** Unlike the other sweeps, this one needs the **MuQ image layer** first: the pinned torch trio + `muq` + baked model weights + the `/opt/muq-venv` interpreter (see the Dockerfile MuQ layer — it self-deploys via `fluncle-pin-watch` on merge, unless the base image moved off Python 3.11, which is a manual base rebuild). Reconcile the pinned torch/muq versions with the spike's validated set before the first build. Then deploy the scripts and create the cron:

```bash
# Deploy the script trio (after the MuQ image layer is live on the box), then create the no-agent cron.
scp docs/agents/hermes/scripts/embed-sweep.{sh,ts} docs/agents/hermes/scripts/embed-track.py <box>:~/.hermes/scripts/
hermes cron create "every 5m" --no-agent --script embed-sweep.sh --deliver local --name fluncle-embed
```

Confirm with `hermes cron list`; per-run output lands in `~/.hermes/cron/output/{job_id}/{timestamp}.md`. It is already registered in `@fluncle/registry` (`cron.embed`) + the healthcheck `AUTOMATION_CRONS`, so `/status` shows it (as stale/down until the first tick lands).

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

## The `--no-agent` social-URL-capture cron (LIVE)

`fluncle-social-capture` captures the public post URLs Postiz **withholds on create** for a pushed video — the YouTube watch URL and the TikTok permalink — and writes them back onto the finding (plus the analytics release-id), flipping a captured TikTok inbox draft `draft` → `published`. Like enrichment/backfill it carries no prompt — it is a single HTTP trigger (zero LLM tokens) — so it is a `--no-agent --script` job. Its source lives beside the other sweeps at [`../scripts/`](../scripts/) as a **lone** `social-capture-sweep.sh` (no `.ts` orchestrator — the whole job is one POST).

**The Worker-paced model.** The box holds **no** Postiz key (the Worker does). So the box just **triggers** — one `curl` per tick — and the Worker does the work: poll Postiz's `/missing` per pending YouTube/TikTok post, build each permalink from the platform's native content id, record the public `url`, link the release-id, and flip a captured TikTok draft to published. The capture endpoint is **agent tier** (it only fills the public URL Postiz withheld on create — it **publishes nothing**), so the box's existing **agent-scoped** token drives it; no operator token, matching the `fluncle-enrich`/`fluncle-backfill` precedent.

**Why `curl`, not the `fluncle` CLI.** The capture sweep landed (#172) as the `fluncle admin tracks social --capture` verb, but the box's **baked** `fluncle` CLI predates that verb, so a `fluncle … --capture` is an "unknown flag" on the box. The cron therefore **POSTs the endpoint directly** — `POST ${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}/api/admin/social/posts/capture` with `Authorization: Bearer ${FLUNCLE_API_TOKEN}`, `Content-Type: application/json`, and a `{}` body (a bodyless POST 400s on input validation, so the empty JSON body is required). Switch to the CLI verb when the baked CLI is next bumped past the version that carries `--capture` (then this becomes a thin CLI wrapper like the other sweeps).

| Job                      | Schedule  | What it does                                                                                                                                                                                                                                                                                                                                                                              | Server slice                                                               |
| ------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `fluncle-social-capture` | every 10m | One `curl -fsS` POST to `/api/admin/social/posts/capture` (empty `{}` body). The Worker drains the "pushed but no URL" backlog across YouTube + TikTok: poll Postiz's `/missing`, build each permalink from the native content id, record `url`, link the release-id, flip a captured TikTok draft → published. Idempotent; the Worker no-ops once every pending post has a captured URL. | `capture_post_urls` (agent-tier `POST /admin/social/posts/capture`, #172). |

**Every 10m:** the trigger burns no box tokens and the Worker no-ops once the backlog is drained, so a tight cadence is cheap — it grabs a freshly-published post's URL within minutes of the push settling on the platform. To create it on a rebuilt box (the image already carries `curl`; the agent-scoped token rides the cron env like the other sweeps):

```bash
# Deploy the lone script, then create the no-agent cron.
scp docs/agents/hermes/scripts/social-capture-sweep.sh <box>:~/.hermes/scripts/
hermes cron create "every 10m" --no-agent --script social-capture-sweep.sh --deliver local
```

| Job              | Schedule | What it does                                                                                                                                                                                                                                                                   | Server slice                                   |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `fluncle-enrich` | every 5m | Drain `admin tracks enrich --queue`; per finding (bounded batch, cap 4/tick): `tracks get` → `analyze-track.ts` (ffmpeg + DSP on the box) → `admin tracks update --bpm [--key] --features --status done` (or `--status failed` when no preview). Idempotent; no-op when empty. | The existing `admin tracks update` write-back. |

**Every 5m, not hourly:** the sweep burns no tokens and no-ops on an empty queue, so it runs far more often than the hourly hybrid sweeps — a new find enriches within minutes. The Worker-side Spinup trigger + SDK + secrets have been **removed** (this is the only path that enriches a find). The image carries `ffmpeg` + `bun`, and the `fluncle-track-enrichment` skill is installed under `~/.hermes/skills/` (→ `/opt/data/skills/`). To recreate it on a rebuilt box:

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

— Claude Code on **subscription auth** (`CLAUDE_CODE_OAUTH_TOKEN`, **zero OpenRouter tokens**), with **read-only** tools so it can load the installed `copywriting-fluncle` skill for the voice and read nothing it can mutate. The orchestrator parses the JSON envelope and takes its `.result` field as the script. The **script** then posts that text via `fluncle admin tracks observe <id> --script-file <tmp> --json`; the **Worker** re-scans it (the server-side voice gate), renders Cartesia, uploads `observation.{mp3,txt,json}` to R2, and writes back. Claude never posts — it only authors.

**Inputs (deterministic).** The PRIMARY authoring fuel is the finding's stored `context_note` — the firecrawl facts the context sweep distilled (release context, scene, label history). It's read via `fluncle admin tracks context <id> --json`, which returns the stored note (`skipped: true`, NO re-fetch) for a finding that already has one — and every queue item does (`hasContext=true`), so it's a cheap read with no side effect. The finding's identity metadata (`fluncle track get <id> --json`: artists, title, label, release year, galaxy, vibe) is the supporting identity the prose hangs on. A blank or unreadable note degrades gracefully to identity-only authoring. The note is internal creative fuel (never published); the observe endpoint re-scans the authored script through the voice gate at delivery.

| Job                   | Schedule  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Server slice                                                           |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `fluncle-observation` | every 60m | Drain `admin tracks observe --queue` (`hasContext=true AND hasObservation=false`, oldest-first); per finding (bounded batch, cap **3**/tick — observation costs Cartesia credits + subscription quota): `track get` → `claude -p` authors the recovered-audio script (read-only tools, `copywriting-fluncle`) → `admin tracks observe --script-file` (the Worker voice-gates + renders + stores). A gate reject is skipped (stays queued). Idempotent; no-op when empty. | `observe_track` flipped to agent tier + `hasObservation` filter (#86). |

**Env knobs.** `OBSERVE_CLAUDE_MODEL` (default `claude-sonnet-4-6`); `OBSERVE_CLAUDE_EFFORT` (optional, passed as `--effort` when set); `DISCORD_ALERT_WEBHOOK` (optional, the claude-auth-failed ping target).

**The claude-auth ping.** If `claude -p` fails with an **auth/quota** signature (distinct from a transient model hiccup — the detection is narrow), the sweep **stops the batch**, leaves the queue **intact** (no data lost — the queue is the durable worklist), and emits a loud `{ ok:false, reason:"claude_auth", … }` summary line plus a best-effort POST to `DISCORD_ALERT_WEBHOOK` ("Fluncle observe-sweep: claude auth failed, re-auth needed") when that env is set. An absent webhook still leaves the loud summary + a nonzero exit.

**Production pre-reqs.** The image now carries the `claude` (Claude Code) CLI **and** the `copywriting-fluncle` skill (baked at `/opt/claude/skills/copywriting-fluncle`, discovered via `CLAUDE_CONFIG_DIR=/opt/claude` so the non-root cron user finds it regardless of its HOME — see the Dockerfile + `docs/agents/hermes-agent.md` § The image). So a rebuilt box has both already. The one run-time pre-req is the claude auth token — and it **cannot come from the cron env** (Hermes hard-blocks provider credentials; see **Operational gotchas** below). `observe-sweep.sh` sources it from a `0600` operator-placed file at `${HOME}/.observe-sweep.env` (= `/opt/data/home/.observe-sweep.env`) holding `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth, from `op://<vault>/CLAUDE_CODE_OAUTH_TOKEN/credential`; **not** OpenRouter) plus optionally `DISCORD_ALERT_WEBHOOK` + `OBSERVE_CLAUDE_MODEL`. `observe_track` is **agent tier** (#86), so the box's existing agent-scoped token drives the delivery POST; no operator token. To create it on a rebuilt box:

```bash
# Deploy the script pair (~/.hermes is hermes-owned 700, so copy IN via docker cp, not scp):
docker cp observe-sweep.sh hermes:/opt/data/scripts/ && docker cp observe-sweep.ts hermes:/opt/data/scripts/
docker exec hermes chown 1000:1000 /opt/data/scripts/observe-sweep.* && docker exec hermes chmod +x /opt/data/scripts/observe-sweep.sh
# Place the 0600 secrets file the script sources (Hermes won't pass the token via env — see Gotchas).
# The value never prints; it flows op -> the file:
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(op read op://<vault>/CLAUDE_CODE_OAUTH_TOKEN/credential)" \
  | ssh <box> 'docker exec -i hermes sh -c "cat > /opt/data/home/.observe-sweep.env && chown hermes:hermes /opt/data/home/.observe-sweep.env && chmod 600 /opt/data/home/.observe-sweep.env"'
# (append DISCORD_ALERT_WEBHOOK to the same file the same way — optional, for the auth-fail ping.)
hermes cron create "every 60m" --no-agent --script observe-sweep.sh --deliver local --name fluncle-observation
```

**Every 60m, not 5m:** observation is the paid step (Cartesia credits + subscription quota), and its input is the context note the hourly context sweep produces — so an hourly cadence keeps the two in step. **`BATCH_CAP=1`** (one finding per tick): the cron runner kills a job at 120s and a single `claude -p` authoring + Cartesia render already ≈ that budget (raise the cap only if a healthy run measures well under 120s, or lift `cron.script_timeout_seconds` in `config.yaml`). The queue drains across hourly ticks; a fresh eligible finding is caught next tick.

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
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(op read op://<vault>/CLAUDE_CODE_OAUTH_TOKEN/credential)" \
  | ssh <box> 'docker exec -i hermes sh -c "cat > /opt/data/home/.note-sweep.env && chown hermes:hermes /opt/data/home/.note-sweep.env && chmod 600 /opt/data/home/.note-sweep.env"'
hermes cron create "every 10m" --no-agent --script note-sweep.sh --deliver local --name fluncle-note
```

## The render conductor cron (LIVE)

**Live as of 2026-06-24** — image `fluncle-hermes:v2026.6.24` bakes the box.ascii CLI + `openssh-client` + `fluncle@0.60.0` (pins have since advanced — the box now bakes the standalone `fluncle` binary, not the npm client; see the Dockerfile); the `fluncle-render` cron is wired (`every 60m`) and proven end-to-end (authed → provisioned a fresh render box from `main` → triggered a detached render → a second tick held on single-flight). Wiring it surfaced several box.ascii CLI realities now handled in the Dockerfile + scripts — see [§ box.ascii CLI quirks (handled)](#boxascii-cli-quirks-handled) at the end of this section.

`fluncle-render` drives the per-finding VIDEO render — but unlike every other sweep (which runs its whole job inside the Hermes box) it is a **conductor**: the Hermes box has no GPU and no Remotion toolchain, so it wakes a separate **scale-to-zero box.ascii render box (rave-03)**, triggers the `@fluncle-video` render of exactly one queued finding _there_ via a remote `claude -p`, and parks the box when the render finishes. The render box renders + **ships to R2 / the website** (sets `video_url`); it **never posts to social** — enforced twice over: the render-queue prompt's hard rail says don't, AND the server-side role boundary makes it impossible (the box carries only the `agent`-scoped token, and `track draft --platform youtube` / every publish-class route is operator-tier → 403, so a misbehaving render agent _cannot_ post). Source at [`../scripts/`](../scripts/): `render-conductor.sh` (the cron entry), `provision-rave-03.sh` (reproduces the render box from clean `main`), `render-detached.sh` (runs on the render box).

**Why a STATE MACHINE, not a blocking job.** A swangle (software-GL) render runs ~85 min, but the `--no-agent` runner kills any job at ~120s (§ Operational gotchas). So the conductor cannot block on the render. Instead the render runs **DETACHED on the render box** (it survives a Hermes container restart — decoupled), and each conductor tick is a quick (<120s) step in a two-state machine persisted under `~/.render-conductor/`:

- **RENDERING** → poll the box for `~/conductor-run.done`; STOP (snapshot) the box when present, return to idle. Still running → NO-OP. Past 2.5h → force-park (stuck guard).
- **IDLE** → if past the hourly start gate AND the queue is non-empty: resume the parked box **and freshen its checkout to `main`** (or reprovision if box.ascii reclaimed it), inject creds, trigger one detached render → rendering.

**Single-flight (no two renders at once — the hard requirement).** The STATE enforces it (only `idle` starts a render; a `rendering` tick only polls), and an atomic `mkdir` lock is a second guard so two ticks never race the state file (with a stale-lock breaker for a tick the 120s runner killed mid-hold — `flock` is deliberately avoided, it is not portable and adds a util-linux dep). Because a render (~85m) outlasts the hourly tick, the `rendering` no-op branch fires every cycle: it is the primary safety, exercised continuously, not a rare net.

**Cadence + billing.** Hourly: a render STARTS at most once per `START_INTERVAL` (3600s). Because a render finishes mid-interval and the next hourly tick parks the box, there is up to ~35 min of idle-wait per render — worst case ~480 of the 555 box-hours/month on the $20 tier, far less in practice (every tick no-ops once the queue is caught up). Tune `START_INTERVAL` if it ever bites.

**Scale-to-zero + reprovision.** box.ascii reclaims idle boxes AND their snapshots past the archive window, so the render box is **not durable state**. The conductor stores the box id and tries `box resume`; on a 404 it runs `provision-rave-03.sh` — a purge is a ~5-min non-event. `box new --no-auto-stop` (box.ascii rejects `--no-auto-stop` combined with `--ttl`, so there is **no** box-side lifetime backstop — the conductor is the sole stop authority): the conductor owns stop/resume, which it MUST — idle auto-stop could fire during a claude-thinking gap and kill a render, AND the conductor poll-detects "done" by ssh'ing the RUNNING box, so the box has to stay up until the conductor explicitly parks it. A conductor that dies entirely mid-render leaves a running box — mitigated by the container restart policy + the hourly stuck-guard (`MAX_RENDER` force-stop), else an operator cleanup.

**Snapshot freshness (the resumed checkout self-updates).** A resumed snapshot carries a **stale** `fluncle` checkout — the clone from whenever the box was last provisioned — so a `packages/video` / `fluncle-video`-skill fix would otherwise not reach the render box until box.ascii purged the snapshot and forced a reprovision. The render box is scale-to-zero (asleep but for a render), so it can't watch `main` itself like the rave-02 `fluncle-pin-watch` timer; instead the conductor freshens it **at wake**, right after a successful `box resume`, via `freshen_checkout` in `render-conductor.sh`: a drift-gated `git fetch --depth 1` + `git reset --hard origin/main`, running `bun install` and re-adding the `fluncle-video` skill **only** when the lockfile / skill subtree actually moved. It is **best-effort** — a fetch/reset failure logs and renders on the existing checkout (the queue is idempotent; a broken render just re-queues) — and the common case (a code change, no dep change) is a few seconds against an ~85m render. So every render runs current `main`; a fix lands on the **next render**, not at the next purge. The reprovision path needs none of this — it clones clean `main` by construction.

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
{ printf 'BOX_API_KEY=%s\n' "$(op read op://<vault>/BOX_API_KEY/credential)"; \
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(op read op://<vault>/CLAUDE_CODE_OAUTH_TOKEN/credential)"; } \
  | ssh <box> 'docker exec -i hermes sh -c "cat > /opt/data/home/.render-conductor.env && chown hermes:hermes /opt/data/home/.render-conductor.env && chmod 600 /opt/data/home/.render-conductor.env"'

# 3. Create the cron (hourly).
hermes cron create "every 60m" --no-agent --script render-conductor.sh --deliver local --name fluncle-render
```

**Smoke-test before scheduling** (mimic the cron user — `docker exec -u hermes -e HOME=/opt/data/home`, § Operational gotchas):

- `docker exec -u hermes -e HOME=/opt/data/home hermes box login "$(op read op://<vault>/BOX_API_KEY/credential)"` then `box status` → authed.
- `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/render-conductor.sh` against a non-empty queue → expect `started render of <logId> on <boxid>`; a second immediate run → `render in flight … single-flight hold`. Watch `~/.render-conductor/conductor.log` + the render box's `~/conductor-run.log`.
- Confirm the first render ships (the finding leaves `admin tracks queue`) before walking away. Then schedule + watch a few hourly ticks.

### box.ascii CLI quirks (handled)

Wiring the conductor live surfaced several box.ascii CLI realities a stubbed dry-run (fake `box`) could not — all now handled in the Dockerfile + scripts, recorded so a rebuild does not re-debug them:

- **The installer needs `$SHELL` set + ends in an interactive onboard.** It runs `basename "$SHELL"` under `set -u` ($SHELL unset in a Docker build → exit 2) AND ends with an interactive `box onboard` (sign-in) needing a tty. The Dockerfile sets `SHELL=/bin/sh`, wraps the install `(curl | sh || true)`, and `test -x` the binary; runtime auth is `box login`, never baked.
- **`box new --ttl` is SECONDS (not a duration string) and is mutually exclusive with `--no-auto-stop`** ("use --no-auto-stop by itself"). The conductor REQUIRES `--no-auto-stop` (it poll-detects done by ssh'ing the RUNNING box; a TTL/auto-stop box would vanish mid-poll), so there is no box-side lifetime backstop — the conductor is the sole stop authority.
- **`box status` exits 0 even when unauthenticated**, so it cannot gate the login; the conductor always `box login`s (idempotent).
- **`box ssh` propagates remote pass/fail (0 vs 1) but not the exact exit code** (it prints an error JSON on non-zero). The done-poll keys off that 0/1; failures are checked, not the code. Script-authoring rule: treat the wrapper's exit code as advisory — assert a load-bearing remote step on an explicit output marker (have the remote command emit one and grep the captured output; the `~/conductor-run.done` file poll is this pattern), or fold the check into the remote command as a binary test (`test -f <path> && echo yes || echo no`) and key off the printed answer.
- **`box ssh 'bash -s' <<heredoc` feeds the script on stdin, and `npx skills add` reads that stdin**, eating the rest of the script (silently skipping the `mkdir`, so the next scp failed on a missing dir). Every provision step gets `</dev/null` + a post-setup dir check.

Operational notes: the cron user is `hermes` (`HOME=/opt/data/home`); `box login` + the box config (`~/.config/ascii/box/config.json`, re-created by the conductor at the cron user's HOME) persist there. Billing tradeoff: up to ~35–60 min idle-wait per render (the box runs until the next hourly tick parks it) → ~480 of the 555 box-h/month worst case, far less in practice (ticks no-op once the queue is caught up). Tune `START_INTERVAL` if it bites.

## The healthcheck prober (a host systemd timer, NOT a gateway cron)

`fluncle-healthcheck` is the prober behind Fluncle's public **`/status`** dashboard. Every ~10m it probes each service, detects status **transitions** against a local state file, Discord-pings **only on a transition** (a service going down, or recovering), and POSTs the snapshot to the agent-tier `POST /api/admin/health` (oRPC `record_health`) that the page reads. It carries no prompt and burns **zero LLM tokens** — it is pure probing. Source beside the sweeps at [`../scripts/`](../scripts/): `fluncle-healthcheck.sh` (the bash entry) → `fluncle-healthcheck.ts` (the bun orchestrator).

**It does NOT run on the Hermes gateway.** A prober must not depend on the thing it monitors, and as a `--no-agent` gateway cron it shared the one cron runner with the busy automation sweeps — a long sweep or an hour-boundary pile-up delayed its 10m tick past the rave-01 watchdog's 30m staleness threshold, so the board flapped "rave-02 prober dark" while the box was perfectly healthy. So it now runs from a **rave-02 HOST systemd timer** that `docker exec`s the same script into the `hermes` container every 10m — the same host-level pattern as [`fluncle-pin-watch`](../pin-watch/README.md) and the rave-01 [`fluncle-rave-watchdog`](../../../../apps/ssh/watchdog). The units + the one-time deploy live in [`../healthcheck-timer/`](../healthcheck-timer/README.md). The rest of this section documents the probe mechanism, which is unchanged.

**What it probes (each → `{ service, status: ok|degraded|down, message, latencyMs }`).** All probes are quick HTTP/`dig`/TCP/file reads with a short (3–5s) per-probe timeout, so one hung target can never blow the runner's ~120s kill — the whole tick finishes well under budget.

| Service      | Probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`        | timed HTTP GET `${HEALTHCHECK_WORKER_URL}/api/health` — `ok` on a 200 (latency = elapsed ms), `down` otherwise (`200 in 142ms`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `r2`         | HTTP HEAD `${HEALTHCHECK_R2_PROBE_URL}` (a known public object) — `ok` on any 2xx.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dns`        | `dig +short +time=3 +tries=1 ${HEALTHCHECK_DNS_QUERY}` — `ok` on a non-empty answer; `down` on empty/timeout. The message reports the answer **count**, never an address.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ssh`        | a TCP-connect to `${HEALTHCHECK_SSH_HOST}:${HEALTHCHECK_SSH_PORT}` (a successful handshake is liveness; we never speak SSH) — `ok` if it connects.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cron.*`     | reads `~/.hermes/cron/output/<job>/` for each Hermes gateway cron (enrich, context-note, note, observation, backfill, social-capture, clip-drip, render, newsletter, backup): newest `*.md`, last line parsed as JSON (`.ok !== false`) AND fresh within ~3× the cron's cadence. ONE row PER cron (service id = the registry surface name, e.g. `cron.enrich`); a cron with no output dir yet is "no data" (ok-unknown, never `down`). `cron.healthcheck` is NOT read here (this prober IS that cron, now on a host timer with no gateway output dir) — its row is emitted self-evidently, like `hermes`. |
| `render-box` | reads `${HOME}/.render-conductor/state` (`idle`/`rendering` both ok; missing = "not yet provisioned", ok). It never wakes the scale-to-zero box; it optionally appends box.ascii plan usage if `box limits --json` returns it. A DISTINCT signal from `cron.render` (the conductor cron's own freshness): this is the box's reachability, that is the cron's last run.                                                                                                                                                                                                                                    |
| `hermes`     | the cron runs ON the Hermes box, so reaching the probe is self-evident liveness → `ok`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

> `onion` (Tor reachability) is **out of scope for v1** — it needs a SOCKS proxy the box may not have, so the page just won't show it until a later pass (a one-line `TODO` marks the spot in the orchestrator).

**Transitions + alerts (no spam).** The orchestrator loads `${HOME}/.healthcheck/state.json` (a map `service → last status`), marks each probe `transitioned` when its status differs from the stored one, and writes the new map back. It Discord-pings **only** when a service flips **to `down`** or **recovers** (`down → ok/degraded`) — a steady state pings nothing. The state write happens before the network POST, so a POST failure never loses the transition baseline.

**The POST is best-effort.** It `curl`-POSTs `{ at, checks: [{ service, status, message, latencyMs, transitioned }] }` to `${HEALTHCHECK_WORKER_URL}/api/admin/health` with `Authorization: Bearer ${FLUNCLE_API_TOKEN}`. `record_health` is **agent tier** (`adminAuth`, no `operatorGuard` — internal `service_status`/`status_events` writes only, fully reversible), so the box's existing **agent-scoped** token drives it, like `context_track`/`note_track`. If the POST fails the Discord ping has already fired, so it's logged, not thrown. The tick emits one JSON summary line to stdout (the cron run output; `ok:true` even when a probed service is down — `ok:false` would mean the prober itself couldn't run), diagnostics to stderr.

**The external beacon (the box's own dead-man's switch).** After the snapshot POST, the tick curls the OPTIONAL `${HEALTHCHECK_BEACON_URL}` — a provider-agnostic external uptime-check URL (healthchecks.io / BetterUptime / a self-hosted instance) that alerts when the pings _stop_, which is the only signal that catches **this box (the prober) going dark**, since a dead prober can't alert about itself. It's best-effort (a short `--max-time` curl, never throws) and skipped silently when unset; see [`apps/ssh/watchdog/`](../../../../apps/ssh/watchdog/) for the matching rave-01 beacon + the rave-01→rave-02 cross-ping that together form the dead-man's-switch triad.

| Job                   | Schedule  | What it does                                                                                                                                                                                                                                                                                                                       | Server slice                                  |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `fluncle-healthcheck` | every 10m | Probe web/r2/dns/ssh/render-box/hermes + one row per Hermes cron (`cron.*`) (short timeouts, parallel); diff each status against `~/.healthcheck/state.json`; Discord-ping only on a flip to `down` or a recovery; POST the snapshot to `record_health`. Best-effort POST + ping; never throws. No-op-cheap (no queue, no tokens). | `record_health` (agent-tier `/admin/health`). |

**Public-safe by construction (this repo is open source).** The script + the docs carry **no** hostnames, IPs, ports, `op://` paths, or `/opt/...` literals beyond the cron user's own `$HOME`. Every probe target + the alert webhook come from a `0600` operator-placed file `${HOME}/.healthcheck.env` (sourced by the `.sh` exactly like `observe-sweep.sh` sources its env). The **exact target values** and the secret-file population live in **the ops runbook note in 1Password** — referenced here only by env-key NAME:

- `HEALTHCHECK_WORKER_URL` — the Worker origin (the `web` probe GETs `…/api/health`; also the snapshot POST target).
- `HEALTHCHECK_R2_PROBE_URL` — a known public R2 object URL (HEAD probe).
- `HEALTHCHECK_DNS_QUERY` — a name to `dig`.
- `HEALTHCHECK_SSH_HOST` + `HEALTHCHECK_SSH_PORT` — the SSH app's host + port (TCP-connect probe).
- `DISCORD_ALERT_WEBHOOK` — the transition-alert webhook (kept in the `0600` file since this is a public repo).
- `HEALTHCHECK_BEACON_URL` — **OPTIONAL**. The external dead-man's-switch beacon URL (healthchecks.io / BetterUptime / self-hosted) pinged at the end of every completed tick; unset ⇒ no beacon. Its value (and the rave-01 beacon's) live in the ops runbook note in 1Password.

`FLUNCLE_API_TOKEN` is **not** in that file: the agent-scoped token is already in the **running container's environment** (set at `docker run` from the operator's `--env-file`), and the host timer's `docker exec` inherits it — so it needs to pass only `-e HOME=/opt/data/home`.

The script pair ships with the container at `/opt/data/scripts/` (deploy it as the other sweeps do — `docker cp` + `chown 1000:1000` + `chmod +x`). What's different is the SCHEDULE: instead of `hermes cron create`, the prober is driven by a **host systemd timer**. Install the units, enable the timer, and **retire the old gateway cron** — the full one-time recipe (and the why) lives in [`../healthcheck-timer/README.md`](../healthcheck-timer/README.md):

```bash
sudo install -m 0644 docs/agents/hermes/healthcheck-timer/fluncle-healthcheck.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/healthcheck-timer/fluncle-healthcheck.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-healthcheck.timer
docker exec hermes hermes cron remove fluncle-healthcheck   # the host timer now owns the schedule
```

## The live cron

`fluncle-live` is the poller behind Fluncle's cross-surface **live-set callout** — the one loud, ephemeral beat that fans out across every surface (the web home banner, the crew Telegram ping+pin, the SSH footer line, the CLI, the MCP live-note, the `dig live` TXT record) while Fluncle is on the decks on Twitch, and clears itself the moment the set ends. Every ~1m it asks Twitch Helix whether `flunclelive` is streaming and POSTs the raw live state to the agent-tier `POST /api/admin/twitch/live` (oRPC `record_live_state`). It carries no prompt and burns **zero LLM tokens** — pure polling, a `--no-agent --script` job like the healthcheck. Source beside the other sweeps at [`../scripts/`](../scripts/): `fluncle-live.sh` (the bash entry the runner execs by extension) → `fluncle-live.ts` (the bun orchestrator).

**The tick (all deterministic — no model time).** 1) **Token**: mint a Twitch **client-credentials app token** (public Helix reads, **no app review**), cached to `${HOME}/.fluncle-live/token.json` by its expiry so it isn't minted every tick (app tokens last ~60 days; a 401 re-mints once). 2) **Poll**: `GET https://api.twitch.tv/helix/streams?user_login=flunclelive` with the `Client-Id` + `Bearer` headers — a non-empty `data[]` ⇒ live (read `title` + `started_at`), empty ⇒ offline. 3) **POST** the raw `{ at, live, title, startedAt }` to `${LIVE_WORKER_URL}/api/admin/twitch/live`. The poller is intentionally **dumb**: it reports state every minute, idempotently. The **Worker** owns the smarts — it stores the row, detects the off→on / on→off transition, and fires the crew Telegram callout (post + pin on go-live, unpin on end). Auto-clear is **read-side**: every surface treats a flag older than ~5 min as offline, so a dead poller can never strand a permanent "LIVE" banner.

**The POST is agent tier.** `record_live_state` is `adminAuth` only (no `operatorGuard` — internal `live_state` write, fully reversible), so the box's existing **agent-scoped** token drives it, like `record_health`. The tick emits one JSON summary line to stdout (`ok:true` even when the channel is offline — an offline channel is a normal, successful tick; `ok:false` would mean the poller itself couldn't run), diagnostics to stderr.

| Job            | Schedule | What it does                                                                                                                                                                   | Server slice                                           |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `fluncle-live` | every 1m | Mint/reuse a Twitch app token; poll Helix `Get Streams` for `flunclelive`; POST the raw live state to `record_live_state`. Best-effort; never throws. No-op-cheap (no tokens). | `record_live_state` (agent-tier `/admin/twitch/live`). |

**Public-safe by construction (this repo is open source).** The script + the docs carry **no** tokens, hostnames, or `op://` paths. The two Twitch credentials are the only new secrets, and they ride the **shared op-injected `${HOME}/.fluncle-secrets.env`** the `.sh` sources — the same file every other sweep reads, rendered from the box's 1Password secrets vault by the host `fluncle-secrets-sync` timer ([`../secrets/`](../secrets/)). Add them via 1Password, not by hand-placing a file (the exact vault + item live in the ops runbook note, kept out of this open-source repo):

- `TWITCH_CLIENT_ID` — the Twitch dev-app client id ([dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)).
- `TWITCH_CLIENT_SECRET` — the Twitch dev-app client secret (Hermes hard-blocks provider-cred-looking vars from the cron env — § Operational gotchas — so it must ride the injected file, not the cron env).

`LIVE_WORKER_URL` (the POST target) defaults to `https://www.fluncle.com` in the orchestrator and `TWITCH_USER_LOGIN` defaults to `flunclelive`, so neither needs configuring (override via the shared file only for testing). `FLUNCLE_API_TOKEN` is **not** a new secret: the agent-scoped token already rides the **cron env** (an unrecognized custom var passes Hermes' provider-cred blocklist, same as the other sweeps). To wire it on the box (the image already carries `bun` + `curl`):

```bash
# 1. Add the two creds to the box's 1Password secrets vault (the one the
#    fluncle-secrets-sync timer reads — exact vault/item in the ops runbook), then
#    reference them from the host inject template, e.g.:
#      TWITCH_CLIENT_ID=op://<vault>/<item>/client-id
#      TWITCH_CLIENT_SECRET=op://<vault>/<item>/client-secret
# 2. Re-render the shared secrets file now (or wait for the ~15m timer):
sudo systemctl start fluncle-secrets-sync
# 3. Deploy the script pair (~/.hermes is hermes-owned 700 — copy IN via docker cp, not scp):
docker cp fluncle-live.sh hermes:/opt/data/scripts/ && docker cp fluncle-live.ts hermes:/opt/data/scripts/
docker exec hermes sh -c 'chown 1000:1000 /opt/data/scripts/fluncle-live.* && chmod +x /opt/data/scripts/fluncle-live.sh'
# 4. Create the cron:
hermes cron create "every 1m" --no-agent --script fluncle-live.sh --deliver local --name fluncle-live
```

**De-risk before wiring (3 curls, ~30s).** Prove the spine with the operator's `client_id`/`client_secret` before trusting the cron: 1) mint — `curl -X POST 'https://id.twitch.tv/oauth2/token' -d "client_id=…&client_secret=…&grant_type=client_credentials"`; 2) live — `curl -H 'Client-Id: …' -H 'Authorization: Bearer <token>' 'https://api.twitch.tv/helix/streams?user_login=flunclelive'` while the channel is live (expect a populated `data[]`); 3) offline — the same when off (expect `data: []`). If that read works, the whole spine is green.

## The `--no-agent` Fluncle Studio clip-cut cron (LIVE)

`fluncle-studio-clip` (#215) cuts a published mixtape set into the framed **9:16 clips** the Fluncle Studio library hands off. Like enrich/backfill it carries no prompt — the cut is a deterministic ffmpeg job (trim + 9:16 crop + brand frame) — so it is a `--no-agent --script` job. Its source lives beside the other sweeps at [`../scripts/`](../scripts/): `clip-sweep.sh` (the bash entry the runner execs by extension) → `clip-sweep.ts` (the bun orchestrator).

**The flow.** Per tick it reads the cut worklist (`fluncle admin clips list --status pending --json`, oldest-first) and, per clip (bounded batch), runs `fluncle admin clips cut <clipId> --json` — which resolves the mixtape's staged set rendition, ffmpegs the trim + 9:16 crop + brand frame, single-PUTs the result to `<clipId>/footage.mp4` on R2, and finalizes (mark `done` + edge purge). All of it runs **behind the box's agent token**; the box holds no R2/Cloudflare creds (the Worker presigns). A clip whose mixtape set video **isn't staged yet** returns `set_not_staged` and is a **skip** (it stays `pending` until `distribute --set-video` stages the rendition) — not a failure.

| Job                   | Schedule  | What it does                                                                                                                                                                                                                                                                         | Server slice                                                 |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `fluncle-studio-clip` | every 15m | Drain `admin clips list --status pending`; per clip (bounded batch, cap **1**/tick): `admin clips cut <id>` → ffmpeg trim + 9:16 crop + brand frame → PUT `<clipId>/footage.mp4` to R2 → finalize. A `set_not_staged` clip is skipped (stays pending). Idempotent; no-op when empty. | `cut_clip` (agent tier) + the `admin clips` worklist (#215). |

**Config (all optional, from the shared `0600` `.fluncle-secrets.env` the other sweeps source).** `CLIP_FONT_FILE` points the brand-frame `drawtext` at a `.ttf` (absent it, fontconfig's default font is used); `CLIP_BATCH_CAP` widens the per-tick batch (default **1** — a clip not reached this tick is picked up ~15m later). Neither is required. To create it on a rebuilt box:

```bash
# Deploy the script pair, then create the no-agent cron.
scp docs/agents/hermes/scripts/clip-sweep.{sh,ts} <box>:~/.hermes/scripts/
hermes cron create "every 15m" --no-agent --script clip-sweep.sh --deliver local --name fluncle-studio-clip
```

> **Follow-up:** `fluncle-studio-clip` is **not yet** in the `fluncle-healthcheck` `AUTOMATION_CRONS` (`CRON_SPECS`), so it does not yet surface a `cron.studio-clip` row on `/status` — add it there when the healthcheck sweep is next touched.

## The `--no-agent` Friday newsletter sweep (LIVE)

The weekly newsletter — `fluncle-newsletter`, `0 15 * * 5` — is **live on the box**, and as of **2026-06-27** it is a `--no-agent` hybrid sweep, not an agent cron: [`jobs.json`](./jobs.json) is now `"jobs": []` and **NO AGENT JOBS REMAIN** (the context-note + observation steps were converted in the 2026-06-23 cutover, the newsletter — the last agent job — in the 2026-06-27 one). It is deterministic end to end except ONE bounded `claude -p` authoring call. It authors + persists the Friday edition, then posts a one-line Discord summary + the `fluncle admin newsletter send <id>` command — it never auto-sends (`send_edition` is operator-tier, so the agent token 403s); the operator runs the send command.

| Job                  | Schedule     | What it does                                                                                                                                                                                                                                                        | Server slice                                                                                                           |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fluncle-newsletter` | `0 15 * * 5` | Friday 15:00 Amsterdam (box-TZ pinned): read the discovery window, author the edition (one `claude -p` call + `copywriting-fluncle`), persist a DRAFT via `admin newsletter draft`, then post a Discord summary + the `fluncle admin newsletter send <id>` command. | `create_edition` (admin tier) + `send_edition` (operator tier) + `list_editions_admin` (admin tier, drafts inclusive). |

The newsletter is the one cron that is **`deliver: discord`** (not `local`): the Friday edition is a crew-feed moment AND the send gate is the `fluncle admin newsletter send <id>` command the operator must see and run. It is also the one cron on a **cron expression** (`0 15 * * 5`) rather than an interval, so it depends on the box clock being pinned to `Europe/Amsterdam` — see [The newsletter cron's two extras](#the-newsletter-crons-two-extras-dst--the-send-gate).

## The newsletter cron's two extras: DST + the send gate

The `--no-agent` sweeps (enrich, context, observation, backfill) are plain box-clock-agnostic intervals. The Friday newsletter adds two mechanics the others don't have:

- **DST-aware Friday 15:00 Amsterdam — solved by the BOX CLOCK, not a TZ field.** Hermes cron has **no per-job timezone** (verified against the upstream cron docs: schedules are relative / `every Nh` / a cron expression / an ISO timestamp, all evaluated against the box clock). So `0 15 * * 5` fires at 15:00 in whatever timezone the box clock reads. To hit 15:00 Amsterdam correctly through the CET⇄CEST flip, **pin the box to `Europe/Amsterdam`** (`TZ=Europe/Amsterdam` on `docker run`, or the host `/etc/localtime`); the OS tz database then handles DST and `0 15 * * 5` is always 15:00 Amsterdam, summer or winter, with zero app-level DST logic. The hourly intervals (enrich/context/observation) are TZ-agnostic, so this pin is invisible to them — but any **future absolute-time cron inherits Amsterdam-local**, so document new ones as such. _Smoke-test before relying on it:_ schedule a one-shot `0 <next-minute> * * *` and confirm it fires at the Amsterdam-local minute; if it evaluates UTC regardless, fall back to two seasonal entries (`0 13 * * 5` summer + `0 14 * * 5` winter, each season-guarded).
- **The send gate — persist-then-offer.** The send stays operator-gated: the agent token gets a 403 on `send_edition` server-side, so the sweep **cannot** send. Instead it **drafts** (agent tier — the box's agent token can draft), **persists the draft first** (the durable artifact — a missed send never loses the authored work), then posts a one-line Discord summary + the literal `fluncle admin newsletter send <id>` command; the **operator runs it**. Nothing auto-sends — silence is never consent for a publish-class action; an unsent draft is **re-offered on the next Friday tick** (the sweep's miss-recovery step reads `admin newsletter list` for an unsent draft before authoring a new one). The old interactive `clarify` Send/Hold button needed the agent/gateway loop and is gone with it.

## The database-backup cron (LIVE)

`fluncle-backup` is the **owned, off-Cloudflare database backup** — the answer to "what if the Turso database is lost." Turso's managed point-in-time restore is the belt; this is the braces: a daily gzipped SQL dump of the **prod** database, uploaded to a **PRIVATE R2 bucket** we control, independent of the Worker/Cloudflare. Because it runs on the box and talks to Turso + R2 directly, a Worker/Cloudflare fault can't also take out the backup. Like enrich/backfill it carries no prompt — a pure job, **zero LLM tokens** — so it is a `--no-agent --script` job. Source beside the other sweeps at [`../scripts/`](../scripts/): `backup-sweep.sh` (the bash entry) → `backup-sweep.ts` (the bun orchestrator).

**The dump method — the libSQL HTTP pipeline, zero deps.** The sweep dumps over `POST <http-url>/v2/pipeline` (Bearer auth) — the same over-the-wire access `apps/web/scripts/db-pull-prod.ts` uses via `@libsql/client`, but hand-rolled with `fetch` so it runs on the box with **only bun** (no `turso` CLI, no image change). It reads `sqlite_master` for the schema, `SELECT *` per table, and emits a restorable SQL dump in SQLite `.dump` order (tables → rows → indexes/triggers, wrapped in one `BEGIN…COMMIT`). This is the **exact format** `db-refresh.ts` loads into every worktree's `local.db` daily, so it is continuously restore-tested. The pure emitter MIRRORS `apps/web/src/lib/server/db-dump.ts` (unit-tested there; a drift is caught by the shared tests) — keep the two in step.

**Where it lands — a PRIVATE bucket, never `fluncle-videos`.** `fluncle-videos` is served world-readable at the `found.fluncle.com` custom domain, and a DB dump contains OAuth tokens + sessions, so it MUST NOT go there. The dump + an integrity manifest upload (S3 SigV4, mirroring `apps/web/src/lib/server/aws-sigv4.ts`) to a dedicated **`fluncle-backups`** bucket that has **no public domain and no bindings** — reachable only with credentials.

**Retention.** Keys are `db-backups/daily/<YYYY-MM-DD>/{fluncle.sql.gz,manifest.json}` and `db-backups/monthly/<YYYY-MM>/…`. Each run promotes the first backup of the month to the monthly tier, then prunes to **30 dailies + 12 monthlies** (`FLUNCLE_BACKUP_KEEP_DAILY` / `FLUNCLE_BACKUP_KEEP_MONTHLY`). The prune selection is pure + unit-tested (`selectExpiredBackupKeys`) and conservative (an unparseable key is never deleted).

**The restore drill (the acceptance test).** A backup that has never restored is a hope, not a backup. `apps/web/scripts/restore-drill.ts` (`bun run --cwd apps/web db:restore-drill <dump.sql.gz> [manifest.json]`) restores a dump into a throwaway scratch libSQL and verifies it against the manifest: table count + every table's row count + a content spot-check (the anchor table's count + min/max). It exits non-zero (loudly) on any mismatch or a malformed dump. Run it after any change to the dump path. A local dry run produces a real artifact to feed it: `bun docs/agents/hermes/scripts/backup-sweep.ts --out <dir>` (dump + gzip + manifest to `<dir>`, no R2) against the local dev db.

| Job              | Schedule  | What it does                                                                                                                                                                                                                                                                                     | Server slice                                         |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `fluncle-backup` | every 24h | Dump the prod DB over the libSQL HTTP pipeline → gzip → PUT `db-backups/daily/<date>/fluncle.sql.gz` + `manifest.json` to the private `fluncle-backups` R2 bucket; promote the month's first backup to `db-backups/monthly/`; prune to 30 daily / 12 monthly. Idempotent per day. No LLM tokens. | None — talks to Turso + R2 directly (no Worker hop). |

**OPERATOR-GATED wiring.** Three one-time operator steps (creating an R2 bucket is free — still flag it):

1. **Create the private bucket + a least-privilege token.** Create an R2 bucket `fluncle-backups` with **no** custom domain and **no** public access (`wrangler r2 bucket create fluncle-backups`, or the dashboard). Mint an R2 API token scoped to **Object Read & Write on `fluncle-backups` ONLY** (never `fluncle-videos`). Mint a **READ-ONLY** prod Turso token for the dump (`turso db tokens create <db> --read-only` — the box can read but never mutate prod). Store all four in the `Fluncle Automations` 1Password vault.

2. **Add the secrets to the box's synced env template.** Append to the box's `op inject` template (`/etc/hermes/fluncle-secrets.env.tpl`, materialized to the shared `~/.fluncle-secrets.env` by `fluncle-secrets-sync` — see [`../secrets/`](../secrets/README.md)); use PLACEHOLDER `op://` paths (the concrete vault/item live in the ops runbook note):

   ```bash
   # Database backup (fluncle-backup cron): a read-only prod Turso token + a
   # backup-bucket-only R2 token. NEVER the fluncle-videos R2 creds.
   TURSO_DATABASE_URL=op://<vault>/<turso-item>/TURSO_DATABASE_URL
   TURSO_AUTH_TOKEN=op://<vault>/<turso-item>/TURSO_AUTH_TOKEN_READONLY
   FLUNCLE_BACKUP_R2_ACCESS_KEY_ID=op://<vault>/<r2-backup-item>/access_key_id
   FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY=op://<vault>/<r2-backup-item>/secret_access_key
   R2_ACCOUNT_ID=0651fd3b33d9e0b2fe72a5f13e5cf65d
   ```

3. **Deploy the pair + create the cron** (`~/.hermes` is `hermes`-owned 700 — copy IN via `docker cp`, per § Operational gotchas):

   ```bash
   docker cp docs/agents/hermes/scripts/backup-sweep.sh hermes:/opt/data/scripts/
   docker cp docs/agents/hermes/scripts/backup-sweep.ts hermes:/opt/data/scripts/
   docker exec hermes sh -c 'chown 1000:1000 /opt/data/scripts/backup-sweep.* && chmod +x /opt/data/scripts/backup-sweep.sh'
   hermes cron create "every 24h" --no-agent --script backup-sweep.sh --deliver local --name fluncle-backup
   ```

   Smoke-test as the cron user first (§ Operational gotchas): `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/backup-sweep.sh` → expect an `{ "ok": true, "dailyKey": … }` summary and the object in R2. Then confirm `cron.backup` goes green on `/status` after a tick.

## The full-song capture sweep (a HOST systemd timer, PREPARED — not yet deployed)

`fluncle-capture` captures each finding's **full song once** into a PRIVATE R2 bucket, the source-fix behind three readers (enrichment, embeddings, the live Tier-A references — docs/full-audio-rfc.md). Like enrich/backup it carries no prompt — a pure job, **zero LLM tokens**. It is scheduled by a **rave-02 HOST systemd timer**, NOT a `hermes cron create` gateway cron — the full install lives in [`../capture-timer/`](../capture-timer/README.md); this section is the mechanism summary. Sweep source beside the other sweeps at [`../scripts/`](../scripts/): `capture-sweep.sh` (the bash entry) → `capture-sweep.ts` (the bun orchestrator).

**Why a host timer, not a gateway cron.** A per-finding `yt-dlp` fetch through a residential proxy has an **unbounded tail** (a 60s search + up to a 180s download, times `BATCH_CAP`). On the one serial Hermes gateway runner (a ~300s global `script_timeout`), a worst-case tick during the whole-archive backfill drain would blow the budget and **starve the latency-sensitive 5-minute enrich/context/note sweeps**. So capture runs decoupled on a host timer — the same reason `fluncle-healthcheck` and `fluncle-pin-watch` are host timers.

**A NON-BLOCKING side-channel.** Capture sits BESIDE the analysis pipeline, never upstream of it as a gate: it does NOT gate the enrich/embed queues (those run on the preview today, unchanged). Its own queue is a SEPARATE `capture-audio --queue` worklist — `capture_status` pending ∪ failed ∪ NULL, with per-finding backoff (a `failed` row waits out a cooldown and is dropped after the failure cap) — served **newest-first** so a fresh add jumps ahead of the whole-archive backfill. On a `done` capture it re-queues enrichment ONLY when the BPM is genuinely missing (clobber-safe — never over a real value).

**The mechanism (validated end-to-end on rave-02, 2026-07-07).** For each finding the sweep runs `yt-dlp` against a `ytsearch5:"<artists> <title>"`, picks the candidate whose duration is within ±3s/±3% of the finding's Spotify length (de-ranking remix/live/sped-up markers), downloads `-f bestaudio`, ffprobe-confirms the real duration, and PUTs the bytes to the private `fluncle-source-audio` bucket at `analysis/source/<logId>/<sha256>.<ext>` (S3-direct SigV4, mirroring the backup sweep). Two constraints are mandatory: the box is a datacenter IP that YouTube bot-walls, so every request runs through a **residential proxy**; and the proxy session must be **STICKY per track** (`__sessid.<logId>` on the username pins one exit IP, or googlevideo 403s the media bytes). On a 403 surviving the sticky session it retries the download once with `--extractor-args youtube:player_client=tv,web_safari` before marking `failed`. No candidate passes the guard → `unmatched` (terminal). The write-back is via the AGENT-tier `update_track` op over direct HTTP (pin-independent — not the baked CLI).

| Job               | Schedule (host timer) | What it does                                                                                                                                                                                                                                                                                                                 | Server slice                                                                                            |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fluncle-capture` | every 5m              | Read `admin tracks capture-audio --queue` (`captureQueue=true`, newest-first, backoff-aware) over direct HTTP; per finding (bounded batch, cap 4): `yt-dlp` a sticky-proxy `ytsearch5` → duration-guard → `-f bestaudio` → ffprobe-confirm → S3-direct PUT to `fluncle-source-audio` → `update_track` sets the key + `done`. | The `capture_status`/`source_audio_*` columns + the agent-tier `update_track` write + the queue filter. |

**OPERATOR-GATED wiring — a HOST TIMER (full runbook in [`../capture-timer/`](../capture-timer/README.md)).** The private bucket + the proxy/R2 creds are provisioned (2026-07-07). `yt-dlp` + `ffprobe` on PATH are a box deploy prereq. In short: the secrets are already in the box's `op inject` template (materialized to `~/.fluncle-secrets.env`) — `FLUNCLE_YTDLP_PROXY_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD`, `FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` (scoped Object Read & Write on `fluncle-source-audio` ONLY, never `fluncle-videos`), the reused public `R2_ACCOUNT_ID`, and the box's AGENT-scoped `FLUNCLE_API_TOKEN` for the write-back — then `docker cp` the sweep pair into `/opt/data/scripts/` and install the host units:

```bash
docker cp docs/agents/hermes/scripts/capture-sweep.sh hermes:/opt/data/scripts/
docker cp docs/agents/hermes/scripts/capture-sweep.ts hermes:/opt/data/scripts/
docker exec hermes sh -c 'chown 1000:1000 /opt/data/scripts/capture-sweep.* && chmod +x /opt/data/scripts/capture-sweep.sh'
sudo install -m 0644 docs/agents/hermes/capture-timer/fluncle-capture.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/capture-timer/fluncle-capture.timer   /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fluncle-capture.timer
```

Smoke-test as the cron user first: `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/capture-sweep.sh` → expect an `{ "ok": true, "done": … }` summary and an object under `analysis/source/` in R2. It is registered in `@fluncle/registry` (`cron.capture`) + the healthcheck `AUTOMATION_CRONS`, so `cron.capture` shows on `/status` (stale/down until the first tick lands) — the prober reads the cron output dir the `docker exec` writes, keyed by the `fluncle-capture` name, even though the scheduler is a host timer.

## The cron mechanism (verified against upstream)

Source: <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron> (fetched 2026-06-21).

- **Where jobs live:** `~/.hermes/cron/jobs.json` on the box. Per-run output is saved to `~/.hermes/cron/output/{job_id}/{timestamp}.md`. (Crons are **not** in `config.yaml` — `config.yaml` only carries cron _defaults_ like `cron.wrap_response` / `cron.script_timeout_seconds`.)
- **Scheduler:** the gateway ticks every 60 s and runs any due job in a **completely fresh, isolated session**. A job's script — and the hybrids' inline `claude -p` authoring prompt — must be self-contained; there is no carried conversation.
- **Schedule formats:** relative one-shot (`30m`, `2h`), recurring interval (`every 1h`, `every 5m`), cron expression (`0 * * * *`), or ISO timestamp. The interval sweeps use `every 5m` (enrich and context-note), `every 10m` (note, social-capture, and healthcheck), `every 15m` (studio-clip), `every 30m` (backfill), and `every 60m` (observation and render); the weekly newsletter sweep uses a cron expression `0 15 * * 5` (Friday 15:00, evaluated against the **box clock** — which is why the box is pinned to `Europe/Amsterdam`; there is no per-job TZ field).
- **No-agent jobs only.** Every job carries `no_agent: true` + a `script` and ships its stdout (the `fluncle-enrich`, `fluncle-backfill`, `fluncle-context-note`, `fluncle-social-capture`, `fluncle-healthcheck`, `fluncle-studio-clip`, `fluncle-render`, `fluncle-note`, `fluncle-observation`, and `fluncle-newsletter` sweeps); **no agent job (a `prompt` Hermes reasons through) remains**. Most burn **zero** LLM tokens; `fluncle-note`, `fluncle-observation`, and `fluncle-newsletter` are the **hybrids** — each spends one `claude -p` call (subscription auth) on a creative authoring step, deterministic everywhere else; `fluncle-render` spends its `claude -p` on the _render box_, not the Hermes box.
- **Delivery (`deliver`):** `local` saves the run output under `~/.hermes/cron/output/` with no chat post; `origin`, `discord`, `discord:#channel`, etc. post to a channel; `all` fans out. The queue-drain crons are silent, so they're `local`; the **newsletter is `discord`** (a crew-feed moment, and the operator-run send command needs a channel the operator sees).
- **Chaining (`context_from`):** a job can prepend another job's most recent output as context. **Not used** here: the context-note → observation handoff is durable **server state** (the stored `context_note`), not cron-run output, so the observation sweep reads the queue directly rather than chaining off the context cron's stdout. (This is intentional — chaining would couple the two jobs' ticks; the queue decouples them, which is the whole point of the context⊥observation split.)
- **Repeat:** intervals (`every 1h`) and cron expressions repeat **forever** by default; a one-shot runs once. `repeat: <n>` caps the run count. Left `null` here (forever).

## How the operator wires these on the box

**Every cron is a `--no-agent --script` job created on the box** — `jobs.json` holds no jobs (it is the mechanism record + source-of-truth pointer only). Each per-cron section above carries the exact `hermes cron create … --no-agent --script <sweep>.sh …` recipe + its script-deploy step; recreate them from those. The newsletter follows the same `--no-agent --script` form (a cron expression, delivered to Discord so the operator sees the send command) — **not** an agent prompt:

```bash
# On the devbox, over SSH on the tailnet (address in the operator's ops notes).
# Deploy the sweep pair, then create the no-agent cron.
# Pin the box clock to Europe/Amsterdam FIRST (see "The newsletter cron's two extras").
# The claude token rides the shared 0600 ~/.fluncle-secrets.env the sweep sources
# (CLAUDE_CODE_OAUTH_TOKEN — Hermes withholds provider creds from the cron env).
scp docs/agents/hermes/scripts/newsletter-sweep.{sh,ts} <box>:~/.hermes/scripts/
hermes cron create "0 15 * * 5" --no-agent --script newsletter-sweep.sh --deliver discord --name fluncle-newsletter
```

After creating, confirm with `hermes cron list` and check `~/.hermes/cron/jobs.json`.

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
3. **Claude Code on the box (observation).** The image bakes the `claude` CLI **and** the `copywriting-fluncle` skill (at `/opt/claude/skills/`, discovered via `CLAUDE_CONFIG_DIR=/opt/claude`), so a rebuilt box has both. The one run-time pre-req is auth — and it does **not** come from the cron env (Hermes hard-blocks provider credentials; see **Operational gotchas**). `observe-sweep.sh` sources it from a `0600` file at `/opt/data/home/.observe-sweep.env`: `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth — NOT OpenRouter — from `op://<vault>/CLAUDE_CODE_OAUTH_TOKEN/credential`), plus optionally `DISCORD_ALERT_WEBHOOK` (the claude-auth-failed ping), `OBSERVE_CLAUDE_MODEL` (default `claude-sonnet-4-6`), and `OBSERVE_CLAUDE_EFFORT`.
4. **Box timezone (newsletter).** Pin the box to `Europe/Amsterdam` (`TZ` env on `docker run`, or host `/etc/localtime`) and run the one-shot smoke test from [the newsletter extras](#the-newsletter-crons-two-extras-dst--the-send-gate) before scheduling `0 15 * * 5`. Confirm the recurring intervals are unaffected.
5. **The newsletter authoring call, dry (newsletter).** The newsletter sweep's one authoring call uses the identical subscription-auth `claude -p` invocation as observation's (item 2's `claude -p` smoke); confirm a non-empty `.result` and **zero OpenRouter spend** before scheduling `0 15 * * 5`.
6. **Watch the first few ticks** — `~/.hermes/cron/output/{job_id}/*.md` and `~/.hermes/logs/`. The observation sweep costs Cartesia credits + subscription quota per render; confirm the per-tick batch is small (`BATCH_CAP=1`) and the queue drains as expected before walking away.

### Verify it's healthy

- `hermes cron list` shows `fluncle-enrich` (live) plus the `fluncle-context-note` / `fluncle-note` / `fluncle-backfill` / `fluncle-observation` / `fluncle-social-capture` / `fluncle-healthcheck` / `fluncle-studio-clip` / `fluncle-render` sweeps and the `fluncle-newsletter` hybrid sweep, each with a sane `next_run_at`.
- After a tick, each job's `~/.hermes/cron/output/{job_id}/` has a fresh run with the expected one-line summary (and a no-op when its queue is empty).
- Wire the context-note sweep first (cheaper, no paid render — it only triggers the Worker), then the observation (after the claude/skill pre-reqs above), then the newsletter (gate it on the box-TZ pin + one good hand-authored edition end-to-end first, per `docs/agents/newsletter-agent.md`).
- The newsletter's first live send goes to a **seed/operator-only audience first** (per the RFC's de-risk step) to validate DKIM + the unsubscribe link before any subscriber sees it.

## Operational gotchas (hard-won — do not re-debug these)

Found the slow way while wiring the hybrid observation sweep end-to-end (2026-06-23). Each cost real debugging; they are documented here so they never have to again.

- **The cron runs as user `hermes`, `HOME=/opt/data/home` — NOT `uid 1000`.** The script files are owned `1000:1000` (and `hermes` execs them fine — they're world-readable), but the `--no-agent` runner spawns them **as `hermes`**. When you reproduce a cron failure with `docker exec`, you MUST mimic that: `docker exec -u hermes -e HOME=/opt/data/home hermes …`. A plain `docker exec` (or `-u 1000`) inherits the **full container env** and a different user, so it passes when the cron fails — a deeply misleading false-green. This wasted a whole debug cycle.

- **Hermes WITHHOLDS provider credentials from `--no-agent` script envs, and you cannot override it.** The runner scrubs its recognized provider/gateway/tool secrets — `CLAUDE_CODE_OAUTH_TOKEN`, `OPENROUTER_API_KEY`, `DISCORD_*` — from spawned scripts via a hard blocklist `_HERMES_PROVIDER_ENV_BLOCKLIST` (the `GHSA-rhgp-j443-p4rf` credential-scrubbing fix). `config.yaml`'s `terminal.env_passthrough` **CANNOT** allowlist them back — the gateway logs `refusing to register … blocked by _HERMES_PROVIDER_ENV_BLOCKLIST` and drops it. Only **unrecognized custom vars** (`FLUNCLE_API_TOKEN`) pass through by default — which is exactly why the CLI sweeps work but `claude -p` got `Not logged in`. **The only way to give `claude -p` its token is the file-source** in `observe-sweep.sh`: a `0600` operator file `/opt/data/home/.observe-sweep.env` holding `CLAUDE_CODE_OAUTH_TOKEN` (+ optionally `DISCORD_ALERT_WEBHOOK`), which the script reads directly, bypassing Hermes' env layer. Do **not** try `env_passthrough` for these — it is blocked by design.

- **The runner kills a `--no-agent` job at ~120s, and strips `PATH`.** `BATCH_CAP=1` in `observe-sweep.ts` keeps a tick (one `claude -p` authoring + one Cartesia render) under the kill; raising it risks a timeout. The limit is tunable via `cron.script_timeout_seconds` in `config.yaml` if a healthy tick genuinely needs more. The stripped `PATH` is why every sweep wrapper re-exports `PATH` + pins `BUN_BIN`/`FLUNCLE_BIN`.

- **`/opt/data/config.yaml` is HERMES-MANAGED — never hand-edit the expanded file.** The gateway reads the small operator config, backs it up as `config.yaml.bak-<ts>`, and writes a normalized **~12.6 KB expanded** version (all defaults + comments) back to `/opt/data/config.yaml`. Deploy the **small operator source** (the repo `docs/agents/hermes/config.yaml`, model + discord + any overrides) — a `docker cp` of the small file over the expanded one is safe; Hermes re-expands it on the next restart. Don't panic at the size delta (a `.bak` is the true previous operator config).

- **`~/.hermes` is `hermes`-owned mode 700 — copy IN with `docker cp`, not `scp`.** `admin` cannot write the mount directly; `docker cp <file> hermes:/opt/data/...` (runs as the daemon) is the deploy path. Secrets (the token, the webhook) flow `op read | ssh 'docker exec -i hermes sh -c "cat > …"'` so the value never prints.

## Keeping this in step

The **newsletter** (`fluncle-newsletter`, hybrid `--no-agent` sweep), the **catalogue backfills** (`fluncle-backfill`, `--no-agent` cron), and the **hybrid observation sweep** (`fluncle-observation`, `--no-agent` with one `claude -p` authoring step) have now landed (above); wire them on the box per [How the operator wires these](#how-the-operator-wires-these-on-the-box). Decommission the Spinup newsletter agent (`fluncle-s-newsletter-97bwtd`) + its keys only **after** one good Friday edition has shipped from Hermes — same prove-then-tear-down discipline as the enrichment cutover.
