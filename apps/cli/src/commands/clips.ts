// Fluncle Studio — the footage cut. Turn one `pending` clip into a framed,
// brand-stamped 9:16 clip on R2, then mark it `done`.
//
// A clip is a real ffmpeg cut from the landscape 1080p set rendition (the
// `<logId>/set.mp4`): trim `[inMs,outMs]`, crop 16:9 → 9:16 at the operator's
// `xOffset`, bake a minimal brand frame (the mixtape title + the `fluncle://<logId>`
// coordinate as Starlight-Cream print held legible by a warm-dark ink-halo — the
// Nostalgic Cosmos, not a #000 caption box; DESIGN.md), and store it as the
// clip's pseudo-finding master `<clipId>/footage.mp4` so the merged `videoCrop(clipId)`
// / `videoCropPoster` / `videoAudioStripped` MT helpers finish it (the resolution
// ladder, the poster, the silent TikTok variant) — see apps/web/src/lib/media.ts.
//
// WHERE IT RUNS: the always-on Hermes box (rave-02), driven by the `fluncle-studio-clip`
// `--no-agent` cron (docs/agents/hermes/scripts/clip-sweep.ts), which lists pending
// clips and calls `fluncle admin clips cut <clipId>` per clip. The box holds NO R2
// creds — the agent token signs a SINGLE-PUT upload (`presign_clip_upload`, agent tier;
// a clip is < 100 MB) and the box streams the cut straight to R2, then `finalize_clip_cut`
// marks it done + purges the stale edge renditions server-side (a re-cut to the same
// clipId must not keep serving the old cut — #152 lesson).
//
// CI HAS NO ffmpeg: every pure helper below (the ffmpeg arg shape, the footage key, the
// drawtext brand-frame assembly + escaping) is exported and unit-tested WITHOUT invoking
// ffmpeg (clips.test.ts). The one shell-out is skip-guarded on a `ffmpeg -version` probe.

import {
  type ClipCutFinalizeResponse,
  type ClipPresignResponse,
  type ClipsResponse,
  type ClipDTO,
} from "@fluncle/contracts";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminApiGet, adminApiPost } from "../api";
import { CliError } from "../output";

// The public read base for stored artifacts (matches the Worker's FOUND_BASE). The set
// rendition + the clip's pseudo-finding master both live under it, keyed by their id.
const FOUND_BASE = "https://found.fluncle.com";

// The portrait clip geometry + the encode caps. The clip is BITRATE-CAPPED so the
// output `footage.mp4` stays < 100 MB — else Cloudflare Media Transformations 400s the
// fan-out (its source ceiling). A 60 s 1080×1920 cut at maxrate 10M lands ~75 MB of
// video + ~1.5 MB audio, comfortably under the cap.
export const CLIP_WIDTH = 1080;
export const CLIP_HEIGHT = 1920;
export const CLIP_CRF = 21;
export const CLIP_MAXRATE = "10M";
export const CLIP_BUFSIZE = "20M";
export const CLIP_AUDIO_BITRATE = "192k";

// Cloudflare MT rejects a source over 100 MB; the cut must clear it (the bitrate cap is
// the primary guard, this is the backstop the cut command asserts on the rendered file).
export const MAX_CLIP_BYTES = 100 * 1024 * 1024;

// The brand-frame ink (DESIGN.md tokens). The overlay MIRRORS the Remotion per-track
// TypePlate identity block (packages/video: floating-type.tsx `trackLine` + `logId`,
// laid out by type-plate.tsx) so a mixtape clip reads as the same object as a track clip.
// Print floating over the cosmos, not a screen-grab caption bar: glyphs lifted off the
// footage by a warm-dark ink-halo (a Deep-Field border + a small Deep-Field drop shadow,
// the ffmpeg approximation of FloatingType's `inkHalo`) — the Warm Dark + Through-the-Glass
// + Legible Sky rules. NO #000, NO gold: the overlay stays quiet, well under the One-Sun
// budget (gold is spent elsewhere in the brand).
export const CLIP_TITLE_COLOR = "0xf4ead7"; // Starlight Cream — the title (trackLine ink)
export const CLIP_COORDINATE_COLOR = "0xb7ab95"; // Stardust — the coordinate, dim/subordinate
export const CLIP_HALO_COLOR = "0x090a0b"; // Deep Field (#090a0b), the warm near-black halo
export const CLIP_SHADOW_OFFSET = 2; // px; a soft Deep-Field drop shadow for depth

