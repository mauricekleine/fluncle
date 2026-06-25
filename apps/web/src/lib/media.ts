// R2 media for a finding, keyed by its Log ID.
//
// The Worker owns the bucket; these are the public read URLs on the
// found.fluncle.com custom domain. The video bundle (footage / footage.social /
// poster / cover / …) is stored at `<log-id>/<name>` — only `footage.mp4` gets a
// DB column (`video_url`); cover, poster, and the social cut live by CONVENTION,
// with no column. This module is the single source of that convention for every
// surface (the feed, Stories, OG tags), so the `<log-id>/<name>` shape is written
// down once instead of re-encoded per caller. The audio-less variant is no longer
// a stored object — surfaces derive it via an `audio=false` Media Transformation
// (videoCrop silent / videoAudioStripped), so `footage-silent.mp4` is retired.

export const FOUND_BASE = "https://found.fluncle.com";

/** The mixtape's episode audio on R2 (the podcast enclosure), by its Log ID. */
export function mixtapeAudioUrl(logId: string): string {
  return `${FOUND_BASE}/${encodeURIComponent(logId)}/mixtape.m4a`;
}

/**
 * Cache-bust the observation audio URL by its render timestamp.
 *
 * Re-`observe`ing a finding overwrites `<log-id>/observation.mp3` in place at the
 * same R2 key, but the BARE object URL is edge-cached (`cache-control: max-age`),
 * so `/log` and the admin board keep serving the OLD audio until the TTL expires.
 * Riding `observation_generated_at` as `?v=<epoch-ms>` re-keys the edge entry on
 * every re-observe, so playback surfaces fetch the fresh cut immediately. R2
 * ignores the unknown query (the object resolves byte-identically — verified for
 * footage), so only the cache key changes, never the bytes. This mirrors the
 * video `TRANSFORM_VERSION` token and the OG/cover `?n=<version>` bust.
 *
 * Pass the STORED bare URL (the `observation_audio_url` column) and the row's
 * `observation_generated_at`. The bare URL stays the source of truth for any
 * internal/admin-overwrite use (like the video master in `trackMedia`); only the
 * playback/consumer URL gets the version. Returns the bare URL unchanged when
 * either input is missing (no observation → no broken `?v=` token).
 */
export function versionedObservationAudioUrl(
  bareUrl: string | undefined,
  generatedAt: string | undefined,
): string | undefined {
  if (!bareUrl) {
    return bareUrl;
  }

  if (!generatedAt) {
    return bareUrl;
  }

  const version = Date.parse(generatedAt);

  if (Number.isNaN(version)) {
    return bareUrl;
  }

  return `${bareUrl}?v=${version}`;
}

export type TrackMedia = {
  /** The profile-grid cover: loud centered identity. Also the OG image + video loading still. */
  coverUrl: string;
  /** The fixed-template caption (Fluncle's voice) — what the operator pastes in-app. */
  noteUrl: string;
  /** Fluncle's spoken field observation (the recovered-audio artifact). */
  observationAudioUrl: string;
  /** The spoken observation's text (re-render source; may render under the /log audio control). */
  observationTextUrl: string;
  /** The structured observation artifact + render metadata (provenance; internal). */
  observationJsonUrl: string;
  /** A late drop frame; the video element's poster. */
  posterUrl: string;
  /**
   * The stored `video_url` master. Under the two-master layout (videoSquaredAt
   * set) this is the CLEAN square 1920×1920 crop source; under the legacy layout
   * it is the old portrait+text cut. Surfaces choose by the layout signal.
   */
  videoUrl: string;
  /**
   * The portrait, baked-text social cut (footage.social.mp4): the playable cut
   * for Stories + YouTube, and (audio-stripped via MT) TikTok. Present once a
   * finding has any video — new renders ship it, and the migration backfills it
   * for legacy findings. Surfaces fall back to `videoUrl` when it's absent.
   */
  socialVideoUrl: string;
};

