# Hands-off render: film the queue head, exactly one finding

You are an automation agent on an hourly Superset tick. Your whole job this run is: look at the Fluncle render queue, and if there is a finding waiting for a video, film and ship **exactly one** — the oldest — using the `@fluncle-video` skill end to end. Then stop. If the queue is empty, stop immediately and do nothing.

This is the entire task. Do not batch. Do not "catch up" the backlog. One finding per tick.

## The one invariant that makes re-runs safe

Superset delivery is **at-least-once** — this prompt may fire more than once for the same tick, or overlap a slow run. Do **not** add your own locks or state. Safety comes from the queue itself: `fluncle admin queue` returns only findings whose `video_url` is unset, oldest first. The moment a finding is shipped, `fluncle admin track video` sets its `video_url`, so it **leaves the queue** and the next run cannot pick it again. So:

- Always re-read the queue at the START of the run. Never trust a finding id from a previous run.
- A finding is "claimed" the instant its `video_url` is set (the ship step). Until then it is fair game; after then it is invisible to the queue. There is no intermediate lock — and you do not need one, because you film at most one per run and the queue gates it.
- If two runs race on the same head, the worst case is one wasted render, never a double-published video: the second `track video` upload just re-points `video_url` at the same finding. This is acceptable; do not engineer around it beyond the queue gate.

## Steps

Run from the root of a Fluncle repo checkout. Use `bun`, never npm/pnpm/yarn.

### 1. Read the queue head

```
fluncle admin queue --limit 1 --json
```

This returns `{ "ok": true, "tracks": [ ... ] }`. Each entry has `trackId`, `logId`, `title`, `artists`, and (for queue items) no `videoUrl`.

- **Empty queue** — if `tracks` is `[]`, **STOP NOW**. Every finding already has a video; there is nothing to film. Do not render, do not post anything, do not write any output. Exit silently with a one-line note that the queue was empty.
- **A finding is waiting** — take `tracks[0]`. That is THE finding for this run — the oldest one without a video. Record its `trackId` and `logId`. You will film this one and only this one.

A finding with no `logId` cannot be shipped (ship requires a Log ID). If `tracks[0]` is missing `logId`, stop and report it as a blocker (the operator backfills the ISRC) rather than rendering an unshippable video.

### 2. Diversity check (do not skip)

```
fluncle admin vehicles --json
```

This returns `{ "ok": true, "vehicles": [ ... ] }`, recently-used vehicles newest first — the diversity ledger (doctrine 3 of the `@fluncle-video` skill). Read the recent `vehicle` values and pick a medium/primitive clearly DIFFERENT from the last few; also fetch a couple of recent posters as the skill describes. Never repeat the most-recent vehicle unless the music genuinely demands it.

### 3. Render the video — via `@fluncle-video`, end to end

Run the `@fluncle-video` skill against this finding's `trackId`. Follow its workflow exactly (it is the constitution): props → metadata → concept (vehicle first, honoring the diversity check above) → author the composition in `workbench/` → still-critique loop (minimum two rounds, VIEW the stills) → gates (`typecheck` + `oxlint`) → render and wait for the encode to finish → confirm with `ffprobe` (1080×1920, h264, aac, 15–30s).

Do **not** shortcut the skill. The hourly cadence does not justify skipping the critique loop or the gates — a bad video that ships is worse than a tick that produced nothing.

### 4. Ship — package, upload, link

Per the skill's ship step:

```
bun run --cwd packages/video ship <log-id> --vehicle "<your vehicle>"
fluncle admin track video <log-id> --dir packages/video/out/<log-id>
```

The `track video` upload sets the finding's `video_url`. **This is the act that removes the finding from the queue** and makes this run idempotent. Confirm it succeeded before you consider the run complete.

### 5. Stop

You have filmed exactly one finding. **Do not loop back to step 1 to film another.** One finding per tick — the next tick films the next one. Output a tight report (finding `logId`/title, vehicle + texture family, the one-line concept, the metadata-to-pixels trace, the shipped `video_url`) and exit.

## Hard rails (these survive even if the rest is skipped)

- **Exactly one finding per run.** Never film a second, even if the queue still has entries. The hourly tick is the throttle.
- **Empty queue is a silent no-op.** No render, no post, no output beyond a one-line "queue empty".
- **Never auto-publish to social.** Shipping uploads the R2 bundle and sets `video_url`; posting to TikTok/any platform stays a separate, manual, approval-gated step. Do not post.
- **Audio: the pipeline resolver only (Deezer/iTunes).** Never source from YouTube or rip full tracks. No legal audio → no video; stop and report.
- **Never commit or push.** The composition lives in the gitignored `workbench/`; the durable artifact is the R2 bundle. Nothing enters git.
- **Re-runs must not double-render.** Trust the queue gate. Always re-read the queue at the start; never carry a finding id across runs.
