# Hands-off rendering (the `fluncle-render` conductor)

A cron that films the Fluncle render queue, one finding per tick, hands-off. The brain is [render-queue.prompt.md](render-queue.prompt.md); this file is orientation.

## What it does

Each tick, the prompt runs as a Claude Code agent: it reads `fluncle admin tracks queue --limit 1 --json`, and if a finding is waiting (no video yet) it renders and ships **exactly one** video for it via the `fluncle-video` skill, then stops. An empty queue is a silent no-op. Because the ship step sets the finding's `video_url`, the filmed finding leaves the queue — so at-least-once delivery is safe: a re-run sees an empty (or advanced) queue and won't re-render the same finding. The full per-tick contract (the at-least-once invariant, the diversity check, the `detect-beat-pull` gate, the hard rails) lives in the prompt; this file is just orientation.

## Where it runs (since 2026-06-24): the Hermes `fluncle-render` conductor

The prompt is triggered by the **`fluncle-render` `--no-agent` cron on the Hermes box (rave-02)** — not a Mac routine. The Hermes box has no GPU/Remotion, so it **conducts**: every hour it wakes a separate scale-to-zero **box.ascii render box (rave-03)**, runs this prompt there via a remote `claude -p` (detached, ~85 min on software GL), and parks the box when the render finishes. The render box carries `bun` + `ffmpeg` + the bun-wrapped `fluncle` CLI + the `fluncle-video` skill, provisioned from clean `main`; it resolves audio region-independently from the R2 preview archive and renders with software GL (`FLUNCLE_GL=swangle`). It ships with its own `agent`-scoped token (`track video` is agent-tier), and **never** posts to social — both by the prompt's hard rail and by the operator-tier publish gate.

**The canonical operator setup — mechanism, the state machine, single-flight, secrets, the wiring steps, and the box.ascii CLI gotchas — lives in [docs/agents/hermes/cron/README.md § the render conductor](../../../../docs/agents/hermes/cron/README.md).** This file does not duplicate it; the scripts are at `docs/agents/hermes/scripts/render-conductor.sh` + `provision-rave-03.sh` + `render-detached.sh`.

> **Predecessor (retired 2026-06-24):** a Claude Code **desktop-app Routine** ("Fluncle video queue") on the operator's Mac that ran this same prompt hourly. It was Mac-bound — a closed laptop meant zero renders, the queue backed up — and is fully superseded by the conductor above. The prompt is unchanged; only the trigger moved off the Mac.

## The per-tick behaviors (what a healthy tick does)

1. **Films the queue head.** With at least one finding waiting, the run picks `tracks[0]` from `fluncle admin tracks queue --limit 1 --json` (the oldest finding with no video), does the diversity check, renders via the `fluncle-video` skill, passes `detect-beat-pull`, ships it, and `fluncle admin tracks video` sets the finding's `video_url` — so that finding leaves the queue.
2. **Empty-queue no-op.** With every finding already filmed (queue returns `tracks: []`), the run stops immediately: no render, no upload, no output beyond a one-line "queue empty". This is the common steady-state tick.
3. **Double-run doesn't double-render.** Under at-least-once delivery, a second run does NOT re-render the finding the first just shipped — once `video_url` is set, that finding has left the queue. The worst acceptable case is one wasted render on a tight race (the conductor's single-flight also prevents two concurrent renders), never two published videos for one finding.

## Operating notes

- **One finding per tick by design.** The hourly tick is the throttle; the prompt never films more than one finding per run. Backlogs drain one-per-hour. Raise the cadence (`START_INTERVAL` in the conductor) only if the queue grows faster than it drains.
- **Posting stays manual.** This ships to R2 and sets `video_url`; it never posts to TikTok or any social platform. Publishing is a separate, approval-gated step (the `fluncle-publish` skill).
- **Pause it** by disabling the `fluncle-render` cron on the box (`hermes cron` tooling) — there is no in-repo state to clean up, since the composition lives in the gitignored `workbench/` and nothing is committed.