/** Derive the conventional R2 media URLs for a finding from its Log ID. */
export function trackMedia(logId: string): TrackMedia {
  const base = `${FOUND_BASE}/${encodeURIComponent(logId)}`;

  return {
    coverUrl: `${base}/cover.jpg`,
    noteUrl: `${base}/note.txt`,
    observationAudioUrl: `${base}/observation.mp3`,
    observationJsonUrl: `${base}/observation.json`,
    observationTextUrl: `${base}/observation.txt`,
    posterUrl: `${base}/poster.jpg`,
    socialVideoUrl: `${base}/footage.social.mp4`,
    videoUrl: `${base}/footage.mp4`,
  };
}

// ── Spotify album-art renditions ─────────────────────────────────────────────
//
// `album_image_url` stores a Spotify CDN URL (i.scdn.co). Spotify encodes the
// pixel size in the image-id PREFIX, not query params: `ab67616d0000b273` = 640²,
// `ab67616d00001e02` = 300², `ab67616d00004851` = 64². We store the 300² variant
// (selectAlbumImageUrl picks width >= 300), which is a ~20 KB JPEG — far too heavy
// for a 52px feed row. Swapping the prefix requests a right-sized rendition of the
// SAME cover (64² ≈ 2.7 KB for a row, 640² for the full-bleed /log poster). Any
// non-Spotify or unrecognized URL passes through untouched.

const SPOTIFY_IMAGE_SIZE_CODE = {
  large: "ab67616d0000b273", // 640²
  medium: "ab67616d00001e02", // 300²
  small: "ab67616d00004851", // 64²
} as const;

export type SpotifyImageSize = keyof typeof SPOTIFY_IMAGE_SIZE_CODE;

// The Spotify album-art id is the 16-char size code + a 24-char (hex) cover hash.
const SPOTIFY_ALBUM_IMAGE_RE = /^(https:\/\/i\.scdn\.co\/image\/)ab67616d[0-9a-f]{8}([0-9a-f]+)$/;

/**
 * Rewrite a stored Spotify album-art URL to the requested rendition size, leaving
 * any non-Spotify URL (or unparseable id) untouched. `small` for the feed/index
 * rows, `large` for the full-bleed /log poster (the stored 300² would upscale).
 */
export function spotifyAlbumImageAtSize(
  url: string | undefined,
  size: SpotifyImageSize,
): string | undefined {
  if (!url) {
    return url;
  }

  const match = SPOTIFY_ALBUM_IMAGE_RE.exec(url);

  if (!match) {
    return url;
  }

  return `${match[1]}${SPOTIFY_IMAGE_SIZE_CODE[size]}${match[2]}`;
}

// ── Cloudflare Media Transformations ─────────────────────────────────────────
//
// Playback surfaces (Stories, the log footage) don't fetch the raw 1080×1920
// master — that's a heavy file on a phone over cellular. Instead they request a
// same-zone Media Transformations rendition: Cloudflare resizes/transcodes the
// master on the edge and caches it. The master keeps being the source of truth
// (admin, OG, JSON-LD all read `trackMedia()` untouched); these helpers only
// build the transform URL that points BACK at that master.
//
// URL shape (https://developers.cloudflare.com/stream/transform-videos/):
//   https://<zone>/cdn-cgi/media/<OPTIONS>/<SOURCE-URL>
// `<zone>` must be the fluncle.com zone with Transformations enabled (an
// operator step — see wrangler.jsonc). The source is the master on the SAME
// zone (found.fluncle.com), so the transform never crosses an origin.
//
// Constraints worth remembering: the source must be a full https URL, and
// Cloudflare rejects sources larger than 100MB. Stragglers above that ceiling
// (or any edge error) fall back to the raw master via a one-shot `onError` on
// the <video>/<img>, so playback is safe regardless of the transform's verdict.

/** The /cdn-cgi/media base on the found.fluncle.com zone (same zone as the master). */
const MEDIA_TRANSFORM_BASE = `${FOUND_BASE}/cdn-cgi/media`;

