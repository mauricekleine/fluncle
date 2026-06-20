# Track Lifecycle

Canonical architecture for what happens to a track from the moment Fluncle finds it. This is a **stable reference** — the durable contract the surfaces and agents build against. (Living, changeable plans live in [ROADMAP.md](./ROADMAP.md); this is not that.)

The shape in one line: **adding a track is fast and synchronous; enriching it is slow and asynchronous.** A find is listenable the instant it's added; everything expensive (audio analysis, the video) arrives a little later, written back by an agent.

## Why two phases

`apps/web` runs as a Cloudflare Worker — HTTP only, no `ffmpeg`, tight CPU/time limits. Audio analysis and video rendering need `ffmpeg` + real compute, which can only run off-Worker (locally, or on an agent runtime). So the work splits cleanly along that line, and the constraint becomes the design.

## Phase 1 — Add (synchronous, in the Worker)

Triggered by `fluncle admin add <spotify-url>` → `POST /api/admin/tracks` → `publishTrack()` (`apps/web/src/lib/server/publish.ts`). Everything here is cheap HTTP, so the track is in the playlist and visible within one request:

- **Spotify** metadata: title, artists, album, artwork, `duration_ms`, `isrc`, `popularity` (`spotify.ts`).
- **Deezer** (by ISRC, best-effort): record `label` + a live `preview_url` (`deezer.ts`). This is a fallback pointer for `/api/preview`, not a durable media artifact.
- **Log ID**: the permanent Galaxy coordinate, generated and stored (`log-id.ts`). This is the cross-surface marker — `fluncle://<id>` — used everywhere (web `/log/<id>`, SSH, CLI, TikTok). It supersedes any ad-hoc post marker. When Spotify omits the ISRC, the add flow looks it up on Deezer (search by artist + title, duration-confirmed) **before** the coordinate is computed, so the hash seeds from the recording's real identity; the Spotify id remains the last-resort seed.
- Publish to the Spotify playlist + Telegram.

### The log page (`/log/<id>`)

Every coordinate-bearing finding has a permanent web surface at `https://www.fluncle.com/log/<log-id>` — the archival-plate register: server-rendered definitional prose (the coordinate as subject, in both the bare and `fluncle://` forms), the decode, logbook fields, the finding's footage, and `MusicRecording` JSON-LD carrying the Log ID as two `identifier` PropertyValues. The full enumeration lives at `/log` and in `sitemap.xml` (per-finding `lastmod` from `coalesce(updated_at, added_at)`). The cinematic register of the same entry is the Stories dialog over the home feed (route-masked to the same URL); `/stories/<id>` 301s here. **No Log ID → no log page**: a straggler shows a bare `#NN` in the feed until its coordinate is backfilled (below).

The track is now real, listenable, and shows its identity (coordinate, label, duration). The audio-derived fields are not set yet — they show as "processing" until Phase 2 lands.

## Phase 2 — Enrich (asynchronous, on a Spinup agent)

After a successful add, the Worker fires a **Spinup agent** (via the Spinup runtime API) with just the `trackId`, fire-and-forget (`ctx.waitUntil`, so it never blocks the add response). The agent has what the Worker can't: a repo checkout, the admin Fluncle CLI, `ffmpeg`, and Remotion. It does **not** hold any platform secret — R2, Postiz, and Turso all live on the Worker, and the agent reaches them only through the authenticated admin API (it carries just its admin token). Given one track ID, it:

1. **Resolves + analyzes the preview audio** — BPM, musical **key** (+ confidence), and spectral features (brightness, sub-bass weight, mid-band flatness) via the DSP pipeline (`packages/video/src/pipeline/analyze-audio.ts`). The feature vector is kept as training data for the future vibe-placement model — see "Vibe placement" below.
2. **Stores the exact analyzed preview** through `fluncle admin track preview-archive` at an operator-only archive path in R2. This is private analysis/model-training input, not public media, not a playback source, and never a full song.
3. **Renders the video** (the `packages/video` kit) and uploads the bundle with `fluncle admin track video`. The CLI uploads each artifact **directly to R2** via short-lived presigned PUT URLs the Worker signs (`POST .../video/uploads` → PUT to R2 → `POST .../video/finalize`), so large cuts bypass Cloudflare's ~100MB edge body limit; the **Worker** signs the URLs and sets `video_url` to the review cut, and never hands R2 credentials to the agent. (A small bundle can still use the legacy single multipart `POST /api/admin/tracks/:id/video`.)
4. **Writes the analysis back** through `fluncle admin track update <id>` — `bpm`, `key`, `features` — and flips `enrichment_status` to `done`.

This takes a while, and that's fine: the find was already live. When it finishes, the analysis fields and the video appear across the Galaxy.