// Type scale + placement, 1:1 with the Remotion canvas (both are 1080×1920, so px map
// directly). The title is the mixtape name (trackLine: system sans, size 40); the
// coordinate is `fluncle://<logId>` (logId: Oxanium, size 22, dim). Bottom-left, lifted
// into the platform safe-area: MARGIN_X left inset, the block's BOTTOM edge SAFE_BOTTOM
// above the frame bottom (clears the TikTok/IG/YT bottom chrome), lines stacked with LINE_GAP.
export const CLIP_MARGIN_X = 96; // MARGIN_X (type-plate.tsx)
export const CLIP_SAFE_BOTTOM = 230; // SAFE_BOTTOM (type-plate.tsx)
export const CLIP_LINE_GAP = 10; // IDENTITY_STYLE gap
export const CLIP_TITLE_SIZE = 40; // trackLine fontSize
export const CLIP_COORDINATE_SIZE = 22; // logId fontSize

// The two font faces freetype (ffmpeg drawtext) draws with — it reads only .ttf/.otf,
// never the app's .woff2. Both are baked into the Hermes image (docs/agents/hermes/
// Dockerfile) so the on-box cut resolves them with no manual step:
//   - TITLE = a bold grotesque standing in for the Remotion trackLine's `ui-sans-serif,
//     system-ui, sans-serif`. That family is NOT an embedded webfont in packages/video,
//     so the render box's headless Chromium falls to its generic `sans-serif` — DejaVu
//     Sans on Debian — which is exactly what we bake here, so the clip matches the render.
//   - COORDINATE = Oxanium (DESIGN.md "One Voice": Oxanium for marks/numerals only).
// The repo Oxanium copy for local renders lives at apps/cli/assets/fonts/Oxanium-SemiBold.ttf;
// DejaVu is an OS package (fonts-dejavu-core), so point CLIP_SANS_FONT_FILE at a local copy
// for a local render.
export const BOX_CLIP_FONT_FILE = "/opt/fonts/Oxanium-SemiBold.ttf";
export const BOX_CLIP_SANS_FONT_FILE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/** The clip's pseudo-finding master key on R2 — what every MT helper resolves against. */
export function clipFootageKey(clipId: string): string {
  return `${clipId}/footage.mp4`;
}

/**
 * Resolve a baked font with no manual step: an explicit env override wins; otherwise fall
 * back to the path the Hermes image bakes when it exists (the box always has it, so the
 * cron cut is styled automatically). When neither exists — a bare local shell without the
 * baked path — return `undefined` so the filter omits `fontfile=` and freetype uses
 * fontconfig's default rather than failing.
 */
function resolveFontFile(envVar: string, bakedPath: string): string | undefined {
  const explicit = process.env[envVar];

  if (explicit) {
    return explicit;
  }

  return existsSync(bakedPath) ? bakedPath : undefined;
}

/** The Oxanium the coordinate line is drawn in (`CLIP_FONT_FILE` overrides the baked path). */
export function resolveClipFontFile(): string | undefined {
  return resolveFontFile("CLIP_FONT_FILE", BOX_CLIP_FONT_FILE);
}

/** The bold sans the title line is drawn in (`CLIP_SANS_FONT_FILE` overrides the baked path). */
export function resolveClipSansFontFile(): string | undefined {
  return resolveFontFile("CLIP_SANS_FONT_FILE", BOX_CLIP_SANS_FONT_FILE);
}

/** The landscape set rendition the cut reads from R2 (Unit A's `<logId>/set.mp4`). */
export function setVideoUrl(logId: string): string {
  return `${FOUND_BASE}/${encodeURIComponent(logId)}/set.mp4`;
}

/**
 * Escape a string for use as an ffmpeg drawtext `text='…'` value passed as ONE argv
 * token (no shell — `Bun.spawn` passes argv directly). The single quotes alone do NOT
 * protect the filtergraph separators `:` and `,` — ffmpeg's parser still splits on them,
 * so a `fluncle://<logId>` coordinate (or a title with a colon/comma) breaks the graph
 * with "No option name near …". They must be backslash-escaped. Also handle the
 * backslash itself, the `%` (drawtext's `%{…}` expansion sigil), and a literal `'` (the
 * close-escape-reopen idiom `'\''`). Order matters: backslashes first (so the escapes we
 * add below are not themselves doubled), then the separators, then `%`, then the quote.
 */