/**
 * Cache-bust token for Media Transformations. Each rendition is edge-cached
 * keyed on its transform URL (which embeds the source master URL), so when a
 * master is overwritten in place at the same R2 key — e.g. the square-footage
 * backfill re-rendered every finding's `footage.mp4` (docs/video-variants.md) —
 * the cached renditions keep serving the OLD master until their edge entry
 * expires. Riding this token on every transform source as `?v=N` re-keys the
 * whole catalogue's renditions in a single deploy; bump it whenever masters are
 * overwritten in bulk. R2 ignores the query (the master resolves byte-identically,
 * verified), so only the transform cache key changes — never the bytes fetched.
 * This mirrors the `?n=<version>` cache-bust the OG/cover images already use on
 * this zone.
 */
const TRANSFORM_VERSION = 1;

/** Append the cache-bust token to a transform's source master URL. */
function versionedSource(source: string): string {
  return `${source}?v=${TRANSFORM_VERSION}`;
}

/**
 * The intrinsic width Cloudflare transcodes a rendition to. The list is sparse
 * on purpose — each distinct width is a separately-cached transform, so we snap
 * the viewport to a small ladder instead of minting a per-pixel rendition.
 */
export type RenditionWidth = 360 | 480 | 720 | 1080;

/**
 * Build a same-zone Media Transformations URL for a footage rendition.
 *
 * `mode=video,width=N` resizes the master's `footage.mp4` to `width` px wide
 * (height follows the source aspect), transcoded and cached at Cloudflare's
 * edge. Falls back to the raw master on any edge error via the caller's
 * one-shot `onError`.
 */
export function videoRendition(
  logId: string,
  { master = "footage.mp4", width }: { master?: string; width: RenditionWidth },
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/${master}`);

  return `${MEDIA_TRANSFORM_BASE}/mode=video,width=${width}/${source}`;
}

/**
 * Build a same-zone Media Transformations URL for a cheap poster frame.
 *
 * `mode=frame` pulls a single still from the master instead of shipping the
 * 1080-wide `poster.jpg`; `time=0s,format=jpg` takes the opening frame as a
 * JPEG. Used as the <video> poster so the first paint is a light edge-cached
 * image, not the full poster asset.
 */
export function videoPoster(logId: string, master = "footage.mp4"): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/${master}`);

  return `${MEDIA_TRANSFORM_BASE}/mode=frame,time=0s,format=jpg/${source}`;
}

// ── Two-master crops (docs/video-variants.md) ────────────────────────────────
//
// Under the two-master layout (videoSquaredAt set), `footage.mp4` is the CLEAN
// square 1920×1920 source master. The archive surfaces (/log, radio) never play
// the square — they request an on-the-fly MT centre-crop to the orientation the
// viewport wants. `fit=cover` scales-to-fill then centre-crops the overflow (the
// only crop-to-fill `fit` Cloudflare video MT supports — bare `crop` is rejected
// with a 400), so a 1920×1920 master yields both a native-resolution 1080×1920
// portrait and 1920×1080 landscape with no upscale
// (only the centre "plus" of the square is ever seen — compositions destined to
// be cropped keep their centre of gravity centered). These ONLY apply when the
// finding carries the square master; a legacy finding still plays `footage.mp4`
// as-is, so callers gate on `videoSquaredAt` before reaching for a crop.

/** Crop orientation for the square master: portrait (mobile) or landscape (desktop). */
export type CropOrientation = "landscape" | "portrait";

// The native crop width per orientation AND the height ratio (height ÷ width)
// the centre-crop preserves at any requested width. The square master is 1920²:
// a 9:16 portrait crops to 1080×1920 (ratio 16/9), a 16:9 landscape to 1920×1080
// (ratio 9/16). When a caller asks for a narrower width (the Stories resolution
// ladder) height follows the SAME ratio, so the crop stays the exact
// portrait/landscape aspect — just smaller and lighter on the wire.
const CROP_GEOMETRY: Record<CropOrientation, { nativeWidth: number; ratio: number }> = {
  // 16:9 full-screen radio/desktop; 9:16 mobile. Native off the 1920² square.
  landscape: { nativeWidth: 1920, ratio: 9 / 16 },
  portrait: { nativeWidth: 1080, ratio: 16 / 9 },
};

