---
name: fluncle-track-enrichment
description: Enrich a Fluncle track from audio — analyze the captured full song when it exists (else a 30s preview) for BPM, musical key, and a spectral feature vector, then write them back via the fluncle CLI. Use when given a Fluncle track id or log_id to analyze/enrich, when computing key/BPM for a track, or when running the track enrichment agent (locally or on the Hermes box). The feature vector is internal creative fuel (the vibe-placement model it once fed is retired); sonic similarity now comes from the separate MuQ audio-embedding step (the fluncle-embed cron).
---

# Fluncle track enrichment agent

You turn one Fluncle track into trustworthy, audio-derived metadata: **BPM, musical key, and a spectral feature vector** — written back to the track. You are given a Fluncle **track id** or **log_id** and nothing else.

This is the async half of the track lifecycle (the fast metadata add already happened; the track is live and listenable). Nothing you do blocks the music — you fill in the analysis a little later.

## Requirements

- **`ffmpeg`** on PATH (decodes the audio — the captured full song, or a preview when there is none).
- **`bun`** (runs the analysis script).
- The **`fluncle` CLI** installed and, for the write step, authenticated (`FLUNCLE_API_TOKEN`). Reads (`fluncle tracks get`) are public.
- Network access (the Fluncle API; Deezer/iTunes only for the preview fallback).

The analysis script (`scripts/analyze-track.ts`) is **self-contained** — zero npm dependencies, no Fluncle imports — so it runs anywhere this skill is installed.

## Workflow

1. **Get the track.** Resolve your input (id or log_id) to metadata:

   ```
   fluncle tracks get <track_id|log_id> --json
   ```

   Keep the `trackId`, `artists`, `title`, and `isrc` from the result. (You write back by `trackId`.)

2. **Analyze the audio.** Prefer the captured full song: pass `--audio-file <path>` and the analyzer decodes that file directly and skips preview resolution entirely. This is what the on-box enrich sweep does whenever a finding has a `source_audio_key`, and it matters — full-song BPM agrees with a DJ-graded Rekordbox grid to within ~0.02, where a 30s preview read low by ~1.5 BPM. With no `--audio-file` it falls back to downloading legal previews. Either way it emits an analysis JSON on stdout.

   `--archive-dir` belongs to the PREVIEW path ONLY — it preserves the exact 30s preview the feature vector was computed from. It is a no-op with `--audio-file` (announced, not silent): the preview archive takes 30s previews and never a full song, and a captured song is already stored durably in private R2 under `source_audio_key`. So there is nothing to preserve:

   ```
   bun scripts/analyze-track.ts --artist "<artist>" --title "<title>" [--isrc "<isrc>"] --archive-dir /tmp/fluncle-preview
   ```

   The output: `{ archivePreview, bpm, bpmConfidence, key, keyConfidence, features, previews }`. It resolves **multiple** previews (Deezer + iTunes are often different 30s windows of the song) and keeps the most-confident read per field. The exported `archivePreview` is exactly the preview used for the feature vector; it is an operator-only archive path input for private analysis/model training, not public playback media. Both `bpm` and `key` are `null` when confidence is low — better null than wrong (e.g. a beatless build-up preview, or an atonal track). `features` is the raw spectral vector.

3. **Archive the analysis preview.** ONLY on the preview path — `archivePreview` is absent when you analyzed a full song, and the server rejects an oversized body outright (`preview_too_large`). When it IS present, store that one official 30s preview through the admin API:

   ```
   fluncle admin tracks preview <trackId> --file "<archivePreview.path>" --source "<archivePreview.source>" --mime "<archivePreview.mime>"
   ```

   The Worker writes the bytes under an operator-only archive path in the PRIVATE `fluncle-source-audio` bucket and stores internal metadata. This copy is never linked, downloaded, streamed, or used by `/api/preview`; public playback stays live-only through Deezer/iTunes. This command is preview-only — the **full song** reaches that same private bucket through its own `fluncle-capture` side-channel (captured once for internal analysis, never published), never through here.

4. **Write it back.** Use the analysis output:

   ```
   fluncle admin tracks update <trackId> \
     [--bpm <bpm>] \
     [--key "<key>"] \
     --features '<features-json>' \
     --status done
   ```

   - Pass `--bpm` only if the analysis returned a non-null bpm (syncopated/build-up previews can't be measured — better null than a wrong guess).
   - Pass `--key` only if the analysis returned a non-null key.
   - Always pass `--features` (the JSON vector) — internal creative fuel for the video agent. It once seeded a vibe-placement model, but that is retired: audio can't learn the manual map, so sonic grouping moved to the separate MuQ audio embedding (see "Audio embedding" below). You do NOT place a track on the vibe map.
   - Set `--status done`.

That's the whole loop: get → analyze → archive → update.

## Rules

- **Never invent data.** If no audio resolves at all (no captured full song and no preview), report it and stop — don't guess BPM/key. Set `--status failed` if you want the operator to see it.
- **Archive only the analysis preview.** Store one official 30s preview, the one behind `archivePreview`, for private analysis/model training. It is not a playback source.
- **Key honesty.** Only write a key the analysis was confident about (the script already gates this; respect the `null`).
- One track per run.

## Audio embedding (separate, the `fluncle-embed` cron)

The finding's **MuQ audio embedding** — a 1024-d sonic-similarity vector (`embedding_json`) — is **not** part of this analysis loop. It is computed by its own on-box cron (`fluncle-embed`: torch/MuQ over the **captured full song**, S3-GET from the private `fluncle-source-audio` bucket — never the 30s preview, whose blind "quiet piano" vectors are exactly what the switch to full audio killed; a finding with no captured song is skipped, never preview-embedded), which writes it back through `fluncle admin tracks update <id> --embedding-file`. It powers the `/log` "more like this" row (`get_similar_findings` cosine-ranks the vectors) and the operator-named **sonic galaxies** — the browse-by-feel lens at `/galaxies`, assigned nightly by the `fluncle-cluster` cron (k-means over this space into `tracks.galaxy_id`), and later the game rendering those galaxies as spatial regions. This is what retired the manual vibe-map tagging: audio can't learn the placement, but it groups the sonically-similar cleanly. The data model + the on-box deploy: `docs/track-lifecycle.md` + `docs/agents/cluster-engine.md` + `docs/agents/hermes/cron/README.md`.

## Video render (separate, requires the kit)

Rendering the per-track video is **not** part of this self-contained skill — Remotion needs the Fluncle `packages/video` kit present (a repo checkout / prebuilt image). When the kit is available, its doctrine is the **`fluncle-video` skill**: render the bundle, then `fluncle admin tracks video <track_id|log_id> --dir out/<log-id>` uploads it and sets `video_url` (the Worker owns R2; you never hold R2 credentials). Publishing the rendered video as a social draft is a third capability — the **`fluncle-publish` skill** (`fluncle admin tracks draft`). Inside the Fluncle repo, the full chain and the kit's README are documented under `docs/` (`agents/enrichment-agent.md`, `track-lifecycle.md`) and `packages/video/README.md`.
