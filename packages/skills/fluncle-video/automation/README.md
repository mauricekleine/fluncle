# Hands-off rendering on Superset

An hourly Superset automation that films the Fluncle render queue, one finding per tick, hands-off. The brain is [render-queue.prompt.md](render-queue.prompt.md); this file is the operator setup.

## What it does

Each hour, a Superset agent runs the prompt: it reads `fluncle admin tracks queue --limit 1 --json`, and if a finding is waiting (no video yet) it renders and ships **exactly one** video for it via the `@fluncle-video` skill, then stops. An empty queue is a silent no-op. Because the ship step sets the finding's `video_url`, the filmed finding leaves the queue — so Superset's at-least-once delivery is safe: a re-run sees an empty (or advanced) queue and won't re-render the same finding.

## Prerequisites on the designated device

Superset runs the agent on a device you designate. That device MUST have, on `PATH` and configured:

- **`fluncle`** — the CLI (a checkout of this repo, or the standalone binary), authenticated for admin commands.
- **`bun`** — the renders and the `ship` step run through bun (`bun run --cwd packages/video ...`).
- **`ffmpeg`** / `ffprobe` — the render encode and the silent-cut remux in `ship`, plus the `ffprobe` confidence check.
- **`FLUNCLE_API_TOKEN`** set in the device's environment — the admin token the `queue`, `vehicles`, and `track video` commands authenticate with. (Same token the video upload already uses; from 1Password, never inlined into the prompt.)
- A checkout of this repo at a known path, since the prompt runs `bun run --cwd packages/video ...` and ships from `packages/video/out/<log-id>`. Run the agent with that checkout as its working directory.

Confirm the toolchain before scheduling:

```
fluncle admin tracks queue --limit 1 --json
bun --version
ffmpeg -version
```

## Create the automation

From the repo root, with the Superset CLI authenticated:

```
superset automations create \
  --rrule "FREQ=HOURLY" \
  --agent claude \
  --prompt-file packages/skills/fluncle-video/automation/render-queue.prompt.md
```

Then, in **Superset Settings → Agents**, set the model for this agent to **opus-4.8**. (Video authoring — writing the GLSL shader and running the critique loop — needs the strongest model; do not leave it on a smaller default.)

## Dry-run before scheduling

Do not trust the schedule until you've watched it behave by hand. Run the prompt once manually (paste it into an interactive Superset agent run, or run the agent against the prompt file on the designated device) and confirm all three behaviors:

1. **Films the queue head.** With at least one finding waiting, confirm the run picks `tracks[0]` from `fluncle admin tracks queue --limit 1 --json` (the oldest finding with no video), does the diversity check, renders via `@fluncle-video`, ships it, and that `fluncle admin tracks video` set the finding's `video_url`. Re-run `fluncle admin tracks queue --limit 1 --json` afterward — that finding should be gone from the queue.
2. **Empty-queue no-op.** With every finding already filmed (queue returns `tracks: []`), confirm the run stops immediately: no render, no upload, no output beyond a one-line "queue empty". This is the common steady-state tick.
3. **Double-run doesn't double-render.** Trigger the prompt twice back-to-back (simulating at-least-once delivery). Confirm the second run does NOT re-render the finding the first run just shipped — once `video_url` is set, that finding has left the queue, so the second run either picks the next finding or no-ops on an empty queue. The worst acceptable case is one wasted render on a tight race, never two published videos for one finding.

Only after all three pass should you leave the hourly schedule running.

## Operating notes

- **One finding per hour by design.** The hourly tick is the throttle; the prompt never films more than one finding per run. Backlogs drain one-per-hour. Raise the `--rrule` frequency only if the queue grows faster than it drains.
- **Posting stays manual.** This automation ships to R2 and sets `video_url`; it never posts to TikTok or any social platform. Publishing is a separate, approval-gated step (`fluncle admin tracks draft` / the publish skill).
- **Pause it** by disabling the automation in Superset (or `superset automations` management commands) — there is no in-repo state to clean up, since the composition lives in the gitignored `workbench/` and nothing is committed.