/**
 * Build a same-zone Media Transformations URL that CENTRE-CROPS the square
 * `footage.mp4` master to `orientation`. `fit=cover,width=W,height=H` scales the
 * source to fill the box then crops the overflow from the centre, in one op; the
 * result is edge-cached like the resolution-ladder renditions. (`fit=cover` is
 * the only crop-to-fill fit Cloudflare video MT accepts — `crop` 400s.) Only
 * valid for a finding under the two-master layout (its `footage.mp4` is the clean
 * square) — callers gate on `videoSquaredAt`.
 *
 * `width` snaps the crop to a resolution-ladder rung (Stories sizes the crop to
 * the measured pane, not the native 1080/1920); height follows the orientation's
 * aspect so the crop stays exactly portrait/landscape. Defaults to the native
 * width, so the fixed-resolution caller (/log) reads the same URL as before.
 */
export function videoCrop(
  logId: string,
  orientation: CropOrientation,
  width?: number,
  silent = false,
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`);
  const { nativeWidth, ratio } = CROP_GEOMETRY[orientation];
  const cropWidth = width ?? nativeWidth;
  const cropHeight = Math.round(cropWidth * ratio);
  // `silent` folds the audio-strip into the SAME `fit=cover` transform (radio
  // plays the observation over a genuinely silent cut). It must be ONE combined
  // transform — never `videoAudioStripped(videoCrop(...))`, which nests a
  // transform inside a transform (Cloudflare 400s it) and double-appends `?v`.
  const audio = silent ? ",audio=false" : "";

  return `${MEDIA_TRANSFORM_BASE}/fit=cover,width=${cropWidth},height=${cropHeight}${audio}/${source}`;
}

/**
 * The poster twin of `videoCrop`: a single frame, CENTRE-CROPPED to `orientation`
 * off the square master. Cloudflare MT accepts `fit=cover` combined with
 * `mode=frame` (verified 200 on a live portrait crop), so the squared poster
 * matches the cropped clip's aspect instead of a square loading frame. Same
 * gating as `videoCrop` — only valid under the two-master layout.
 *
 * `atSeconds` threads `time=${atSeconds}s` into the `mode=frame` URL (CF accepts
 * `fit=cover` + `mode=frame` + `time=` together — verified). The shared-broadcast
 * join needs the offset frame, not the opening one: a joiner 40s into a segment
 * must see the 40s still, or the poster→video swap visibly jumps (and a
 * reduced-motion joiner holds on the correct mid-segment frame). Defaults to `0`
 * — the opening frame, the existing /log + radio-head behavior unchanged.
 */
export function videoCropPoster(
  logId: string,
  orientation: CropOrientation,
  width?: number,
  atSeconds = 0,
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`);
  const { nativeWidth, ratio } = CROP_GEOMETRY[orientation];
  const cropWidth = width ?? nativeWidth;
  const cropHeight = Math.round(cropWidth * ratio);
  const time = Math.max(0, Math.floor(atSeconds));

  return `${MEDIA_TRANSFORM_BASE}/fit=cover,width=${cropWidth},height=${cropHeight},mode=frame,time=${time}s,format=jpg/${source}`;
}