**Runtime split (Spinup).** The two halves have opposite resource profiles, so they can ship separately. Audio analysis is light — ffmpeg + JS DSP — and fits a microVM's current limits (it just needs `ffmpeg` pinned), so it goes first. Video rendering is heavier (headless Chromium + WebGL): Spinup has no GPU, but software rasterization (SwiftShader) is viable — a 20s clip benchmarks at ~45s software vs ~30s on Metal (~1.45×, single-threaded), so it needs a render-capable rootfs (Chromium + SwiftShader/Mesa + ffmpeg) and likely more than one vCPU, **not** a GPU. See ROADMAP.md for the build split.

This same worker feeds **Phase 3 — Publish** (below): once the video is in R2, the next step pushes a social draft. One async worker, many outputs.

## The update path

Phase 2 needs to write back, and the operator needs to curate — so tracks are mutable after add, through one generic, admin-only command:

```
fluncle admin track update <track_id> --bpm <n> --key "<k>" --features <json> --video-url <url> ...
```

Backed by `PATCH /api/admin/tracks/:id`. It writes an **allow-list of curation/enrichment fields only** — `bpm`, `key`, `features`, `video_url`, `enrichment_status`, `note`, and the vibe placement `vibe_x`/`vibe_y` (the tagging tool's write). Identity fields (title, artists, Spotify ids, Log ID) are **immutable once set** — they come from Spotify and never change. The one sanctioned exception is the straggler repair: `isrc` and `logId` accept a **one-time backfill into a null slot** (`logId: "auto"` derives the coordinate the add flow would have minted from the found date + identity); a write against an already-set value is rejected. Every public content update bumps `updated_at`; internal preview archive writes do not, because sitemap/log lastmod should reflect visible changes only.

## Preview playback vs. preview archive

Public playback is live-only. `/api/preview/:idOrLogId` tries the stored Deezer `preview_url`, refreshes Deezer by ISRC if that token died, then falls back to iTunes; it never reads archived R2 previews and sends `Cache-Control: no-store` so the relay does not become an edge-cached media tier. The operator-only archive path stores exactly one official 30s preview for private analysis. New enrichments archive the exact preview used for the feature vector; backlog backfill archives a freshly resolved official preview, which is best-effort and may differ from the bytes an older enrichment analyzed. Archive metadata stays internal (`preview_archive_*`) and is not part of `/api/tracks`.

## Vibe placement

Findings are grouped by **vibe**, not sub-genre. There's no finite, agreed drum & bass sub-genre taxonomy, and an absolute label is an argument; a _relative_ placement is answerable. The operator drops each finding on a 2D map (energy × mood) in the admin tagging tool, storing a coordinate (`vibe_x`/`vibe_y`); the quadrant is the finding's galaxy (Solar / Nebular / Lunar / Deep). This is operator-only — the enrichment agent never places a track. See [admin-tagging.md](./admin-tagging.md).

The spectral feature vector the agent stores (`features_json`) is the **training signal**: once enough findings are placed by hand, it can drive auto-placement (energy ≈ onset rate, mood ≈ brightness). Until then, placement is manual and deliberate — Fluncle's own call.

## Phase 3 — Publish (per-platform)

Once a track has a video in R2, it can go to social platforms — **never auto-posted to a public feed without a human gate.** Everything goes through **Postiz** (one integration that speaks TikTok / Instagram / YouTube), so the Worker holds a single `POSTIZ_API_KEY` instead of per-platform OAuth.

The deciding question per platform is: **can the API carry the caption, the cover, and the audio?** A platform needs the manual inbox/draft hand-off **only when it can't** — which makes TikTok the exception, not the template. If direct post carries all three, we push directly (or schedule) and skip the draft entirely.

| Platform                            | Cut pushed           | Caption               | Cover                            | Audio                                                                                                                               | Flow                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------- | --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TikTok** (live)                   | `footage-silent.mp4` | ✗ inbox drops it      | ✗ set in-app                     | ✗ licensed sound attaches only in-app                                                                                               | **Draft → manual finish.** Lands in the @fluncle app **inbox** (`SELF_ONLY`); the operator pastes the caption from `note.txt`, sets the cover, adds the official sound, and publishes natively.                          |
| **YouTube Shorts** (live)           | `footage.mp4`        | ✓ title + description | ✓ custom thumbnail (`cover.jpg`) | ✓ the video's own (baked-in) audio                                                                                                  | **Direct public upload** (Data API v3) on the push — title/description/thumbnail all carry. Content ID typically _claims_ (rights holder monetizes, we don't) rather than blocks short clips — accepted. No in-app step. |
| **Instagram Reels** (not automated) | —                    | —                     | —                                | ✗ a baked-in master gets **muted/removed** on a business/creator account; IG's licensed library is app-only and locked for business | **Manual, in-app only.** No legitimate API path that respects the music, so the pipeline doesn't post to Instagram — any IG presence is a hand-made post.                                                                |

