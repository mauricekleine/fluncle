# Set-video fixtures

Ground-truth data for the Unit O set-video pipeline (`render-set.ts`), used because a mixtape's stored recording cues currently carry `null start_ms`.

- **`019.F.1A.anchors.json`** — the per-track mix-in offsets (`bestMs`) for mixtape `019.F.1A`, derived by **fingerprint alignment** of each planned track's official 30 s preview against the mastered set audio (the live-longform de-risk spike, 2026-07-03: preview→set alignment at cosine 0.87–0.985 with correct ordering). `render-set.ts` builds the chapter plan from these until the recording cue rail persists real `start_ms`.
- **`019.F.1A.tracklist.json`** — the planned tracklist (log id, title, artists, bpm, preview url, duration) for the same mixtape, from the plan pointer. Kept for reference/ordering; the chapter plan needs only the anchors' `logId` + `bestMs`.

Provenance: both are copied verbatim from the plan-pointer fingerprint walkthrough that validated plan-scoped fingerprinting (RFC §Sequencing de-risk 1c). They are inputs for the hour render, not test assertions — the pure transforms are tested against synthetic fixtures inline in `chapter-prep.test.ts` / `render-set.test.ts`.
