# Track Lifecycle

Canonical architecture for what happens to a track from the moment Fluncle finds it. This is a **stable reference** — the durable contract the surfaces and agents build against. (Living, changeable plans live in [ROADMAP.md](./ROADMAP.md); this is not that.)

The shape in one line: **adding a track is fast and synchronous; enriching it is slow and asynchronous.** A find is listenable the instant it's added; everything expensive (audio analysis, the video, sub-genre tags) arrives a little later, written back by an agent.

## Why two phases

`apps/web` runs as a Cloudflare Worker — HTTP only, no `ffmpeg`, tight CPU/time limits. Audio analysis and video rendering need `ffmpeg` + real compute, which can only run off-Worker (locally, or on an agent runtime). So the work splits cleanly along that line, and the constraint becomes the design.

## Phase 1 — Add (synchronous, in the Worker)

Triggered by `fluncle admin add <spotify-url>` → `POST /api/admin/tracks` → `publishTrack()` (`apps/web/src/lib/server/publish.ts`). Everything here is cheap HTTP, so the track is in the playlist and visible within one request:

- **Spotify** metadata: title, artists, album, artwork, `duration_ms`, `isrc`, `popularity` (`spotify.ts`).
- **Deezer** (by ISRC, best-effort): record `label` + a `preview_url` (`deezer.ts`).
- **Log ID**: the permanent Galaxy coordinate, generated and stored (`log-id.ts`). This is the cross-surface marker — `fluncle://<id>` — used everywhere (web `/log/<id>`, SSH, CLI, TikTok). It supersedes any ad-hoc post marker.
- Publish to the Spotify playlist + Telegram.

The track is now real, listenable, and shows its identity (coordinate, label, duration). The audio-derived fields are not set yet — they show as "processing" until Phase 2 lands.

## Phase 2 — Enrich (asynchronous, on a Spinup agent)

After a successful add, the Worker fires a **Spinup agent** (via the Spinup runtime API) with just the `trackId`, fire-and-forget (`ctx.waitUntil`, so it never blocks the add response). The agent has what the Worker can't: a repo checkout, the admin Fluncle CLI, `ffmpeg`, Remotion, and R2 credentials. Given one track ID, it:

1. **Resolves + analyzes the preview audio** — BPM, musical **key** (+ confidence), and spectral features (brightness, sub-bass weight, mid-band flatness) via the DSP pipeline (`packages/video/src/pipeline/analyze-audio.ts`). The audio is the trustworthy source — see "Tags" below.
2. **Derives a sub-genre suggestion** from those features (liquid ↔ neuro ↔ jungle/dancefloor), normalized through the dnb sub-genre allow-list (`tags.ts`).
3. **Renders the video** (the `packages/video` kit) and uploads the MP4 to **Cloudflare R2**; the public URL becomes `video_url`.
4. **Writes everything back** through `fluncle admin track update <id>` — `bpm`, `key`, `tags` (as `auto`), `video_url`, and flips `enrichment_status` to `done`.

This takes a while, and that's fine: the find was already live. When it finishes, the analysis fields and the video appear across the Galaxy.

This same agent is the front half of the [TikTok pipeline](./tiktok-brief.md) (treat that brief as intent, not spec): once it has the video + tags, its next step is to push a TikTok draft (video without audio + a caption built from the tags). One async worker, many outputs.

## The update path

Phase 2 needs to write back, and the operator needs to curate — so tracks are mutable after add, through one generic, admin-only command:

```
fluncle admin track update <track_id> --tag <t> --tag <t> --bpm <n> --key "<k>" --video-url <url> ...
```

Backed by `PATCH /api/admin/tracks/:id`. It writes an **allow-list of curation/enrichment fields only** — `tags`, `bpm`, `key`, `video_url`, `enrichment_status`, `note`. Identity fields (title, artists, Spotify ids, Log ID) are **immutable** — they come from Spotify and never change.

## Tags & provenance

Crowd-sourced tags (Last.fm and the like) proved untrustworthy — folksonomy that conflates remixes with originals and collides on artist names — and no free API (Spotify, Discogs) reliably knows the sub-genre. So tags come from exactly two trustworthy sources, tracked by `tags_source`:

- **`auto`** — the agent's audio-derived suggestion (Phase 2). Honest, from the actual signal.
- **`manual`** — set or confirmed by an admin via `track update`. **Manual always wins and is never overwritten by the agent.**

That flag is also the **training signal**: every `manual` track is a labeled example of {audio features → sub-genre}, which later feeds a small classifier (see ROADMAP). Tags stay "best-effort discovery fuel," never canonical facts; the reliable auto-signal at add time is the `label`.

## Data model (the enrichment fields)

On the `tracks` table, beyond Phase-1 identity/metadata:

| Field                                                       | Set by             | Notes                                                         |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `log_id`                                                    | Phase 1            | permanent Galaxy coordinate; the cross-surface marker         |
| `isrc`, `label`, `preview_url`, `popularity`, `duration_ms` | Phase 1            | cheap HTTP enrichment                                         |
| `bpm`, `key`                                                | Phase 2 (agent)    | audio-derived; key carries a confidence the agent may gate on |
| `tags` (`tags_json`)                                        | Phase 2 or admin   | dnb sub-genres only (`tags.ts` allow-list)                    |
| `tags_source`                                               | whoever wrote tags | `auto` \| `manual`; manual wins                               |
| `video_url`                                                 | Phase 2 (agent)    | R2-hosted MP4; surfaced as the web preview                    |
| `enrichment_status`                                         | both               | `pending` (after add) → `done` \| `failed`                    |

## Surfacing

Surfaces show a field only when it's present, and a track whose `enrichment_status` is `pending` reads as still being analyzed (in the recovered-telemetry register, per VOICE.md — e.g. "Analysing the signal…", not a sterile spinner). Once enrichment lands, BPM, key, tags, and the video all appear. The music never waits on any of it.