So TikTok keeps the `draft` step because the inbox is the only way a human can supply the caption, cover, and licensed sound; **YouTube posts directly and publicly** the moment the operator pushes (its API carries caption + cover + the video's own audio; Content ID may claim it — we accept that, the goal is reach not revenue). **Instagram is deliberately left out**: baking the master into a Reel gets muted/removed on our account type, and there's no API route to its licensed audio, so there's no clean automated path — Instagram is a manual in-app post (see the `fluncle-publish` skill).

```
fluncle admin track draft  <track_id|log_id> --platform tiktok       # TikTok: inbox draft
fluncle admin track draft  <track_id|log_id> --platform youtube      # YouTube: direct public Short
fluncle admin track social <track_id|log_id> --platform tiktok --status published --url <url>
```

`POST /api/admin/tracks/:id/social/:platform/draft` is the single push endpoint, branching by platform (`tiktok`, `youtube`): TikTok uploads `footage-silent.mp4` to the app inbox (status `draft`); YouTube uploads `footage.mp4` as a Short with the track title + `cover.jpg` thumbnail, directly and publicly (status `published`). (The `draft` verb in the path is TikTok-shaped; for YouTube the same call publishes.) Postiz doesn't return the public post URL on create, so the operator fills it (or marks `failed`) afterward via `PATCH …/social/:platform`, or from the `/admin` board. This is **not** part of the enrichment workflow — it's a separate capability (the `fluncle-publish` skill); a future single Spinup agent will chain enrich → video → publish, but they're distinct steps.

## Per-platform publication (`social_posts`)

Publication state is **per platform**, separate from the track's own pipeline (which tops out at "video in R2"). One row per `(track, platform)`:

| Field                   | Notes                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `platform`              | `tiktok`, `youtube` (Instagram is manual, not tracked here) |
| `status`                | `draft` → `scheduled` \| `published` (or `failed`)          |
| `external_id`           | the Postiz post id (for later reconciliation)               |
| `url`                   | the public post URL — set by the operator when published    |
| `scheduled_for`, `*_at` | timing                                                      |

`status` reflects the per-platform flow: a TikTok inbox push sits at `draft` (not yet public — the operator finishes it in-app); a YouTube push posts directly, landing straight at `published` (with no `url` until the operator records the public link).

There is no per-track "published" flag — a track's reach is the union of its `social_posts`. Telegram stays its own auto-post boolean on `tracks` (a different, no-review model) for now.

## Data model (the enrichment fields)

On the `tracks` table, beyond Phase-1 identity/metadata:

| Field                                                                                          | Set by                                        | Notes                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log_id`                                                                                       | Phase 1                                       | permanent Galaxy coordinate; the cross-surface marker                                                                                                                      |
| `isrc`, `label`, `preview_url`, `popularity`, `duration_ms`                                    | Phase 1                                       | cheap HTTP enrichment                                                                                                                                                      |
| `preview_archive_key`, `preview_archive_source`, `preview_archive_mime`, `preview_archived_at` | Phase 2 / backfill                            | operator-only archive path for the analyzed official preview; internal, not playback                                                                                       |
| `bpm`, `key`                                                                                   | Phase 2 (agent)                               | audio-derived; key carries a confidence the agent may gate on                                                                                                              |
| `features_json`                                                                                | Phase 2 (agent)                               | spectral vector; training data for future vibe auto-placement                                                                                                              |
| `vibe_x`, `vibe_y`                                                                             | admin (tag tool)                              | energy × mood placement; the galaxy is derived from it (`admin-tagging.md`)                                                                                                |
| `video_url`                                                                                    | Phase 2 (agent)                               | R2-hosted MP4; surfaced as the web preview                                                                                                                                 |
| `context_note`                                                                                 | Phase 2 (agent)                               | firecrawl-derived FACTS (label/year/release); internal creative fuel, never on `/log`, never quotes lyrics. Writing it alone doesn't bump `updated_at`.                    |
| `observation_audio_url`, `observation_duration_ms`, `observation_generated_at`                 | Phase 2 (agent)                               | Fluncle's spoken field observation (R2 `observation.mp3`; the `_url`'s presence is the "has observation" flag). See [observation-agent.md](./agents/observation-agent.md). |
| `enrichment_status`                                                                            | both                                          | `pending` (after add) → `done` \| `failed`                                                                                                                                 |
| `updated_at`                                                                                   | every write path that touches a VISIBLE field | last real content change; sitemap `lastmod` reads `coalesce(updated_at, added_at)`. Internal fuel writes (`features_json`, `context_note`) don't bump it.                  |

## Surfacing

Surfaces show a field only when it's present, and a track whose `enrichment_status` is `pending` reads as still being analyzed (in the recovered-log register, per VOICE.md — e.g. "Still listening…", not a sterile spinner). Once enrichment lands, BPM, key, the video, and the audio observation all appear. The music never waits on any of it.
