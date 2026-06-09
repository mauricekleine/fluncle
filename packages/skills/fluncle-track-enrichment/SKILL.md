---
name: fluncle-track-enrichment
description: Enrich a Fluncle track from audio — analyze a preview for BPM, musical key, spectral features, and a drum & bass sub-genre suggestion, then write them back via the fluncle CLI. Use when given a Fluncle track id or log_id to analyze/enrich, when computing key/BPM/tags for a track, or when running the track enrichment agent (locally or on a Spinup microVM). Also for the audio feature vector that trains the sub-genre classifier.
---

# Fluncle track enrichment agent

You turn one Fluncle track into trustworthy, audio-derived metadata: **BPM, musical key, a spectral feature vector, and a best-guess drum & bass sub-genre** — written back to the track. You are given a Fluncle **track id** or **log_id** and nothing else.

This is the async half of the track lifecycle (the fast metadata add already happened; the track is live and listenable). Nothing you do blocks the music — you fill in the analysis a little later.

## Requirements

- **`ffmpeg`** on PATH (decodes the preview).
- **`bun`** (runs the analysis script).
- The **`fluncle` CLI** installed and, for the write step, authenticated (`FLUNCLE_API_TOKEN`). Reads (`fluncle track get`) are public.
- Network access (Deezer/iTunes for the preview; the Fluncle API).

The analysis script (`scripts/analyze-track.ts`) is **self-contained** — zero npm dependencies, no Fluncle imports — so it runs anywhere this skill is installed.

## Workflow

1. **Get the track.** Resolve your input (id or log_id) to metadata:

   ```
   fluncle track get <track_id|log_id> --json
   ```

   Keep the `trackId`, `artists`, `title`, and `isrc` from the result. (You write back by `trackId`.)

2. **Analyze the preview.** It downloads a legal preview, decodes it, and emits an analysis JSON on stdout:

   ```
   bun scripts/analyze-track.ts --artist "<artist>" --title "<title>" [--isrc "<isrc>"]
   ```

   The output: `{ bpm, bpmConfidence, key, keyConfidence, features, suggestedTags, tagsSource, previews }`. It resolves **multiple** previews (Deezer + iTunes are often different 30s windows of the song) and keeps the most-confident read per field. Both `bpm` and `key` are `null` when confidence is low — better null than wrong (e.g. a beatless build-up preview, or an atonal track). `suggestedTags` is a **best guess** from the audio (may be empty); `features` is the raw vector.

3. **Write it back.** Use the analysis output:

   ```
   fluncle admin track update <trackId> \
     [--bpm <bpm>] \
     [--key "<key>"] \
     [--tag <tag> ...] --tag-source auto \
     --features '<features-json>' \
     --status done
   ```

   - Pass `--bpm` only if the analysis returned a non-null bpm (syncopated/build-up previews can't be measured — better null than a wrong guess).
   - Pass `--key` only if the analysis returned a non-null key.
   - Pass each `suggestedTags` entry as a `--tag`, with **`--tag-source auto`** (these are audio-derived guesses). If `suggestedTags` is empty, omit tags. **Manual tags always win** — the server will not let an `auto` write overwrite an operator's `manual` tags.
   - Always pass `--features` (the JSON vector) — it is the training data for the future sub-genre classifier.
   - Set `--status done`.

That's the whole loop: get → analyze → update.

## Rules

- **The sub-genre is a suggestion, not a fact.** It's stored as `auto`; a human review (`manual`) overrides it and is never clobbered. Don't oversell it.
- **Never invent data.** If no preview resolves, report it and stop — don't guess BPM/key/tags. Set `--status failed` if you want the operator to see it.
- **Key honesty.** Only write a key the analysis was confident about (the script already gates this; respect the `null`).
- One track per run.

## Video render (separate, requires the kit)

Rendering the per-track video is **not** part of this self-contained skill — Remotion needs the `packages/video` kit present (a repo checkout / prebuilt image). When the kit is available, its doctrine is the **`fluncle-video` skill** (and `packages/video/README.md`): render the bundle, then `fluncle admin track video <track_id|log_id> --dir out/<log-id>` uploads it and sets `video_url` (the Worker owns R2; you never hold R2 credentials). Publishing the rendered video as a social draft is a third capability — the **`fluncle-publish` skill** (`fluncle admin track draft`). The full chain is `docs/enrichment-agent.md` + `docs/track-lifecycle.md`.
