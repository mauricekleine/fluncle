# Track Agent Bootstrap (enrich → video → publish)

Fluncle is Maurice's drum & bass publishing brand. The enrichment agent is the **async half of the track lifecycle**: the fast metadata add already happened (the track is live and listenable), and the rest fills in a little later — first the analysis (**BPM, musical key, and a spectral feature vector**), then — when the video kit is present — the **per-track video**, and finally the **social draft**. This doc is the bootstrap that points each capability at its real instructions.

These are three capabilities, each its own skill, run in order: **enrich → video → publish**. The **enrichment** step is live: it runs as the on-box `fluncle-enrich` `--no-agent` cron on Hermes (every 5 min), which reads the enrich worklist (`fluncle admin tracks enrich --queue`), runs the self-contained `analyze-track` script on-box (`ffmpeg` + `bun`), and writes the result back via `fluncle admin tracks update`. **The analysis source is the captured full song, not a 30s preview:** when the separate `fluncle-capture` side-channel has landed a finding's `source_audio_key`, the sweep S3-GETs those bytes from the PRIVATE `fluncle-source-audio` bucket and passes `--audio-file`, so the analyzer decodes the WHOLE song and skips preview resolution entirely; only a finding with no captured song falls back to a preview. The write-back records that provenance as `analyzed_from` (`full` \| `preview`), and a capture landing later re-queues any row not yet analyzed from full audio. There is **no on-add trigger**: a new find lands at the schema default `enrichment_status = "pending"` (queue-eligible), so the cron picks it up on its next tick. Video + publish run as their own steps on the Hermes runtime (see [track-lifecycle.md](../track-lifecycle.md) for the phases and the cron model under [hermes/cron/](./hermes/cron/)). The contract is the same for all three: each reads/writes only through the authenticated **`fluncle` CLI** (a thin client over the admin API); the Worker owns every secret (R2, Postiz, Turso) and the agent holds only its admin token.

It is meant to run **anywhere**: the enrichment cron runs on the Hermes box, and the script also runs locally on Maurice's machine. Its input is always one Fluncle **track id** or **log_id**, and nothing else.

## What it needs

- `bun` (runs the analysis script) and `ffmpeg` (decodes the audio — the captured full song, or a preview when there is none);
- the `fluncle` CLI installed and, for the write step, authenticated (`FLUNCLE_API_TOKEN`); reads are public;
- network access (the Fluncle API; Deezer/iTunes only for the preview fallback). The on-box sweep additionally holds read-only R2 credentials for the private `fluncle-source-audio` bucket, so it can fetch the captured full song.

It does **not** need a checkout of this repo. The enrichment skill is self-contained.

## Its constitution

**The full operating instructions are the `fluncle-track-enrichment` skill, not this doc.** Read it and follow it step by step:

- `packages/skills/fluncle-track-enrichment/SKILL.md` — the get → analyze → archive → update loop, the rules (key honesty, never invent data), and its self-contained `scripts/analyze-track.ts`.
- Install standalone (e.g. on the Hermes box): `npx skills add https://github.com/mauricekleine/fluncle/tree/main/packages/skills/fluncle-track-enrichment`. The analysis script has zero npm dependencies and no Fluncle imports, so it runs wherever the skill is installed.
- `docs/track-lifecycle.md` is the canonical architecture (sync add vs async enrich, the Worker/ffmpeg constraint, the feature vector, R2 ownership).

## Preview archive (private analysis only)

When the enrichment script resolves a preview (the fallback path, and `--archive-dir` on any run), it can export the exact official 30s clip. Store that file with:

```
fluncle admin tracks preview <track_id|log_id> --file <file> --source <source> --mime <mime>
```

This writes to an operator-only archive path in the PRIVATE `fluncle-source-audio` bucket (`<logId>/preview.<ext>` — REF-05 moved it off the world-served `fluncle-videos` bucket) and records internal `preview_archive_*` metadata. It is for private analysis/model training only: the archive key is not exposed through public DTOs, never appears in UI/RSS/sitemaps, and `/api/preview` never reads it. Public playback stays live-only through Deezer with iTunes fallback and `Cache-Control: no-store`. This command archives previews only — the **full song** reaches the same private bucket through its own `fluncle-capture` side-channel (`source_audio_key`), never through here. Backlog backfill is best-effort and archives the freshly re-resolved official preview; note that under full-song analysis the archived preview is no longer necessarily the audio the feature vector was computed from.

## Video render (separate, requires the kit)

Rendering the per-track video is a **separate capability** — Remotion needs the `packages/video` kit present (a repo checkout / prebuilt image), which the self-contained enrichment skill deliberately does not carry. Its doctrine lives in the **`fluncle-video` skill** (`packages/skills/fluncle-video/SKILL.md` + `references/`); `packages/video/README.md` is the code-of-record for the surface and props contract. The kit's ship step produces a **two-master** bundle under `out/<log-id>/`: `footage.mp4` (the clean square 1920×1920 crop source), `footage.social.mp4` (the portrait 1080×1920 baked-text social cut — the playable one), `poster.jpg`, `cover.jpg`, and `note.txt` (the caption), plus optional extras when rendered. The audio-less `footage-silent.mp4` is **retired** — surfaces derive a silent cut on the fly through an `audio=false` Cloudflare Media Transformation, so no silent file is shipped ([docs/video-variants.md](../video-variants.md)). Upload the whole bundle in one call:

```
fluncle admin tracks video <track_id|log_id> --dir out/<log-id>
```

The CLI uploads each artifact **directly to R2** via short-lived presigned PUT URLs the Worker signs (`POST .../video/uploads` → PUT each file to its R2 S3 URL → `POST .../video/finalize`), so the bytes never traverse the Worker and a large (crf-20, ~99MB/cut) bundle bypasses Cloudflare's ~100MB edge body limit. Each artifact lands at `<log-id>/<name>` on R2 (`found.fluncle.com`) and `video_url` is set to the review cut. **The Worker owns R2; the agent uploads with its admin token and never holds R2 credentials** — it only ever sees the expiring presigned URLs. Requires the track to have a Log ID (one identity everywhere). (Small bundles can still use the legacy single multipart `POST /api/admin/tracks/:id/video`.)

## Publish draft (separate, via Postiz)

Once the bundle is in R2, the track can go to social platforms — **as a draft, never auto-posted.** On TikTok the official sound attaches only in-app, so the agent pushes an **audio-less** rendition of `footage.social.mp4` (derived on the fly via an `audio=false` Media Transformation — there is no stored silent file) + the caption as a private (`SELF_ONLY`) draft, and the operator adds the sound and publishes natively. Doctrine is the **`fluncle-publish` skill** (`packages/skills/fluncle-publish/SKILL.md`); the model is [track-lifecycle.md](../track-lifecycle.md) Phase 3 + the per-platform `social_posts` table. Drafts go through **Postiz** — one `POSTIZ_API_KEY` on the Worker, no per-platform OAuth:

```
fluncle admin tracks draft  <track_id|log_id> [--platform tiktok]                                  # → inbox draft
fluncle admin tracks social <track_id|log_id> [--platform tiktok]                                  # show status
fluncle admin tracks social <track_id|log_id> --platform tiktok --status published --url <url>     # record outcome
```

- `track draft` → `POST /api/admin/tracks/:id/social/:platform/draft`: for TikTok the Worker hands Postiz the silenced (`audio=false` MT) social cut and creates a `content_posting_method: UPLOAD` + `SELF_ONLY` post, sent immediately, which lands in the TikTok app **Inbox** (the `tiktok.com/messages` notification — _not_ Create → Drafts). Returns the Postiz post id, recorded in `social_posts`.
- `track social` with no `--status` → `GET …/social` lists per-platform state; with `--status` → `PATCH …/social/:platform` records `scheduled` / `published` (+ the live URL) or `failed`.

The agent never holds the Postiz key — the Worker owns it, same pattern as R2.

## Audio observation (separate, after video)

Once a track has its enrichment and (for the spoken script's creative fuel) ideally its video, the agent can mint the **audio observation** — Fluncle's spoken field observation, rendered with Cartesia and stored beside the video bundle at `<log-id>/observation.{mp3,txt,json}`. The agent authors + voice-gates the script (it holds `copywriting-fluncle`); the Worker fetches the factual context, re-scans, renders, uploads, and writes back. One command:

```
fluncle admin tracks observe <track_id|log_id> --script-file observation.txt
```

Its full doctrine is **[observation-agent.md](./observation-agent.md)** (the two artifacts, the voice gate, the safety rails — facts only, no lyrics, no commercial track audio). `observe` is auto-allowed but spends a paid render per call, so de-dupe per Log ID. The Worker owns the firecrawl + Cartesia secrets; the agent holds only its admin token.

## Safety rails (inline so they survive even if the skill fails to load)

- One track per run.
- **Audio is INTERNAL-ANALYSIS-ONLY, and PUBLIC PLAYBACK IS LIVE-ONLY.** These are two separate rails, and the split is the whole safety story:
  - _Analysis input._ The analyzer reads the **captured full song** the `fluncle-capture` side-channel stores in the PRIVATE `fluncle-source-audio` bucket (captured once with `yt-dlp`, by design), else a Deezer/iTunes 30s preview from the script's own resolver. Those bytes exist to be measured — BPM, key, the feature vector, the MuQ embedding — and for nothing else. They are never published, never linked, never world-served, and never a playback source; the bucket is private and its keys are stripped from every public DTO. As the enrichment agent you never fetch audio yourself: you analyze what the sweep hands you (`--audio-file`) or what the resolver returns. No audio at all means no analysis; stop and report (`--status failed`).
  - _Public playback._ Live-only, always: `/api/preview` relays Deezer with an iTunes fallback and `Cache-Control: no-store`. It never reads the archive, never reads the captured song, and neither ever becomes a media tier.
- Archive only the official preview, through the operator-only archive path (the `tracks preview` command). It is not public media and not a playback source.
- Never invent data. Write only what the audio yielded; respect the script's `null` key (atonal tracks key weakly — better null than wrong). The agent writes analysis only; manual vibe placement is retired — sonic grouping comes from the MuQ embedding.
- On-screen video copy passes VOICE.md; every on-screen fact comes from the track's props, which is authoritative. Render only fields the props expose; never invent one.
- The brand constants are not the agent's to restyle: if a concept fights the grammar, change the concept.
- The agent's outputs are the written-back metadata, the uploaded video bundle, a **private** social draft, and a run report — nothing public. **Never publish, never attach a sound, never delete.** `track draft` is `SELF_ONLY`/`UPLOAD` by construction; the operator reviews in-app, attaches the official sound, and presses publish — then a human records the outcome with `track social --status published --url …`.