export function escapeDrawtextValue(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%")
    .replace(/'/g, "'\\''");
}

export type BrandDrawtextOptions = {
  /** Ink color (ffmpeg color, e.g. `0xf4ead7`). Cream for the title, Stardust for the coordinate. */
  color: string;
  /**
   * Absolute path to the .ttf/.otf for THIS line's font role — the bold sans for the
   * title/track lines, Oxanium for the coordinate. Omitted → fontconfig default.
   */
  fontFile?: string;
  /** The font size in px. Drives the ink-halo weight so it scales with the glyphs. */
  size: number;
  /** RAW text (unescaped) — the helper runs it through `escapeDrawtextValue`. */
  text: string;
  /** ffmpeg drawtext x/y expressions (e.g. `96`, `h-230-th`). */
  x: number | string;
  y: number | string;
};

/**
 * One brand `drawtext` node in the Nostalgic-Cosmos treatment: ink lifted off the footage
 * by a warm-dark ink-halo — a generous Deep-Field `borderw` plus a small Deep-Field drop
 * shadow — NOT a `#000` box. The two font ROLES are parameterized (color + fontFile), so
 * the title takes the bold sans and the coordinate takes Oxanium from the same helper —
 * and Slice C's per-cue Track-ID lines reuse it with the title's sans role. The halo scales
 * with `size` so the outline stays proportional across sizes. Takes RAW text and escapes it.
 */
export function brandDrawtext(options: BrandDrawtextOptions): string {
  const value = escapeDrawtextValue(options.text);
  const font = options.fontFile ? `:fontfile='${options.fontFile}'` : "";
  // A generous halo (~13% of the cap height) reads as an ink outline, not a hairline.
  const borderw = Math.max(2, Math.round(options.size * 0.13));

  return (
    `drawtext=text='${value}'${font}:` +
    `fontcolor=${options.color}:fontsize=${options.size}:` +
    `x=${options.x}:y=${options.y}:` +
    `borderw=${borderw}:bordercolor=${CLIP_HALO_COLOR}:` +
    `shadowcolor=${CLIP_HALO_COLOR}:shadowx=${CLIP_SHADOW_OFFSET}:shadowy=${CLIP_SHADOW_OFFSET}`
  );
}

export type ClipCutFilterOptions = {
  logId: string;
  /** Oxanium for the coordinate line (env CLIP_FONT_FILE / the baked box path). */
  oxaniumFontFile?: string;
  /** Bold sans for the title line (env CLIP_SANS_FONT_FILE / the baked box path). */
  sansFontFile?: string;
  title: string;
  /** The 9:16 framing offset (px from the left of the landscape source). */
  xOffset: number;
};

/**
 * Build the single `-vf` filtergraph: crop 16:9 → 9:16 at `xOffset`, scale to 1080×1920,
 * then the brand frame — a 1:1 mirror of the Remotion TypePlate identity block. Two
 * bottom-left lines: the mixtape TITLE (system-sans stand-in, Starlight Cream, size 40,
 * the trackLine) over the `fluncle://<logId>` COORDINATE (Oxanium, Stardust/dim, size 22,
 * the logId), each a `brandDrawtext` (warm-dark ink-halo, no #000 box). The block sits in
 * the platform safe-area: `CLIP_MARGIN_X` from the left, its BOTTOM edge `CLIP_SAFE_BOTTOM`
 * above the frame bottom, lines stacked with `CLIP_LINE_GAP`. Pure + testable; per-cue
 * per-TRACK lines are Phase-2 (Slice C) — v1 stamps the mixtape level (no top-right
 * meta/Found block, unlike a per-track clip).
 *
 * `th` (each drawtext's own text height) anchors each line's BOTTOM, so the stack reads
 * from the safe-area floor up regardless of the font's exact metrics. ffmpeg drawtext has
 * no letter-spacing, so the Remotion logId's `0.12em` tracking is not reproduced (a known
 * minor gap; the dim, small Oxanium is the match that carries).
 *
 * LEGIBILITY (the Legible Sky Rule): the set footage is a home-studio DJ deck (mid-tones,
 * no lasers), so the ink-halo holds AA there without an occluding box. If a FUTURE clip
 * has white-strobe frames that break the halo, the AA fallback is a warm-dark *translucent*
 * box — `box=1:boxcolor=0x10100d@0.6` (Sleeve Black, never `#000`) — added per line, not a
 * return to the hard black scrim. Pick per footage; the ink-halo is the default.
 */
export function clipCutVideoFilter(options: ClipCutFilterOptions): string {
  const xOffset = Math.max(0, Math.round(options.xOffset));
  const crop = `crop=ih*9/16:ih:${xOffset}:0,scale=${CLIP_WIDTH}:${CLIP_HEIGHT}`;

  // Stack from the safe-area floor: the coordinate's bottom sits CLIP_SAFE_BOTTOM above the
  // frame bottom; the title sits above it by (the coordinate's line box + the gap). Anchor
  // each line's bottom with its own text height `th`.
  const coordinateBox = Math.round(CLIP_COORDINATE_SIZE * 1.18); // approx line-box height
  const titleBottomOffset = CLIP_SAFE_BOTTOM + coordinateBox + CLIP_LINE_GAP;

  const titleDraw = brandDrawtext({
    color: CLIP_TITLE_COLOR,
    fontFile: options.sansFontFile,
    size: CLIP_TITLE_SIZE,
    text: options.title,
    x: CLIP_MARGIN_X,
    y: `h-${titleBottomOffset}-th`,
  });
  const coordinateDraw = brandDrawtext({
    color: CLIP_COORDINATE_COLOR,
    fontFile: options.oxaniumFontFile,
    size: CLIP_COORDINATE_SIZE,
    text: `fluncle://${options.logId}`,
    x: CLIP_MARGIN_X,
    y: `h-${CLIP_SAFE_BOTTOM}-th`,
  });

  return `${crop},${titleDraw},${coordinateDraw}`;
}

export type ClipCutFfmpegOptions = ClipCutFilterOptions & {
  inMs: number;
  outMs: number;
  outputPath: string;
  setUrl: string;
};

/**
 * The ffmpeg argv that cuts + frames the clip in ONE pass from the set rendition. Pure
 * (a thin shell-out spec), so the arg shape is unit-tested without invoking ffmpeg.
 *
 * `-ss` BEFORE `-i` is an input seek — over HTTP against the faststart `set.mp4` it
 * range-requests to the offset instead of downloading the whole ~1.5 GB rendition — and
 * with the re-encode below it is frame-accurate in modern ffmpeg. The bitrate cap
 * (`-maxrate`/`-bufsize` + CRF) keeps the output under 100 MB; `+faststart` puts the
 * moov atom up front so the result range-streams + survives MT.
 */
export function clipCutFfmpegArgs(options: ClipCutFfmpegOptions): string[] {
  const inSeconds = (options.inMs / 1000).toFixed(3);
  const durationSeconds = ((options.outMs - options.inMs) / 1000).toFixed(3);
  const filter = clipCutVideoFilter(options);

  return [
    "-y",
    "-ss",
    inSeconds,
    "-i",
    options.setUrl,
    "-t",
    durationSeconds,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(CLIP_CRF),
    "-maxrate",
    CLIP_MAXRATE,
    "-bufsize",
    CLIP_BUFSIZE,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    CLIP_AUDIO_BITRATE,
    "-movflags",
    "+faststart",
    options.outputPath,
  ];
}

/** List clips via the admin API (Unit G `list_clips`; agent token clears requireAdmin). */
export async function clipsListCommand(
  filter: { mixtapeId?: string; status?: string } = {},
): Promise<ClipDTO[]> {
  const params = new URLSearchParams();

  if (filter.mixtapeId) {
    params.set("mixtapeId", filter.mixtapeId);
  }

  if (filter.status) {
    params.set("status", filter.status);
  }

  const query = params.toString();
  const response = await adminApiGet<ClipsResponse>(`/api/admin/clips${query ? `?${query}` : ""}`);

  return response.clips;
}

export type ClipCutResult = {
  clipId: string;
  key: string;
  logId: string;
  sizeBytes: number;
  url: string;
};

/**
 * Cut one clip end to end: resolve its mixtape's staged set rendition → ffmpeg
 * (trim + crop + brand frame) → single-PUT upload to R2 (`presign_clip_upload`) →
 * `finalize_clip_cut` (mark done + server-side edge purge). Idempotent: re-cutting the
 * same clipId re-ships `<clipId>/footage.mp4` to the same key and the finalize purges
 * the stale renditions.
 */
export async function clipCutCommand(
  clipId: string,
  onProgress: (message: string) => void = () => {},
): Promise<ClipCutResult> {
  const clips = await clipsListCommand();
  const clip = clips.find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new CliError("clip_not_found", `No clip with id ${clipId}`);
  }

  // Resolve the mixtape (its committed Log ID + display title) — mixtapeGetCommand lists
  // admin mixtapes (drafts included) and matches by id or log id.
  const { mixtapeGetCommand } = await import("./mixtapes");
  const mixtape = await mixtapeGetCommand(clip.mixtapeId);

  if (!mixtape.logId) {
    throw new CliError("mixtape_no_log_id", `Mixtape ${clip.mixtapeId} has no committed Log ID`);
  }

  if (!mixtape.setVideoAt) {
    throw new CliError(
      "set_not_staged",
      `Mixtape ${mixtape.logId} has no staged set video — run \`distribute --set-video\` first`,
    );
  }

  await assertFfmpeg();

  const setUrl = setVideoUrl(mixtape.logId);
  const outputPath = join(tmpdir(), `fluncle-clip-${randomUUID()}.mp4`);

  try {
    onProgress(`Clip ${clipId}: cutting [${clip.inMs}–${clip.outMs}ms] from ${mixtape.logId}…`);
    await runClipCut({
      inMs: clip.inMs,
      logId: mixtape.logId,
      outMs: clip.outMs,
      outputPath,
      oxaniumFontFile: resolveClipFontFile(),
      sansFontFile: resolveClipSansFontFile(),
      setUrl,
      title: mixtape.title,
      xOffset: clip.xOffset,
    });

    const sizeBytes = statSync(outputPath).size;

    if (sizeBytes > MAX_CLIP_BYTES) {
      throw new CliError(
        "clip_too_large",
        `The cut is ${(sizeBytes / 1_000_000).toFixed(1)} MB (> 100 MB Cloudflare MT ceiling) — shorten the window or lower the bitrate cap`,
      );
    }

    onProgress(`Clip ${clipId}: uploading ${(sizeBytes / 1_000_000).toFixed(1)} MB…`);
    const presign = await adminApiPost<ClipPresignResponse>(
      `/api/admin/clips/${encodeURIComponent(clipId)}/cut/presign`,
      { contentType: "video/mp4" },
    );

    await putClip(presign.url, presign.contentType, outputPath);

    // Mark the cut done + purge the stale edge renditions (server-side; the box has no
    // Cloudflare creds). A bodyless POST — clipId rides the path.
    await adminApiPost<ClipCutFinalizeResponse>(
      `/api/admin/clips/${encodeURIComponent(clipId)}/cut/finalize`,
    );

    onProgress(`Clip ${clipId}: done → ${FOUND_BASE}/${presign.key}`);

    return {
      clipId,
      key: presign.key,
      logId: mixtape.logId,
      sizeBytes,
      url: `${FOUND_BASE}/${presign.key}`,
    };
  } finally {
    rmSync(outputPath, { force: true });
  }
}

