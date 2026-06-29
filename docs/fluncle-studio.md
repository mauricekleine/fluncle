# Fluncle Studio — the set-video staging (`distribute --set-video`)

The mixtape set → clip pipeline (full design: `docs/fluncle-studio-rfc.md`). This doc covers the shipped **set-video staging** — Unit A — the automation of the manual three-step staging the `fluncle-mixtapes` skill used to document.

## What it does

`fluncle admin mixtapes distribute <idOrLogId> --video <master>.mp4 --set-video` stages **one 1080p faststart rendition** of the set to R2 at `<logId>/set.mp4` and flips the mixtape's `setVideoAt`. That single rendition serves three surfaces: the `/log/<mixtapeLogId>` set-video player (Unit F, shipped), the `/admin/studio` editor scrub-preview (Unit E), and the clip cut (Unit C). The **raw multi-GB master never goes to R2** — it stays a local archive; a 9:16 social clip cropped from a 1080p rendition is plenty (the platforms re-encode anyway).

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

`--set-video` runs at `distribute` (= publish), so the default stages the rendition **public**. The only private-then-flip case is **pre-release backlog clipping** (stage the rendition early to build clips before launch, private until publish) — a deliberate opt-in deferred to a later concern (`docs/fluncle-studio-rfc.md` §2 "Embargo").

## The pieces

- CLI flag + orchestration: `apps/cli/src/cli.ts` (`--set-video`), `apps/cli/src/commands/mixtapes.ts` (the distribute leg), `apps/cli/src/commands/mixtape-set-video.ts` (derive → multipart upload → flip; pure helpers `planMultipart` / `buildCompleteXml` / `renditionFfmpegArgs`).
- Multipart presign: `apps/web/src/lib/server/r2-presign.ts` (`presignMultipartUpload` + the pure `presignMultipartParts` / `presignMultipartAction` / `parseUploadId`).
- The op: contract `packages/contracts/src/orpc/admin-mixtapes.ts` (`presign_set_video_upload`), handler `apps/web/src/lib/server/orpc/admin-mixtapes.ts`, coverage `orpc-admin-coverage.test.ts` + `orpc-auth-coverage.test.ts` (operator tier).
- Tests: `apps/cli/src/commands/mixtape-set-video.test.ts` (part-splitting, complete-XML, ffmpeg arg shape; the real-ffmpeg test is skip-guarded so CI — which has no ffmpeg — skips it) and `apps/web/src/lib/server/r2-presign.test.ts` (the multipart signers + the UploadId parse).