/**
 * A same-zone Media Transformations CLIP of the cropped square master that BEGINS
 * at a global offset — the fast offset-join (RFC radio-broadcast.md Unit B). CF MT
 * `mode=video` supports `time=` (start offset) + `duration=` (1-60s), so a joiner
 * fetches a faststart rendition whose frame 0 IS the offset — no in-file seek of
 * the non-faststart master (verified live 2026-06-22: `time=5s,duration=10s` → a
 * 200, ~7MB faststart MP4, edge-cached at a 20-day TTL).
 *
 * The crop + audio-strip + clip are ONE combined transform — never nested (the
 * `videoCrop` no-nesting rule: Cloudflare 400s a transform-in-a-transform and
 * double-appends `?v`). The video is silent (radio plays the observation over it),
 * so `audio=false` rides along. `startSeconds` should already be SNAPPED to the
 * cache grid (`snapOffsetMs` in radio-schedule.ts) — every distinct `time=` is a
 * distinct cache key, so per-second offsets fragment the edge cache; snapping lets
 * joiners share a handful of warm clips per segment. `durationSeconds` defaults to
 * the 60s MT max so one clip covers the rest of most segments before the page
 * swaps to the steady-state looping `videoCrop` (no `time=`, already warm/shared).
 */
export function videoClipCrop(
  logId: string,
  orientation: CropOrientation,
  startSeconds: number,
  width?: number,
  durationSeconds = 60,
): string {
  const source = versionedSource(`${FOUND_BASE}/${encodeURIComponent(logId)}/footage.mp4`);
  const { nativeWidth, ratio } = CROP_GEOMETRY[orientation];
  const cropWidth = width ?? nativeWidth;
  const cropHeight = Math.round(cropWidth * ratio);
  const start = Math.max(0, Math.floor(startSeconds));
  // CF MT clamps duration to [1, 60]; keep it inside that window.
  const duration = Math.min(60, Math.max(1, Math.floor(durationSeconds)));

  return `${MEDIA_TRANSFORM_BASE}/fit=cover,width=${cropWidth},height=${cropHeight},audio=false,time=${start}s,duration=${duration}s/${source}`;
}

/**
 * The native portrait width the audio-stripped social cut is emitted at. The
 * source `footage.social.mp4` is a 1080×1920 portrait, so requesting 1080 keeps
 * the rendition full-resolution (no upscale) — and ≥720p, which TikTok requires.
 */
const AUDIO_STRIPPED_WIDTH = 1080;

/**
 * Strip the audio track from a same-zone portrait master via `audio=false`. The
 * TikTok push reaches for this off `footage.social.mp4` so the operator attaches
 * the licensed sound in-app — replacing the stored `footage-silent.mp4` cut,
 * which is retired under the two-master model. `source` must be a full
 * found.fluncle.com URL (same zone as the transform base).
 *
 * `mode=video,width=1080` is REQUIRED, not decorative: `audio=false` ALONE is a
 * degenerate transform — with no width, Cloudflare MT falls back to its tiny
 * default (~202px wide, verified by ffprobe), which TikTok rejects with "Video
 * must be at least 720p". Pinning the native 1080 portrait width emits a proper
 * ≥720p H264 cut with the audio dropped.
 */
export function videoAudioStripped(source: string): string {
  return `${MEDIA_TRANSFORM_BASE}/mode=video,audio=false,width=${AUDIO_STRIPPED_WIDTH}/${versionedSource(source)}`;
}