// PUT the rendered clip straight to its presigned URL. The Content-Type MUST match the
// signed one byte-for-byte (it is baked into the signature — SignatureDoesNotMatch
// otherwise). `Bun.file()` is a lazy FS-backed Blob, so the body streams.
async function putClip(url: string, contentType: string, path: string): Promise<void> {
  const response = await fetch(url, {
    body: Bun.file(path),
    headers: { "content-type": contentType },
    method: "PUT",
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new CliError(
      "r2_put_failed",
      `R2 rejected the clip upload (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }
}

// Probe ffmpeg before cutting so a missing binary is a clear, actionable message rather
// than an opaque spawn error (CI never reaches this — the cut command isn't run there).
async function assertFfmpeg(): Promise<void> {
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stderr: "ignore", stdout: "ignore" });
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error("ffmpeg -version exited non-zero");
    }
  } catch {
    throw new CliError(
      "ffmpeg_missing",
      "The clip cut needs ffmpeg. Install it on the box (apt-get install -y ffmpeg).",
    );
  }
}

async function runClipCut(options: ClipCutFfmpegOptions): Promise<void> {
  if (!options.setUrl) {
    throw new CliError("missing_set_url", "The clip cut needs the set rendition URL");
  }

  const proc = Bun.spawn(["ffmpeg", ...clipCutFfmpegArgs(options)], {
    stderr: "pipe",
    stdout: "ignore",
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const detail = (await new Response(proc.stderr).text().catch(() => "")).slice(-400);
    throw new CliError(
      "ffmpeg_failed",
      `ffmpeg failed to cut the clip${detail ? `: ${detail}` : ""}`,
    );
  }
}
