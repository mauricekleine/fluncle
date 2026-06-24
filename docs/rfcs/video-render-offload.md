# RFC: Offload the video render agent to a box (rave-03)

**Status:** Scoped; feasibility proven empirically (2026-06-24). Not yet built.
**Shape:** authored directly from an interactive design+validation session — the divergence/convergence/adversarial passes were done live and _measured_, so this skips the RFC review panel.

## Problem

The per-finding video render runs as a **Claude Code desktop-app routine on the Mac** (`~/.claude/scheduled-tasks/fluncle-video-queue/SKILL.md`, hourly). It is Mac-bound: close the laptop and renders stop, the queue backs up (3 days closed = 0 renders). Goal: run it **autonomously off the Mac**.

## Decision

A conductor/worker split:

- **rave-02 (conductor, always-on Hetzner CX):** already runs Hermes + the enrichment crons. Gains a cron that gates on the render queue and, only when there is work, **wakes** a render worker, triggers **one** render, and **parks** it. Pure lifecycle — never renders. Puts rave-02 in a central orchestrator position that generalizes to future ephemeral workers.
- **rave-03 (worker, scale-to-zero on box.ascii):** runs the **full** `/fluncle-video` loop (author → render → upload), then sleeps. Self-contained — the brain is NOT split off to rave-02 (preserves the tight author→critique→render loop locally).

### Rejected alternatives

- **Hetzner dedicated (AX42):** €189/mo live (3 price hikes in 2026) — priced itself out; at ~€185 the GPU GEX44 would dominate it anyway.
- **Always-on rave-03:** simplest (internal timer), but pays for ~96% idle and 24/7 exceeds the box.ascii tier. The conductor pattern is preferred for the orchestration value at a ~$0-20/mo delta.
- **Serverless GPU / Remotion Lambda:** cold-start + per-render site-redeploy friction with an agentic, per-video-authored pipeline.
- **HyperFrames / HTML-to-MP4:** wrong medium (DOM motion-graphics vs the GLSL Nostalgic Cosmos), no audio-reactivity, and Remotion already gives the deterministic-code-render it pitches.

## Proven feasibility (measured on box.ascii, 2026-06-24)

