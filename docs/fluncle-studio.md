# Fluncle Studio — set-video staging + the footage cut

The set → clip pipeline. This doc covers the shipped **set-video staging** (Unit A — the one-time recording-upload leg that streams a set's 1080p rendition straight to R2), the **footage cut** (Unit C — the deterministic box job that turns a `pending` clip into a framed 9:16 clip on R2), and the **recording primitive** (the object a clip is now cut from — a captured set you can clip _without_ publishing it).

## The recording primitive — clip any captured set without publishing it

A **recording** is a captured DJ set that is NOT (yet) a published mixtape. It exists so the operator can salvage filmed tidbits from a set into Instagram/TikTok clips **without minting a scarce Log-ID coordinate**: mixtape coordinates are reserved exclusively for full, finished, published mixtapes, so an un-promoted recording carries **no** `fluncle://` coordinate of its own — a clip instead credits the finding(s) it plays (or the promoted mixtape's `.F.`) in its caption.

- A recording **owns its R2 key** (`recordings/<id>/set.mp4` in the public `fluncle-videos` bucket — accept-obscurity, no private bucket), owns its cues in the separate **`recording_cues`** table (finding-linked rows `{ id, findingId?, artistsText, titleText, position, startMs? }`; the legacy `tracklist_json` column was dropped in the plan→recording→mixtape Deploy-2 cutover), and is coordinate-less.
- **Create + upload is CLI** (the multi-GB rendition can't proxy through the Worker): `fluncle admin recordings create --video <set>.mov` mints the row and streams the set video straight to R2 via the multipart presign (`presign_recording_upload`). See `fluncle admin recordings …` (list/show/update/delete/promote).
- **Clip it in the Studio** at `/admin/studio/<recordingId>` (below). A clip is cut from the recording (`create_clip` → `POST /admin/recordings/{recordingId}/clips`); the box's footage cut resolves the recording's source from its `r2Key` and ships the clip **clean — no on-screen overlay** (see Unit C). The `fluncle://` coordinate rides the **caption** (`buildClipCaption`, `apps/web/src/lib/server/clip-caption.ts`, served by `get_clip_caption`), which credits the finding(s) the clip window plays — resolved honestly from the recording's `recording_cues` via `resolveClipTracks` — even for an un-promoted recording, or the promoted mixtape's `.F.` once the recording is promoted.
- **Promote to a mixtape** — `fluncle admin recordings promote <recordingId>` (or the `promote_recording` op) mints a mixtape from the recording (mint-or-reuse; idempotent), copies the set video to `<logId>/set.mp4`, seeds the tracklist, and links `mixtapes.recording_id` back. From there the existing `distribute` flow (YouTube + Mixcloud) publishes it. A mixtape's Studio _is_ its recording's Studio (mixtape #1's backfilled recording included); the plan editor (`/admin/plans`) links each take into it.

### `/admin/studio/<recordingId>` — the Studio, keyed on a recording

The Studio editor is keyed on a **recording** (loaded via `get_recording`). The preview sources the recording's owned key directly (`${FOUND_BASE}/${recording.r2Key}`); clips are created against the recording. It degrades gracefully for a raw recording: **no cover** → a neutral poster (no card image); **no energy envelope** (recordings carry no `<logId>/studio-envelope.json`) → the drop-suggestion lane is absent, manual in/out only; the **"Re-sync from cues"** live-distribution block appears only once the recording is promoted (its linked published mixtape exists).

Its left pane is the **cue-authoring editor** — the `RecordingCueRail` (net-new — the mixtape cue rail only _marks_ a pre-existing catalogue tracklist, but a recording starts EMPTY): **add a cue via the finding picker** (search canon, attach a real `finding_id` — the honest link the clip caption + the promoted spine both read; a free-text row is the escape hatch for a non-finding track), **mark it at the playhead** (reusing the `<Video>` clock + the mark-at-playhead feel), **edit/remove** it — keyed by cue `id`, persisted as the whole ordered array into the `recording_cues` table via `replace_recording_cues` (the pure transforms live in `apps/web/src/lib/recording-cues.ts`). Those cues seed `mixtape_tracks.start_ms` on promote (each finding-linked cue resolves to a member; the clip cut itself ships clean — no baked overlay, see Unit C). `/admin/clips` is the cross-recording clip library: ONE continuous grid of every clip sorted newest-first (by clip `createdAt`), narrowable by the Recording + State filter dropdowns; there is no per-recording grouping, but each card still carries its own recording label (its `fluncle://<logId>` once promoted, else the recording title). Above the grid sits a recordings index that lists every captured set and links each to its Studio. The clip's onward seam — a "Distribute" button that drip-feeds the clip to Instagram on a schedule (the clip library's "Unit G") — is designed in [docs/rfcs/clip-drip-feed-rfc.md](./rfcs/clip-drip-feed-rfc.md) (not yet built).

## Set-video staging (the recording-upload leg)

`fluncle admin mixtapes distribute … --set-video` was **retired** (Wave 3-D). The set rendition now stages **once, at recording-create time**, not as a leg of `distribute` — `distribute` is push-only (YouTube video + Mixcloud audio) and never touches the set video.

`fluncle admin recordings create --video <master>.mov` (`apps/cli/src/commands/recordings.ts`) mints the recording row, then derives **one 1080p faststart rendition** of the set and streams it straight to R2 at the recording's owned key `recordings/<id>/set.mp4` — via `uploadRenditionMultipart` against the multipart presign `presign_recording_upload` (`POST /admin/recordings/{recordingId}/set-video/presign`). That single rendition serves three surfaces: the `/log/<mixtapeLogId>` set-video player (Unit F, shipped, once promoted), the `/admin/studio/<recordingId>` editor scrub-preview (Unit E), and the clip cut (Unit C). The **raw multi-GB master never goes to R2** — it stays a local archive; a 9:16 social clip cropped from a 1080p rendition is plenty (the platforms re-encode anyway).

**Promote copies it forward — no re-upload.** `fluncle admin recordings promote <recordingId>` (the `promote_recording` op) server-side **copies** the recording's `recordings/<id>/set.mp4` to the minted mixtape's derived key `<logId>/set.mp4` (`copyObject`, overwrite-safe), flips the mixtape's `setVideoAt`, repoints the recording's owned `r2Key`, and deletes the old key last. The bytes never re-cross the wire — the rendition is uploaded once (at create) and copied within R2 (at promote).

The recording must own a staged rendition (`r2_key` set) before its clips can be cut; `create --video` is the one upload that satisfies this.

## The rendition spec

Derived on the operator's Mac with ffmpeg (`apps/cli/src/commands/mixtape-set-video.ts`, `renditionFfmpegArgs`):

- **1080p** (`scale=-2:1080`, aspect-preserving, even width), H.264 (`libx264`, CRF 20) + AAC (192k).
- **`+faststart`** so the `moov` atom is up front for instant range-streamed playback.
- **~2s GOP** via `-force_key_frames "expr:gte(t,n_forced*2)"` — fps-independent, dense enough for editor scrubbing + frame-accurate clip cuts.
- A 48-minute set lands ~1.5–2 GB. **Not** capped at 100 MB — it is never a Cloudflare Media-Transformations input; it is played + cropped directly over R2 range requests.

## How the ~1.5 GB upload moves (multipart, direct to R2)

The rendition is past the single-PUT presign budget (`apps/web/src/lib/server/r2-presign.ts`, ~200 MB), and the Worker can't proxy multi-GB bodies (the same constraint as the YouTube/Mixcloud legs), so it goes up as an S3 **multipart** upload the CLI drives directly:

1. The CLI derives the rendition, sizes it, and plans **16 MB** parts (`planMultipart`, `DEFAULT_PART_SIZE = 16 * 1024 * 1024`; grows the part size only if the 10k-part cap would be exceeded). Small parts are the load-bearing choice — a home uplink reliably completes each 16 MB PUT where a 100 MB part dropped mid-upload (the bug this fixed).
2. It calls the operator-tier op **`presign_recording_upload`** (`POST /admin/recordings/{recordingId}/set-video/presign`). The Worker — which holds the R2 credentials via its env — runs **CreateMultipartUpload** server-side (that one call bakes the object's `video/mp4` content type), then **presigns** one PUT URL per part plus the **complete** (POST) and **abort** (DELETE) URLs (SigV4 query-signed via `aws4fetch`, `UNSIGNED-PAYLOAD`, ~6h TTL).
3. The CLI **PUTs each part** straight to its presigned URL (`Bun.file(path).slice(start, end)` — only the part's bytes are read), collecting the per-part `ETag`. **Each part retries with exponential backoff** (`putPart` → `putPartOnce`, up to `MAX_PART_ATTEMPTS = 5`, 500 ms doubling): a transient socket drop or 5xx on one part resumes instead of aborting the whole multi-hundred-part upload; only a permanent 4xx / missing ETag throws.
4. The CLI **completes** the upload by POSTing the `CompleteMultipartUpload` XML (parts in ascending order with their ETags) to the presigned complete URL. (S3/R2 can return `200` with an `<Error>` body, so the body is checked too.) If a part exhausts its retries it **aborts** via the presigned DELETE so no orphaned parts linger.
5. The staged rendition is now the recording's owned set video (`recordings/<id>/set.mp4`); it becomes the mixtape's `<logId>/set.mp4` — flipping `setVideoAt`, lighting up the `/log` player + the `<video:video>` sitemap entry + the VideoObject JSON-LD + og:video — only later, at **promote** (the server-side copy above), not at upload.

The bytes never traverse the Cloudflare zone; only the tiny presign/complete control-plane calls do.

## The pieces

- CLI command + orchestration: `apps/cli/src/commands/recordings.ts` (`recordings create --video` mints the row + stages the rendition), `apps/cli/src/commands/mixtape-set-video.ts` (derive → multipart upload with per-part retry; the shared `uploadRenditionMultipart` + pure helpers `planMultipart` / `buildCompleteXml` / `renditionFfmpegArgs`, the retry `putPart` / `putPartOnce` / `MAX_PART_ATTEMPTS`), CLI wiring in `apps/cli/src/cli.ts` (`admin recordings create`).
- Multipart presign: `apps/web/src/lib/server/r2-presign.ts` (`presignMultipartUpload` + the pure `presignMultipartParts` / `presignMultipartAction` / `parseUploadId`).
- The op: contract `packages/contracts/src/orpc/admin-recordings.ts` (`presign_recording_upload` → `POST /admin/recordings/{recordingId}/set-video/presign`), handler `apps/web/src/lib/server/orpc/admin-recordings.ts`, coverage `orpc-admin-coverage.test.ts` + `orpc-auth-coverage.test.ts` (operator tier). (The older mixtape-scoped `presign_set_video_upload` contract op still exists in `admin-mixtapes.ts` but the CLI no longer calls it — staging moved to the recording.)
- Tests: `apps/cli/src/commands/mixtape-set-video.test.ts` (part-splitting, complete-XML, ffmpeg arg shape; the real-ffmpeg test is skip-guarded so CI — which has no ffmpeg — skips it) and `apps/web/src/lib/server/r2-presign.test.ts` (the multipart signers + the UploadId parse).

---

# Cue marking — the cue model (mixtape-scoped)

> Note: the Studio's **only** interactive cue editor is the **finding-linked recording cue rail** (`RecordingCueRail`, see "The recording primitive" above) — the operator authors cues on a **recording**, each attached to a real finding (`finding_id`), persisted into the **`recording_cues`** table via `replace_recording_cues`, which `promote` seeds into `mixtape_tracks.start_ms`. This section documents the **mixtape-scoped** cue model those cues land in — the **frozen published-side** tracklist and what the YouTube/Mixcloud chapter re-sync reads. The model and its `update_mixtape_cue` op are live; the mixtape-scoped `StudioCueRail` **component** that once wrote to it is **not mounted on any route** (see "The mixtape-scoped rail" below).

The cues (`mixtape_tracks.start_ms`) feed the YouTube description chapters + Mixcloud sections (`apps/web/src/lib/mixtape-chapters.ts`), the `/log` per-track times, and clip auto-crediting (the recording's `recording_cues` back the caption via `resolveClipTracks` — see "The recording primitive"). Cues are captured where they can only be captured — against the final recording — since Rekordbox load times precede the audible mix-in by a variable lead and can't supply them.

## Two cue write-paths (deliberately distinct)

- **`update_mixtape_cue` — the interactive single-cue write** (`PUT /admin/mixtapes/{mixtapeId}/cues/{ref}`, operator tier). Upserts ONE member's `start_ms` (or clears it with `startMs: null`), keyed by track `ref`. NO coverage/order constraint — the operator marks tracks one at a time, out of order, mid-session; a transient partial or non-monotonic state is allowed because the downstream tolerates it. Published-safe (a minted `distributing`/`published` set); it rejects only an unminted claim (`setMixtapeCue` in `apps/web/src/lib/server/mixtapes.ts`). The op is live on the admin API, but nothing in the repo calls it: it was the mixtape-scoped rail's write, and that rail is unmounted (below).
- **`set_mixtape_cues` — the all-or-nothing cue-sheet backfill** (`PUT /admin/mixtapes/{mixtapeId}/cues`, operator tier). Requires exactly one cue per member, start-at-0, strictly monotonic — the CLI full-backfill path (`setMixtapeCues`). Unchanged; NOT the interactive path.

The singular verb (`update`) + the `{ref}` member segment keep the two REST-symmetric yet unambiguous (a near-collision with the plural `set_mixtape_cues` the naming convention flagged; see `docs/naming-conventions.md`).

## The mixtape-scoped rail — NOT MOUNTED

**`StudioCueRail` (`apps/web/src/components/admin/studio-cue-rail.tsx`) is not rendered on any route — it has zero importers.** It was the mixtape-scoped marking rail; the finding-linked `RecordingCueRail` superseded it as the Studio's cue editor, and the mixtape rail was never unwired from the tree. Treat it as dead code, not as a "secondary" rail an operator can reach. Its would-be write op, `update_mixtape_cue`, is still a live admin-API endpoint (above) with no caller.

The one capability that died with it is **drop snapping** — a mark snapping to the nearest `StudioPeak` drop within a small window (`snapCueToPeak` / `CUE_SNAP_WINDOW_MS` in `apps/web/src/lib/studio-clip.ts`, still exercised by `studio-clip.test.ts` but by no UI). It was a mixtape-rail feature because it reads the mixtape's energy envelope; the recording rail carries no energy envelope, so the operator marks the exact playhead. If snapping is wanted back, it belongs on `RecordingCueRail` — the helpers are there and tested.

## Re-sync from cues (the live-distribution push)

Cues are usually refined **after** the set is already live, so the cue rail's left-pane companion is the **"Re-sync from cues"** button (the "Live distribution" block). It re-derives the YouTube chapters + Mixcloud sections from the CURRENT cues and edits the already-published video + show in place — **no re-upload**. It fires **both** platform ops the set is distributed to (a platform with no distribution row is skipped, never errored), is confirm-gated (it edits live public content), and reports a ✓ / error per platform. The block only appears once the set is published (has a `youtube`/`mixcloud` `mixtape_social_posts` row) and the button enables once ≥1 cue exists. Both legs are the SAME server-side ops the `fluncle admin mixtapes resync` CLI now calls — `resync_mixtape_youtube` (`videos.update`, description only) and `resync_mixtape_mixcloud` (the Mixcloud sections-only edit, run server-side in the Worker with the stored `mixcloud_auth` token). See the `fluncle-mixtapes` skill §D2 for the full doctrine.

## The pieces

- Pure helpers: `apps/web/src/lib/studio-clip.ts` (`snapCueToPeak` / `CUE_SNAP_WINDOW_MS` / `cueProgress`), tested in `studio-clip.test.ts`.
- Re-sync: the button `ResyncFromCues` in `apps/web/src/routes/admin/studio.$recordingId.tsx` (rendered only once the recording is promoted); the shared section derivation `mixcloudSections` / `mixcloudSectionFields` / `mixcloudEditUrl` in `@fluncle/contracts/util`; the ops `resync_mixtape_youtube` / `resync_mixtape_mixcloud` (contract `packages/contracts/src/orpc/admin-mixtapes.ts`, handlers `apps/web/src/lib/server/orpc/admin-mixtapes.ts`, e2e proof in `orpc-admin-mixtapes.test.ts`).
- Server: `setMixtapeCue` in `apps/web/src/lib/server/mixtapes.ts` (tested in `mixtapes-cue.test.ts`).
- The op: contract `packages/contracts/src/orpc/admin-mixtapes.ts` (`update_mixtape_cue`), handler `apps/web/src/lib/server/orpc/admin-mixtapes.ts`, coverage `orpc-admin-coverage.test.ts` + `orpc-auth-coverage.test.ts` (operator tier), end-to-end auth proof in `orpc-admin-mixtapes.test.ts`.
- Recording cue-authoring UI (the Studio's PRIMARY interactive editor): `apps/web/src/routes/admin/studio.$recordingId.tsx` (the editor + keyboard loop), `apps/web/src/components/admin/recording-cue-rail.tsx` (finding picker + free-text escape hatch / mark / edit / remove), the pure transforms `apps/web/src/lib/recording-cues.ts` (tested in `recording-cues.test.ts`), persisted into `recording_cues` via `replace_recording_cues` (handler + server `replaceRecordingCues` in `apps/web/src/lib/server/recordings.ts`); the cue pins ride the shared `apps/web/src/components/admin/studio-energy-lane.tsx`. The mixtape-scoped `studio-cue-rail.tsx` is unmounted dead code (see "The mixtape-scoped rail — NOT MOUNTED").

---

# Unit C — the footage cut (the box)

The deterministic cut that turns each `pending` `mixtape_clips` row into a clean, cropped 9:16 clip on R2, then marks it `done`. It runs on the **always-on Hermes box (rave-02)**, not the GPU render box — a CPU-trivial ffmpeg trim, no GPU, no `claude -p`, none of the render box's agent machinery.

## What it does

For one pending clip: pull its recording's staged set rendition (the recording's owned `r2Key`, `recordings/<id>/set.mp4`) from R2 (public read), then **one ffmpeg pass** — trim `[inMs,outMs]`, crop 16:9 → 9:16 at the clip's `xOffset`, store the result as the clip's pseudo-finding master `<clipId>/footage.mp4`, and mark the clip `done`. The clip ships **clean — no baked text overlay**: recorded set footage doesn't read well under a drawtext caption, and the operator writes the caption on Instagram / TikTok at post time, so the earlier brand frame (title + coordinate + changing Track-ID + ink-halo + fonts) has been removed — the coordinate rides the caption (`buildClipCaption`) instead. Because the clip is stored at `<clipId>/footage.mp4`, the merged `videoCrop(clipId)` / `videoCropPoster(clipId)` / `videoAudioStripped(...)` Media-Transformation helpers (`apps/web/src/lib/media.ts`) finish it — the resolution ladder, the poster, and the silent TikTok variant the clip library (Unit G — the scheduled Instagram drip designed in [docs/rfcs/clip-drip-feed-rfc.md](./rfcs/clip-drip-feed-rfc.md)) serves.

## The cut (one ffmpeg pass)

`fluncle admin clips cut <clipId>` (`apps/cli/src/commands/clips.ts`) — runs on the box:

1. Resolve the clip (`list_clips`) + its source set — a clip's only owner is its **recording** (every legacy `mixtape_id`-owned clip was repointed onto its mixtape's recording in the Deploy-2 cutover). It asserts the recording's set video is **staged** (its owned `r2Key` present) — else `recording_not_staged` (the clip stays `pending`). The cut is a pure crop, so all it needs from the source is the rendition URL.
2. ffmpeg, one pass (`clipCutFfmpegArgs`): `-ss <inMs> -i <set.mp4 URL> -t <durMs> -filter_complex "<crop>" -map [out] -map 0:a? -c:v libx264 -crf 21 -maxrate 10M -bufsize 20M -c:a aac -b:a 192k -movflags +faststart`. The crop rides as a `-filter_complex` with a labelled `[out]` pad so the source audio can be mapped alongside it with `-map 0:a?` (optional — a set with no audio still cuts). `-ss` **before** `-i` is an input seek — over HTTP against the faststart `set.mp4` it range-requests to the offset instead of downloading the whole ~1.5 GB rendition, and with the re-encode it is frame-accurate. The **bitrate cap** keeps the output `footage.mp4` **< 100 MB** (a 60 s 1080×1920 cut lands ~75 MB), so Cloudflare MT (100 MB source ceiling) doesn't 400 the fan-out; the cut command also asserts the rendered file is under the cap before upload.
3. The **filtergraph** (`clipCutFilterComplex`) is just the crop: `[0:v]crop=ih*9/16:ih:<xOffset>:0,scale=1080:1920,setsar=1[out]` — crop 16:9 → 9:16 at the operator's `xOffset` (floored to a clean integer), scale to 1080×1920, fix the pixel aspect. No drawtext, no fonts, no `gblur` halo, no overlay: the clip is bare framed footage. (The pure `resolveClipTracks` / `trackLabel` helpers in `@fluncle/contracts/util` remain — they still feed the recording cue rail — but the clip cut no longer consumes them.)
4. **Upload** the cut single-PUT to R2 at `<clipId>/footage.mp4` via the agent-tier **`presign_clip_upload`** (a clip is < 100 MB, so the single-PUT `r2-presign.ts` path — no multipart). The box holds no R2 creds — the Worker signs; the box PUTs.
5. **Finalize** via the agent-tier **`finalize_clip_cut`**: mark the clip `done` AND purge the clip's stale edge renditions **server-side** (`purgeClipCache` over `clipPurgeUrls`; the box holds no Cloudflare creds), so a **re-cut** to the same `clipId` never keeps serving the old cut (#152 lesson).

## The cron (`fluncle-studio-clip`)

`docs/agents/hermes/scripts/clip-sweep.{sh,ts}` — a `--no-agent` pure-trigger sweep (the enrich-sweep shape, no `claude -p`). Each tick: `fluncle admin clips list --status pending --json` → for a bounded batch (default 1, `CLIP_BATCH_CAP`), `fluncle admin clips cut <clipId>`. Idempotent: a `done` clip is out of the next tick's `pending` read, and a not-yet-staged clip is skipped (stays `pending`) without blocking the batch — so no single-flight lock is needed (unlike the GPU render conductor). The batch is small so a tick stays under the Hermes `--no-agent` 120 s kill.

## The agent-tier ops (the box's agent token)

The box drives everything with its **agent-scoped** `FLUNCLE_API_TOKEN`, so the two write ops are **agent tier** (`adminAuth` only, no `operatorGuard`) — the `presign_track_video_uploads` / `finalize_track_video` precedent for the render box. `update_clip` is operator-tier (the box can't use it), which is exactly why the cut gets its own narrow `finalize_clip_cut`. Listing pending clips uses the merged `list_clips` (admin tier; the agent token clears `requireAdmin`).

| op                    | method + path                             | tier  |
| --------------------- | ----------------------------------------- | ----- |
| `list_clips`          | `GET /admin/clips?status=pending`         | admin |
| `presign_clip_upload` | `POST /admin/clips/{clipId}/cut/presign`  | agent |
| `finalize_clip_cut`   | `POST /admin/clips/{clipId}/cut/finalize` | agent |

(All three pass with the agent token; `admin` and `agent` both clear `requireAdmin` — the distinction is only that `agent` is barred from operator-tier ops.)

## Box deploy (operator)

Cron scripts deploy by **`docker cp` into the running container**, NOT baked into the image and NOT auto-deployed (the cron-scripts reality — see `../agents/hermes/cron/README.md`). The CLI **is** baked (`fluncle`/`bun` already in the image), so only the new cron pair + ffmpeg need to land on the box.

1. **ffmpeg is baked into the Hermes image** (`docs/agents/hermes/Dockerfile`, via apt). The clip cut no longer draws text, so it needs no fonts — the DejaVu / Oxanium faces the image still bakes are now unused by the cut (a harmless leftover; a separate cleanup).

2. **Copy the cron pair into the container** (the `docker cp` to `hermes:/opt/data/scripts/` reality):

   ```bash
   docker cp clip-sweep.sh hermes:/opt/data/scripts/clip-sweep.sh
   docker cp clip-sweep.ts hermes:/opt/data/scripts/clip-sweep.ts
   ```

3. **Schedule it** (the agent token already lives in the cron env — no operator token, since the ops are agent tier): the sweep ships as the `studio-clip-timer` host systemd timer (`fluncle-studio-clip`), a repo-checked-in `.timer`/`.service` pair installed by [`docs/agents/hermes/install-host-timers.sh`](./agents/hermes/install-host-timers.sh). Per-run output is a freshness marker the sweep self-writes under `~/.hermes/cron/output/fluncle-studio-clip/` (read by the `/status` prober).

The CLI bump (the `admin clips` commands) reaches the box on the next baked-CLI pin bump (the `fluncle-pin-watch` self-deploy), so step 2 only needs to wait for a CLI version that carries `admin clips cut`.

## The pieces

- Cut + pure helpers: `apps/cli/src/commands/clips.ts` (`clipCutFfmpegArgs` / `clipCutFilterComplex` (the crop) / `clipFootageKey` / `setVideoUrl`; the `clipsListCommand` / `clipCutCommand` orchestration) + CLI wiring in `apps/cli/src/cli.ts` (`admin clips list|cut`).
- The (now cut-unused) Track-ID resolver: `resolveClipTracks` / `trackLabel` in `packages/contracts/src/util.ts` (`@fluncle/contracts/util`) — pure, shared, still used by the recording cue rail, tested in `clips.test.ts`.
- The flat clip-library grid: `apps/web/src/routes/admin/clips.tsx` (one continuous grid, newest-first) + the pure `sortClipsNewestFirst` / `filterClips` in `apps/web/src/lib/studio-clips.ts` (tested in `studio-clips.test.ts`).
- The agent-tier ops: contract `packages/contracts/src/orpc/admin-mixtapes.ts` (`presign_clip_upload`, `finalize_clip_cut`), handlers `apps/web/src/lib/server/orpc/admin-mixtapes.ts`, the cut-done helper `apps/web/src/lib/server/clips.ts` (`markClipCutDone` / `getClip`), the clip purge `apps/web/src/lib/studio-clips.ts` (`clipPurgeUrls`) + `apps/web/src/lib/server/video-cache.ts` (`purgeClipCache`).
- The cron: `docs/agents/hermes/scripts/clip-sweep.{sh,ts}`.
- Tests (ffmpeg-free): `apps/cli/src/commands/clips.test.ts` (the ffmpeg arg shape, the overlay-free crop filtergraph, the footage key, and the still-live `resolveClipTracks` / `trackLabel` coverage — never invoking ffmpeg), `apps/web/src/lib/studio-clips.test.ts` (`sortClipsNewestFirst`, `filterClips`, `clipPurgeUrls`), and the oRPC coverage/auth-tier nets (`orpc-admin-coverage.test.ts` + `orpc-auth-coverage.test.ts`) pin the two ops as agent tier.
