# Fluncle Studio — set-video staging + the footage cut

The mixtape set → clip pipeline. This doc covers the shipped **set-video staging** (Unit A — the automation of the manual three-step staging the `fluncle-mixtapes` skill used to document) and the **footage cut** (Unit C — the deterministic box job that turns a `pending` clip into a framed 9:16 clip on R2).

## What it does

`fluncle admin mixtapes distribute <idOrLogId> --video <master>.mp4 --set-video` stages **one 1080p faststart rendition** of the set to R2 at `<logId>/set.mp4` and flips the mixtape's `setVideoAt`. That single rendition serves three surfaces: the `/log/<mixtapeLogId>` set-video player (Unit F, shipped), the `/admin/studio/$logId` editor scrub-preview (Unit E), and the clip cut (Unit C). The **raw multi-GB master never goes to R2** — it stays a local archive; a 9:16 social clip cropped from a 1080p rendition is plenty (the platforms re-encode anyway).

It is **opt-in** and an **additional** leg of `distribute`:

- `distribute <id> --video x.mp4 --audio y.m4a` → YouTube + Mixcloud (unchanged; no set video).
- `distribute <id> --video x.mp4 --audio y.m4a --set-video` → YouTube + Mixcloud **+** set video.
- `distribute <id> --video x.mp4 --set-video` → **only** the set video (the backfill case — re-stage an already-published set without re-uploading to YouTube/Mixcloud).

It is **idempotent**: a re-run on a published mixtape re-derives, re-uploads, and re-flips `setVideoAt` (a backfill). The mixtape must already be minted (have a committed Log ID); `distribute` mints first, so the normal flow satisfies this.

## The rendition spec

Derived on the operator's Mac with ffmpeg (`apps/cli/src/commands/mixtape-set-video.ts`, `renditionFfmpegArgs`):

- **1080p** (`scale=-2:1080`, aspect-preserving, even width), H.264 (`libx264`, CRF 20) + AAC (192k).
- **`+faststart`** so the `moov` atom is up front for instant range-streamed playback.
- **~2s GOP** via `-force_key_frames "expr:gte(t,n_forced*2)"` — fps-independent, dense enough for editor scrubbing + frame-accurate clip cuts.
- A 48-minute set lands ~1.5–2 GB. **Not** capped at 100 MB — it is never a Cloudflare Media-Transformations input; it is played + cropped directly over R2 range requests.

## How the ~1.5 GB upload moves (multipart, direct to R2)

The rendition is past the single-PUT presign budget (`apps/web/src/lib/server/r2-presign.ts`, ~200 MB), and the Worker can't proxy multi-GB bodies (the same constraint as the YouTube/Mixcloud legs), so it goes up as an S3 **multipart** upload the CLI drives directly:

1. The CLI derives the rendition, sizes it, and plans `~100 MB` parts (`planMultipart`; grows the part size if the 10k-part cap would be exceeded).
2. It calls the operator-tier op **`presign_set_video_upload`** (`POST /admin/mixtapes/{mixtapeId}/set-video/presign`). The Worker — which holds the R2 credentials via its env — runs **CreateMultipartUpload** server-side (that one call bakes the object's `video/mp4` content type), then **presigns** one PUT URL per part plus the **complete** (POST) and **abort** (DELETE) URLs (SigV4 query-signed via `aws4fetch`, `UNSIGNED-PAYLOAD`, ~6h TTL).
3. The CLI **PUTs each part** straight to its presigned URL (`Bun.file(path).slice(start, end)` — only the part's bytes are read), collecting the per-part `ETag`.
4. The CLI **completes** the upload by POSTing the `CompleteMultipartUpload` XML (parts in ascending order with their ETags) to the presigned complete URL. (S3/R2 can return `200` with an `<Error>` body, so the body is checked too.) On any failure it **aborts** via the presigned DELETE so no orphaned parts linger.
5. The CLI **flips `setVideoAt`** via the existing operator-tier `update_mixtape` → the `/log` player + the `<video:video>` sitemap entry + the VideoObject JSON-LD + og:video light up.

The bytes never traverse the Cloudflare zone; only the tiny presign/complete control-plane calls do.

### Embargo (later hook, not built)

`--set-video` runs at `distribute` (= publish), so the default stages the rendition **public**. The only private-then-flip case is **pre-release backlog clipping** (stage the rendition early to build clips before launch, private until publish) — a deliberate opt-in deferred to a later concern.

## The pieces

- CLI flag + orchestration: `apps/cli/src/cli.ts` (`--set-video`), `apps/cli/src/commands/mixtapes.ts` (the distribute leg), `apps/cli/src/commands/mixtape-set-video.ts` (derive → multipart upload → flip; pure helpers `planMultipart` / `buildCompleteXml` / `renditionFfmpegArgs`).
- Multipart presign: `apps/web/src/lib/server/r2-presign.ts` (`presignMultipartUpload` + the pure `presignMultipartParts` / `presignMultipartAction` / `parseUploadId`).
- The op: contract `packages/contracts/src/orpc/admin-mixtapes.ts` (`presign_set_video_upload`), handler `apps/web/src/lib/server/orpc/admin-mixtapes.ts`, coverage `orpc-admin-coverage.test.ts` + `orpc-auth-coverage.test.ts` (operator tier).
- Tests: `apps/cli/src/commands/mixtape-set-video.test.ts` (part-splitting, complete-XML, ffmpeg arg shape; the real-ffmpeg test is skip-guarded so CI — which has no ffmpeg — skips it) and `apps/web/src/lib/server/r2-presign.test.ts` (the multipart signers + the UploadId parse).

---

# Unit C — the footage cut (the box)

The deterministic cut that turns each `pending` `mixtape_clips` row into a framed 9:16 clip on R2, then marks it `done`. It runs on the **always-on Hermes box (rave-02)**, not the GPU render box — a CPU-trivial ffmpeg trim, no GPU, no `claude -p`, none of the render box's agent machinery.

## What it does

For one pending clip: pull the mixtape's staged set rendition `<mixtapeLogId>/set.mp4` from R2 (public read), then **one ffmpeg pass** — trim `[inMs,outMs]`, crop 16:9 → 9:16 at the clip's `xOffset`, bake a **minimal brand frame**, store the result as the clip's pseudo-finding master `<clipId>/footage.mp4`, and mark the clip `done`. Because the clip is stored at `<clipId>/footage.mp4`, the merged `videoCrop(clipId)` / `videoCropPoster(clipId)` / `videoAudioStripped(...)` Media-Transformation helpers (`apps/web/src/lib/media.ts`) finish it — the resolution ladder, the poster, and the silent TikTok variant the clip library (Unit G) serves.

## The cut (one ffmpeg pass)

`fluncle admin clips cut <clipId>` (`apps/cli/src/commands/clips.ts`) — runs on the box:

1. Resolve the clip (`list_clips`) + its mixtape (`mixtapeGetCommand`). It asserts the mixtape is minted (a committed Log ID) and its set video is **staged** (`setVideoAt` set, i.e. `distribute --set-video` ran) — else `set_not_staged` (the clip stays `pending`).
2. ffmpeg, one pass (`clipCutFfmpegArgs`): `-ss <inMs> -i <set.mp4 URL> -t <durMs> -vf "crop=ih*9/16:ih:<xOffset>:0,scale=1080:1920,<brand frame>" -c:v libx264 -crf 21 -maxrate 10M -bufsize 20M -c:a aac -b:a 192k -movflags +faststart`. `-ss` **before** `-i` is an input seek — over HTTP against the faststart `set.mp4` it range-requests to the offset instead of downloading the whole ~1.5 GB rendition, and with the re-encode it is frame-accurate. The **bitrate cap** keeps the output `footage.mp4` **< 100 MB** (a 60 s 1080×1920 cut lands ~75 MB), so Cloudflare MT (100 MB source ceiling) doesn't 400 the fan-out; the cut command also asserts the rendered file is under the cap before upload.
3. The **brand frame** (`clipCutVideoFilter` → the reusable `brandDrawtext` node) is a **1:1 mirror of the Remotion per-track `TypePlate` identity block** (`packages/video`: `floating-type.tsx` `trackLine` + `logId`, laid out by `type-plate.tsx`) — both canvases are 1080×1920, so the px map directly and a mixtape clip reads as the same object as a track clip. Two `drawtext` lines, bottom-left, stacked: the **mixtape display TITLE** (the `trackLine`: **system-sans stand-in**, **Starlight-Cream `#f4ead7`**, size **40**) over the `fluncle://<mixtapeLogId>` **COORDINATE** (the `logId`: **Oxanium**, **Stardust `#b7ab95`** / dim, size **22**). Both are lifted off the footage by a **warm-dark ink-halo** (a Deep-Field `#090a0b` `borderw` scaled to the glyph + a small Deep-Field drop shadow — the ffmpeg approximation of `FloatingType`'s `inkHalo`), NOT a `#000` caption box (the Nostalgic Cosmos: Warm Dark / Through-the-Glass / Legible Sky; DESIGN.md). No gold — the overlay stays quiet, under the One-Sun budget. **Placement** = the shared platform safe-area: `MARGIN_X = 96` from the left, the block's **bottom edge `SAFE_BOTTOM = 230`** above the frame bottom (clears the TikTok/IG/YT bottom chrome), lines gapped by 10; each line's bottom is anchored with its own `th`. There is **no top-right meta/Found block** (a mixtape clip skips the per-track telemetry). Known minor gap: ffmpeg `drawtext` has no letter-spacing, so the `logId`'s `0.12em` tracking is not reproduced — the dim, small Oxanium is the match that carries. On the mid-tone DJ-deck footage the ink-halo holds AA without an occluding box; the AA fallback for a future white-strobe clip is a warm-dark **translucent** box (`box=1:boxcolor=0x10100d@0.6`, Sleeve Black — never `#000`), not the old hard scrim. Per-track titles are Phase-2/Slice C (they need cues); v1 stamps the mixtape level, and `brandDrawtext` is parameterized by font role so the per-cue Track-ID line reuses the title's sans role. **Fonts** resolve with no manual step: the title's sans via `resolveClipSansFontFile()` (**DejaVu Sans Bold**, baked by `fonts-dejavu-core` at `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`; `CLIP_SANS_FONT_FILE` overrides) and the coordinate's Oxanium via `resolveClipFontFile()` (**Oxanium SemiBold** at `/opt/fonts/Oxanium-SemiBold.ttf`; `CLIP_FONT_FILE` overrides), each falling back to fontconfig's default only when its file is absent. NOT the full cosmos composition (a later enhancement).
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

1. **ffmpeg + both brand fonts are baked into the Hermes image** (`docs/agents/hermes/Dockerfile`): ffmpeg via apt, DejaVu Sans Bold via `fonts-dejavu-core` (the title's sans, at `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`), and Oxanium SemiBold (the coordinate) at `/opt/fonts/Oxanium-SemiBold.ttf` — which `resolveClipSansFontFile()` / `resolveClipFontFile()` pick up automatically (no env needed). A rebuilt/self-freshened box gets all three with no manual step. To render on a bare shell without the baked paths, point `CLIP_SANS_FONT_FILE` / `CLIP_FONT_FILE` at any installed `.ttf`/`.otf` (else drawtext falls back to fontconfig's default per role).

2. **Copy the cron pair into the container** (the `docker cp` to `hermes:/opt/data/scripts/` reality):

   ```bash
   docker cp clip-sweep.sh hermes:/opt/data/scripts/clip-sweep.sh
   docker cp clip-sweep.ts hermes:/opt/data/scripts/clip-sweep.ts
   ```

3. **Wire the cron** (the agent token already lives in the cron env — no operator token, since the ops are agent tier):

   ```bash
   hermes cron create "every 15m" --no-agent --script clip-sweep.sh --deliver local --name fluncle-studio-clip
   hermes cron list   # confirm; per-run output → ~/.hermes/cron/output/{job_id}/{timestamp}.md
   ```

The CLI bump (the `admin clips` commands) reaches the box on the next baked-CLI pin bump (the `fluncle-pin-watch` self-deploy), so step 2 only needs to wait for a CLI version that carries `admin clips cut`.

## The pieces

- Cut + pure helpers: `apps/cli/src/commands/clips.ts` (`clipCutFfmpegArgs` / `clipCutVideoFilter` / `escapeDrawtextValue` / `clipFootageKey` / `setVideoUrl`; the `clipsListCommand` / `clipCutCommand` orchestration) + CLI wiring in `apps/cli/src/cli.ts` (`admin clips list|cut`).
- The agent-tier ops: contract `packages/contracts/src/orpc/admin-mixtapes.ts` (`presign_clip_upload`, `finalize_clip_cut`), handlers `apps/web/src/lib/server/orpc/admin-mixtapes.ts`, the cut-done helper `apps/web/src/lib/server/clips.ts` (`markClipCutDone` / `getClip`), the clip purge `apps/web/src/lib/studio-clips.ts` (`clipPurgeUrls`) + `apps/web/src/lib/server/video-cache.ts` (`purgeClipCache`).
- The cron: `docs/agents/hermes/scripts/clip-sweep.{sh,ts}`.
- Tests (ffmpeg-free): `apps/cli/src/commands/clips.test.ts` (the ffmpeg arg shape, the crop/scale/brand-frame filtergraph + drawtext escaping, the footage key — never invoking ffmpeg), `apps/web/src/lib/studio-clips.test.ts` (`clipPurgeUrls`), and the oRPC coverage/auth-tier nets (`orpc-admin-coverage.test.ts` + `orpc-auth-coverage.test.ts`) pin the two new ops as agent tier.