- **Render time:** 7m20s (light 11KB comp) → 16m16s (heaviest 22KB), `--gl=swangle` (software GL, no GPU), concurrency 1.
- **Peak RAM:** ~5.35 GB — **composition-independent** (5363MB light vs 5354MB heavy; it's Chrome + the 1080×1920 pipeline, not shader complexity). 8 GB holds with ~2.3 GB headroom. **Single-flight is mandatory** (2 concurrent ≈ 10.7 GB = OOM). Add swap as insurance.
- **Box:** box.ascii sandbox, 4-vCPU AMD EPYC / 7.6 GB / Ubuntu 24.04, with **node 20 + bun + Chrome + ffmpeg preinstalled** (the gaps that make rave-02 a non-starter are already filled). Remotion auto-fetches its Headless Shell on first render.
- **Cost:** ~$20/mo (scale-to-zero ≈ 24 box-hours/month, far inside the 555h tier). Bursts of heavy comps drain serially in ≤3.5h.
- **Persistence (verified):** `box stop` snapshots the full disk; `box resume` restores it byte-for-byte — repo, patches, node_modules, render outputs all survived a stop→resume.

## Architecture

### rave-02 conductor cron (~every 15 min)

```bash
flock -n /run/fluncle-conductor.lock bash -c '
  # 1. GATE — only spend compute when there is work
  head=$(fluncle admin tracks queue --limit 1 --json | jq -r ".tracks[0].logId // empty")
  [ -z "$head" ] && exit 0           # empty queue -> rave-03 never wakes -> 0 box-seconds

  # 2. WAKE + always sleep afterward, even on failure
  box resume rave-03
  trap "box stop rave-03" EXIT       # crash/timeout still parks the box

  # 3. the worker runs the existing queue SKILL (render + R2 upload of one, queue-gated)
  box ssh rave-03 "claude -p \"$(cat fluncle-video-queue.md)\""
'
```

Four robustness rails:

1. **Queue-gate before wake** — empty queue costs zero box-seconds (rave-02 already has the CLI + agent token to check).
2. **`flock` single-flight** — a tick firing during a 16-min render is a no-op; never double-wakes/double-renders.
3. **`trap … EXIT` always-stop** — a failed render still parks rave-03 so it can't keep billing.
4. **TTL backstop on rave-03** — if rave-02 dies mid-render and never sends stop, the box auto-sleeps.

New rave-02 dependencies: the `box` CLI installed, and a box.ascii API token (in `op`) so it can resume/stop rave-03.

### rave-03 worker

Runs the existing `fluncle-video-queue` SKILL via `claude -p` — render **and** `fluncle admin tracks video` (the R2 upload that sets `video_url` and clears the finding from the queue; queue-gating makes it idempotent at-least-once). Social-platform publishing (TikTok/YT drafts) stays a separate, operator-gated step. Reproducible via a provision script (clone + install + patch + configure) so a lost box is re-created, not mourned — cattle, not pet.

## Code changes

### `packages/video` PR

1. **GL renderer env-configurable** (`angle` on Mac / `swangle` on a GPU-less host) — `render.ts` ×2 + `remotion.config.ts`.
2. **ffmpeg from PATH** — `download-preview.ts` hardcodes `/opt/homebrew/bin/ffmpeg`; use PATH/`/usr/bin/ffmpeg`.
3. **`fonts.ts` delayRender fix** — own the `delayRender`/`continueRender` lifecycle so the handle always clears. This is Remotion bug **#5843** (the `@remotion/fonts` auto-handle never clears when render wall-time exceeds the timeout window — slowness-triggered, not swangle-specific). **Not** fixed in `4.0.481` (≈ latest; `4.0.482` is the only newer stable), so a version bump won't help; the in-code fix is the real solution. A large `--timeout` is the proven stopgap but delays detection of genuinely stuck renders.
4. **`resolve-preview.ts` prefers the R2 archived preview** over the Deezer/iTunes re-search. The re-search is **region/IP-gated** (resolves on the Mac, fails from a cloud box IP). The R2 copy is permanent + region-independent.

### Worker (`apps/web`) changes

- **Lower `GET /api/admin/tracks/:id/preview` from `requireOperator` → agent-tier.** It is read-only, authenticated, and never public, so the Deezer-licensing stance holds; this lets the agent-token box resolve previews. Returns `{ archived, key, … }`; `key = analysis/previews/<logId>/<sha256(audio)>.<ext>`, fetched at `https://found.fluncle.com/<key>`.
- **Schedule `fluncle admin tracks previews`** (the existing "archive missing previews" backfill) as a cron so every finding is archived to R2 **before** it reaches the render queue. Coverage today is high but not universal — archiving is operator-manual, not auto at add/enrich, so the newest findings lag (sampled 7/9 archived; all 5 sampled queue items present). Without this, an unarchived finding stalls on the box (its only fallback is the region-gated Deezer search).

## Credential model

- **`CLAUDE_CODE_OAUTH_TOKEN`** — a 1-year `claude setup-token` (static, no OAuth refresh-to-disk, **revocable** = kill switch).
- **`FLUNCLE_API_TOKEN`** — **agent-scoped** (a leak reads the queue / uploads video; cannot operator-act — newsletter send, etc.).
- Both injected via box.ascii **per-box Secrets, as environment variables** — NOT file-type secrets (files land on disk → into the snapshot) and NEVER on a command line (box.ascii's own docs warn "do not pass secrets in CLI arguments that may be logged"; argv is also visible in `ps`/`/proc/cmdline`). Conductor commands reference `$VAR` only. Secrets are re-applied on each `resume` (not frozen in the snapshot) and centrally rotatable.
- The box.ascii API token (rave-02 → resume/stop rave-03) lives on **rave-02** in `op`, never on rave-03.

Blast radius is bounded and recoverable: revocable Claude token + agent-scoped FLUNCLE token + env-injection that keeps both out of logs and off the disk snapshot. JIT inject-and-wipe is unnecessary given a static revocable token and per-box, resume-time injection.

## Open verification items (execution, not design)

- Confirm box.ascii **snapshot retention** for a long-idle/archived box (founder or `/box/long-running-tasks`). Mitigated regardless by the reproducible provision script + account/per-box Secrets.
- One **end-to-end dry run** of the full `claude -p /fluncle-video` loop on the box (render-only, no ship) before cutover — render mechanics + the auth model are proven; the full on-box _authoring_ loop is not yet exercised.

## Cutover

Build the `packages/video` + worker PR → provision rave-03 (golden snapshot + per-box Secrets) → add the conductor cron on rave-02 → dry-run one finding → pause the Mac desktop routine (`~/.claude/scheduled-tasks/fluncle-video-queue`).