// ── Cache-purge URL set (the re-render purge) ────────────────────────────────
//
// Re-shipping `footage.mp4` to the SAME R2 key (a re-render via the video ship
// finalize step) leaves every Media-Transformation rendition above cached at the
// edge — each keyed on its own transform URL — still pointing at the OLD master's
// bytes until its TTL expires, so the player keeps serving the stale clip. The
// `?v=N` TRANSFORM_VERSION token only re-keys the WHOLE catalogue in a deploy; a
// single re-rendered finding needs a per-URL purge of exactly its renditions.
//
// `videoPurgeUrls` is the inverse of the builders above: given a finding's logId
// (and whether it carries the two-master square layout), it returns the full,
// FINITE set of public URLs the surfaces actually generate for that finding — the
// masters plus every deterministic rendition. The Cloudflare purge-by-URL API
// (`{ files: [...] }`) only evicts the exact URLs listed, so this set must mirror
// the builders precisely: a width the surfaces never request is wasted purge
// budget; a width they do request that's missing here stays stale.
//
// What is deliberately NOT enumerable, and why it's safe to omit:
//   - radio time-offset CLIPS (`videoClipCrop`, `time=…s,duration=…s`): a joiner
//     mints a fresh cache key per snapped offset, so the keyspace is unbounded —
//     not purgeable by exhaustive URL listing. They're short by construction (one
//     clip covers the rest of a segment, then the page swaps to the warm looping
//     `videoCrop`), so they self-heal within a segment. A bulk re-render that must
//     evict them too bumps `TRANSFORM_VERSION` (a whole-catalogue re-key).
//   - the offset poster frames (`videoCropPoster` with `atSeconds > 0`): same
//     unbounded-offset reasoning; the opening-frame poster (atSeconds=0) IS listed.

// The resolution ladder the responsive surfaces snap to (mirror of
// use-responsive-width.ts `RENDITION_LADDER`). Every rung is a separately-cached
// rendition, so the purge set walks the same rungs the surfaces request.
const PURGE_RENDITION_WIDTHS: readonly RenditionWidth[] = [360, 480, 720, 1080];

/**
 * The full set of public URLs to purge from Cloudflare's edge when a finding's
 * `footage.mp4` is re-shipped to the same R2 key. Exhaustive but precise — only
 * URLs the playback/social/poster surfaces actually generate (see the builders
 * above for each surface's exact request).
 *
 * `squared` selects which family of renditions a finding emits: a two-master
 * (square) finding is centre-CROPPED per orientation (`videoCrop`/`videoCropPoster`,
 * /log + radio), while a legacy finding plays a width-ladder rendition off the
 * portrait master (`videoRendition`/`videoPoster`, /log + Stories). Both families'
 * masters and the audio-stripped social cut are always included.
 */
export function videoPurgeUrls(logId: string, { squared }: { squared: boolean }): string[] {
  const media = trackMedia(logId);
  const urls = new Set<string>();

  // The R2 masters themselves (bare object URLs — the transform sources, and the
  // <video> fallback on a transform error). `?v` is NOT appended to the bare
  // master URL anywhere (only transform SOURCES carry it), so purge it un-versioned.
  urls.add(media.videoUrl); // footage.mp4 (square or legacy portrait master)
  urls.add(media.socialVideoUrl); // footage.social.mp4 (portrait social cut)

  // The audio-stripped social cut (TikTok push) — `videoAudioStripped` off the
  // social master. Built from a full URL, so pass the social master.
  urls.add(videoAudioStripped(media.socialVideoUrl));

  if (squared) {
    // Two-master crops: every orientation × every ladder width (Stories sizes the
    // crop to the measured pane; /log + radio use the native width). Plus the
    // silent (audio=false) crop radio loops, and the opening-frame crop poster.
    for (const orientation of ["landscape", "portrait"] as const) {
      for (const width of PURGE_RENDITION_WIDTHS) {
        urls.add(videoCrop(logId, orientation, width));
        urls.add(videoCrop(logId, orientation, width, true)); // radio silent loop
        urls.add(videoCropPoster(logId, orientation, width)); // opening-frame poster
      }

      // The native-width crops (no explicit width → the orientation's native): the
      // fixed-resolution /log + radio-head requests, distinct cache keys from the
      // ladder rungs above.
      urls.add(videoCrop(logId, orientation));
      urls.add(videoCrop(logId, orientation, undefined, true));
      urls.add(videoCropPoster(logId, orientation));
    }
  } else {
    // Legacy portrait renditions: the width-ladder video off footage.mp4, plus the
    // opening-frame poster (mode=frame).
    for (const width of PURGE_RENDITION_WIDTHS) {
      urls.add(videoRendition(logId, { width }));
    }

    urls.add(videoPoster(logId));
  }

  return [...urls];
}
