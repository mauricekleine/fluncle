# The set video — the hour-long artwork (Unit O)

The set video is a mixtape's fiction made visible: **Fluncle dreaming, the set travelling through the findings' own worlds.** Where a per-track clip is one finding under the eclipse, the hour render is the whole mixtape as one continuous piece — each chapter is a finding's archived composition re-driven at chapter length, the transitions are travel between worlds, and a single set-level trajectory (the dreamer's continuity) breathes across the whole thing so it reads as a piece, not a playlist. The Log ID names each finding as it arrives (that moment doubles as a YouTube chapter) and the piece ends on the mixtape's `F`-marked coordinate.

This is the offline sibling of Fluncle Live (the live+longform RFC, Unit O; shipped #287–#291, now in git history). The live glass and this hour render share the spine but ship independently. The machinery lives in [`packages/video/src/set-video/`](../packages/video/src/set-video); the creative kit it renders against is unchanged (`packages/video/src/remotion/cosmos.ts`, the fluncle-video skill).

## The one command

The full hour is the operator's evening GPU job. From `packages/video`:

```bash
bun run set:render <mixtapeLogId>
# e.g. bun run set:render 019.F.1A
```

That builds every chapter from the mix-in offsets, renders the parent composition in resumable frame-range chunks, concatenates them with `-c copy`, and muxes the mastered set audio once (48 kHz AAC), landscape 1080p. Output: `packages/video/set-out/<mixtapeLogId>/set.mp4`, plus `stills/`, `prep-report.json` (the per-chapter audit), and `qa.json` (the gate verdicts).

Distribution follows the mixtape runbook (`packages/skills/fluncle-mixtapes`): the `set.mp4` path on R2 (`found.fluncle.com/<logId>/set.mp4`, range-streamed) + YouTube with chapter markers derived from the Log-ID moments.

### The pilot (validate one chapter before the hour)

```bash
bun run set:render <mixtapeLogId> --pilot <findingLogId> --draft
# e.g. bun run set:render 019.F.1A --pilot 012.2.4L --draft
```

Preps + analyzes + renders **one** chapter end-to-end (draft quality, half-res), with stills across it, so you can confirm the arc is alive (no freeze), the Log-ID moment lands, and landscape reflows cleanly — without paying for the hour. Draft mode is never shippable (half-res + jpeg hide the load-bearing grain); it is a motion/direction proof only.

## The pipeline

Four modules under `src/set-video/`, each with tests inside it:

1. **`chapter-prep.ts` — the transform.** Fetches a finding's archived `composition.tsx` + `props.json` from R2 and turns it into a chapter-ready comp. An archived comp re-drives correctly at chapter length **inside a `<Sequence>`** — Remotion scopes `useVideoConfig().durationInFrames` to the sequence and `useCurrentFrame()` to its start, so everything on `useJourney()`/`u_progress`/the audio bus reflows for free (032-class comps need nothing more). The **one** defect is absolute-second keyframes: a scene easing its arc with `interpolate(sec, [0, 13, 20], …)` (`sec = frame / fps`) clamps at the authored 20 s, so a 4-minute chapter freezes at 20 s (a permanent settle-dim + a spent one-shot climax). The transform finds every clock-driven `interpolate(…)`, **classifies** it, and rewrites it:
   - **whole-clip ramp** (starts ~0, ends ~authored length) → **rescaled**: keyframes × `scale` (`chapterMs / authoredMs`), so the ease spans the whole chapter.
   - **tail settle/event** (a short window pinned to the authored end) → interior chapter **suppressed** (held at the pre-settle value, no mid-set dim); final chapter **shifted** to the set's own tail so the piece resolves.
   - **interior one-shot** (a mid-clip climax) → **left** as data, flagged for judgment (drive it from the chapter drop envelope if it should re-slam).
     It also strips `<TrackAudio>` (audio is muxed once, at the end) and emits a per-comp **audit report** (what was rescaled/suppressed, judgment flags). Prepped comps land in the gitignored `src/remotion/set-workbench/<logId>.tsx` (the same auto-registration contract as the per-track workbench).

2. **`chapter-props.ts` — the audio.** Slices the mastered set audio at the cue boundaries (ffmpeg) and analyzes each slice into a **full-length** per-chapter `CosmosAudio` — the whole chapter is on screen, so every second becomes reactive curves (energy/bass/mid/treble + the fine sub/kick/snare/air bands + flux), not a 20 s window. It reuses the exact shared DSP kernel (`pipeline/audio-curves.ts`) and the render-path estimators (`pipeline/analyze-audio.ts`) + the set-path multi-drop picker (`pipeline/analyze-set.ts`) — no DSP is forked. It passes **multiple `dropCandidates`** so a long chapter can re-slam; a chapter that should re-slam either wires those in or leans on the continuous energy/swell envelopes (a pinned `reactivity.drop.peakTimeMs` fires only once — the audit report flags it).

3. **`set-composition.tsx` — the parent.** ONE Remotion composition: a `<Series>` of chapter `<Sequence>`s, cue-timed to the real mix-ins; **travel transitions** straddling each seam (a directioned star-warp interstitial keyed on both neighbours' palettes — travel between worlds, not a video dissolve); the **dreamer's-continuity** driver (a gentle set-level vignette that breathes with the set energy trajectory so the hour is one piece); a per-chapter **Log-ID moment** at each mix-in (the finding named on arrival — also a YouTube chapter); and the final **mixtape close** on the `F`-coordinate. `calculateMetadata` sums the chapters. Its own Remotion entry (`set-root.tsx` / `set-entry.ts`) keeps the hour render fully isolated from the per-track `root.tsx`.

4. **`render-set.ts` — the orchestrator.** Builds the chapter plan from the mix-in offsets (sorts, dedupes fingerprint ties, makes chapters contiguous over `[0, setEnd]`), assembles every chapter (prep + slice-analyze), then renders the parent composition in **frame-range chunks**. Remotion determinism makes chunk boundaries byte-consistent, so the chunks concat with `-c copy` (no re-encode generation — the grain never suffers) and the set audio is muxed once. Chunked = **resumable** (a re-run skips chunks already on disk), parallelizable, and QA-able per chunk.

## Chunking & resume

`render-set` renders `~40 s` chunks (`--chunk-sec N` to tune) to `set-out/<mixtapeLogId>/chunks/`. Each chunk starts on an IDR frame, so `ffmpeg -f concat -c copy` stitches them without re-encoding. A crashed or interrupted run **resumes** — a chunk already on disk (non-empty) is skipped, so only the missing frames re-render. The final `-c copy` concat + single audio mux is cheap.

Full renders use the RFC §6 encode (h264, `crf 20` under a `~22 Mbit` VBV cap, `bt709`, PNG intermediates); `--draft` drops to half-res / `veryfast` / jpeg for a fast proof and is never shippable.

## QA

- **Arc gate per chapter** — `judge:metrics` (`analyze-motion.ts`) runs on the rendered piece; a chapter-length clip evolves _more_ than a 20 s clip, so it passes the arc floor comfortably (the recalibration note + a chapter-length reference verdict live in `packages/video/calibration/verdicts.json`). The gate's `qa.json` is written beside the output.
- **Flash on transition spans** — the travel transitions are the only fast-motion moments; the flash gate covers the chunks that span a seam (and the composited whole).
- The whole-piece read is judged off the set energy envelope (the dreamer's continuity is derived from `analyze-set.ts`'s `StudioEnvelope`).

## The data source

A mixtape's stored cues currently carry `null start_ms`, so the ground-truth mix-in offsets come from **fingerprint alignment** of the planned previews against the set audio (the de-risk spike, 2026-07-03: cosine 0.87–0.985, correct ordering). For `019.F.1A` those verified offsets are committed as fixtures under `src/set-video/__fixtures__/019.F.1A.{anchors,tracklist}.json` (provenance: the plan-pointer fingerprint walkthrough). Once the recording cue rail persists real `start_ms`, `render-set` reads them live; until then it reads the fixtures. Chapters always have a Log ID + a rendered archived video (mixtapes never carry out-of-canon songs), so no default/holding scenes appear in the hour render.

## The overlay policy

The set renders with `hideOverlay: true`, so each chapter's own `TypePlate` + `CloseCard` self-suppress (they read `getInputProps().hideOverlay`). The set draws its own type layer — the per-chapter Log-ID moment and the final close — with the lower-level `FloatingType` primitive (which does not read `hideOverlay`). So interior chapters carry no per-chapter close and no mid-set settle-dim; the identity spine (the Log ID names every finding) and the single ending are the set's own.
