# Hands-off rendering (Claude Code routine)

An hourly Claude Code routine that films the Fluncle render queue, one finding per tick, hands-off. The brain is [render-queue.prompt.md](render-queue.prompt.md); this file is the operator setup.

## What it does

Each hour, the routine runs the render prompt as the Claude Code agent: it reads `fluncle admin tracks queue --limit 1 --json`, and if a finding is waiting (no video yet) it renders and ships **exactly one** video for it via the `fluncle-video` skill, then stops. An empty queue is a silent no-op. Because the ship step sets the finding's `video_url`, the filmed finding leaves the queue — so Claude Code's at-least-once delivery is safe: a re-run sees an empty (or advanced) queue and won't re-render the same finding. The full per-tick contract (the at-least-once invariant, the diversity check, the `detect-beat-pull` gate, the hard rails) lives in the prompt; this file is just the wiring.

## Prerequisites on the Mac

The routine runs on the operator's Mac via the Claude Code desktop app. That machine MUST have, on `PATH` and configured:

- **`fluncle`** — the **pinned standalone binary** at `~/.local/bin/fluncle`, authenticated for admin commands and wired to **production**. The prompt runs this binary plainly; it must **never** use the from-source `bun run --cwd apps/cli fluncle …` form, which loads a different env profile (wrong DB / wrong API target) and reflects uncommitted local CLI edits. Same token the video upload already uses; from 1Password, never inlined into the prompt.
- **`bun`** — the renders and the `ship` step run through bun (`bun run --cwd packages/video …`). `bun` drives `packages/video` only; the `fluncle` CLI is the installed binary.
- **`ffmpeg`** / `ffprobe` — the render encode and the silent-cut remux in `ship`, plus the `ffprobe` confidence check.
- **`FLUNCLE_API_TOKEN`** set in the environment — the admin token the `queue`, `vehicles`, and `track video` commands authenticate with.
- A checkout of this repo at the path set as the routine's **Folder** (`/Users/maurice/Projects/fluncle`), since the prompt runs `bun run --cwd packages/video …` and ships from `packages/video/out/<log-id>`.

Confirm the toolchain before relying on the schedule:

```
fluncle admin tracks queue --limit 1 --json
bun --version
ffmpeg -version
```

## The routine (in the Claude app)

It is a **Routine** in the Claude Code desktop app (**Routines → "Fluncle video queue"**) — not a CLI cron and not a Superset automation. Its configuration:

| Field        | Value                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name         | `Fluncle video queue`                                                                                                                                                                      |
| Description  | Renders videos in the queue                                                                                                                                                                |
| Folder       | `/Users/maurice/Projects/fluncle` (the repo checkout it runs from)                                                                                                                         |
| Repeats      | Hourly at ~:00                                                                                                                                                                             |
| Permission   | **Act without asking** — it runs unattended, so it must not pause for a confirmation                                                                                                       |
| Agent        | the Claude Code agent (keep it on the strongest model — video authoring writes the GLSL shader + runs the critique loop)                                                                   |
| Instructions | the render prompt, stored at `~/.claude/scheduled-tasks/fluncle-video-queue/SKILL.md` — keep it in step with [render-queue.prompt.md](render-queue.prompt.md), the version-controlled copy |

Pause/resume it with the **Status** toggle on the routine; **Run now** triggers a one-off tick. The History panel lists recent runs. The routine is operator-owned — its instructions live in `~/.claude` and are edited in the app — so `render-queue.prompt.md` is the canonical, reviewable copy: edit it here, then paste it into the routine (or when first creating the routine).

## Dry-run before trusting the schedule

Do not trust the schedule until you've watched it behave by hand — use **Run now** (or run the prompt against a queued finding interactively) and confirm all three behaviors:

1. **Films the queue head.** With at least one finding waiting, confirm the run picks `tracks[0]` from `fluncle admin tracks queue --limit 1 --json` (the oldest finding with no video), does the diversity check, renders via the `fluncle-video` skill, passes `detect-beat-pull`, ships it, and that `fluncle admin tracks video` set the finding's `video_url`. Re-run the queue command afterward — that finding should be gone.
2. **Empty-queue no-op.** With every finding already filmed (queue returns `tracks: []`), confirm the run stops immediately: no render, no upload, no output beyond a one-line "queue empty". This is the common steady-state tick.
3. **Double-run doesn't double-render.** Trigger it twice back-to-back (simulating at-least-once delivery). Confirm the second run does NOT re-render the finding the first run just shipped — once `video_url` is set, that finding has left the queue. The worst acceptable case is one wasted render on a tight race, never two published videos for one finding.

## Operating notes

- **One finding per hour by design.** The hourly tick is the throttle; the prompt never films more than one finding per run. Backlogs drain one-per-hour. Raise the cadence only if the queue grows faster than it drains.
- **Posting stays manual.** This routine ships to R2 and sets `video_url`; it never posts to TikTok or any social platform. Publishing is a separate, approval-gated step (the `fluncle-publish` skill).
- **Pause it** with the routine's **Status** toggle in the Claude app — there is no in-repo state to clean up, since the composition lives in the gitignored `workbench/` and nothing is committed.
