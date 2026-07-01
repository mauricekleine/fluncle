// Fluncle Studio — the footage cut. Turn one `pending` clip into a framed,
// brand-stamped 9:16 clip on R2, then mark it `done`.
//
// A clip is a real ffmpeg cut from the landscape 1080p set rendition (the
// `<logId>/set.mp4`): trim `[inMs,outMs]`, crop 16:9 → 9:16 at the operator's
// `xOffset`, bake a minimal brand frame (the changing on-screen Track-ID — the track(s)
// playing in the window, resolved from the mixtape cues, or the mixtape title when un-cued
// — over the `fluncle://<logId>` coordinate, as Starlight-Cream print held legible by a
// warm-dark ink-halo — the Nostalgic Cosmos, not a #000 caption box; DESIGN.md), and store it as the
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
import { type ClipTrackInput, resolveClipTracks } from "@fluncle/contracts/util";
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
// Print floating over the cosmos, not a screen-grab caption bar. NO #000, NO gold: the
// overlay stays quiet, well under the One-Sun budget (gold is spent elsewhere in the brand).
//
// The HALO is a 1:1 port of FloatingType's `inkHalo`: a SOFT, SYMMETRIC, BLURRED glow-out
// in Deep-Field — NOT a hard outline and NOT an offset drop shadow. floating-type.tsx layers
// `0 0 Npx` blurred shadows (radii ~1/2/4/8/14px, dense at the glyph edge, feathering out);
// ffmpeg `drawtext` can't blur, so the graph below draws the glyphs onto a transparent layer
// in Deep-Field, `gblur`s it in two passes (a tight dense CORE + a wider FEATHER), and
// overlays that under the sharp ink — a symmetric dark glow, no offset (Warm Dark / Legible
// Sky). The sharp ink carries at most a 1px symmetric border for the tightest core.
export const CLIP_TITLE_COLOR = "0xf4ead7"; // Starlight Cream — the title (trackLine ink)
export const CLIP_COORDINATE_COLOR = "0xb7ab95"; // Stardust — the coordinate, dim/subordinate
export const CLIP_HALO_COLOR = "0x090a0b"; // Deep Field (#090a0b), the warm near-black glow
export const CLIP_HALO_CORE_SIGMA = 3; // gblur sigma: the tight, dense inky core at the glyph
export const CLIP_HALO_FEATHER_SIGMA = 9; // gblur sigma: the wide, soft feather bleeding out
export const CLIP_SHARP_BORDERW = 1; // px; a 1px symmetric core outline on the sharp ink (no offset)

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
  /**
   * Symmetric outline width in px (default 0 = none). Used ONLY for the tight 1px core on
   * the sharp ink; the soft glow comes from the blurred halo layer, never a hard border and
   * never an offset drop shadow. A `bordercolor` of Deep-Field is emitted with it.
   */
  borderw?: number;
  /** Ink color (ffmpeg color, e.g. `0xf4ead7`). Cream/Stardust for sharp ink, Deep-Field for the halo. */
  color: string;
  /**
   * A drawtext `enable` expression (e.g. `between(t,0.000,5.000)`) that time-gates the
   * line — used for the changing per-cue Track-ID, so each track's line shows only over
   * its sub-window of the clip. Omitted → the line is always drawn.
   */
  enable?: string;
  /**
   * Absolute path to the .ttf/.otf for THIS line's font role — the bold sans for the
   * title/track lines, Oxanium for the coordinate. Omitted → fontconfig default.
   */
  fontFile?: string;
  /** The font size in px. */
  size: number;
  /** RAW text (unescaped) — the helper runs it through `escapeDrawtextValue`. */
  text: string;
  /** ffmpeg drawtext x/y expressions (e.g. `96`, `h-230-th`). */
  x: number | string;
  y: number | string;
};

/**
 * One `drawtext` node. Draws the glyphs in `color` at the given size/position — NO offset
 * shadow, and a border only when `borderw` is set (a symmetric outline, never a directional
 * drop shadow). The two font ROLES are parameterized (color + fontFile), so the title takes
 * the bold sans and the coordinate takes Oxanium from the same helper — and Slice C's
 * per-cue Track-ID lines reuse it with the title's sans role. Takes RAW text and escapes it.
 * The soft glow-out halo is applied around these glyphs by the filtergraph (`gblur`), not here.
 */
export function brandDrawtext(options: BrandDrawtextOptions): string {
  const value = escapeDrawtextValue(options.text);
  const font = options.fontFile ? `:fontfile='${options.fontFile}'` : "";
  const border =
    options.borderw && options.borderw > 0
      ? `:borderw=${options.borderw}:bordercolor=${CLIP_HALO_COLOR}`
      : "";
  // The enable expression's commas are protected by the single quotes (ffmpeg only
  // splits unquoted `:`/`,`), so `between(t,a,b)` rides through as one option value.
  const enable = options.enable ? `:enable='${options.enable}'` : "";

  return (
    `drawtext=text='${value}'${font}:` +
    `fontcolor=${options.color}:fontsize=${options.size}:` +
    `x=${options.x}:y=${options.y}${border}${enable}`
  );
}

export type ClipCutFilterOptions = {
  /**
   * The clip window start in the set (ms). With `members` + `setDurationMs` it resolves
   * the changing per-cue Track-ID; defaults to 0 (the un-cued fallback ignores it).
   */
  inMs?: number;
  logId: string;
  /**
   * The mixtape's cued members (each `Artist — Title` + `startMs`). When the set is cued,
   * the primary line becomes the CHANGING track(s) playing in `[inMs, outMs)`. Empty /
   * omitted / un-cued ⇒ the static mixtape-title fallback (unchanged behavior).
   */
  members?: ClipTrackInput[];
  /** Oxanium for the coordinate line (env CLIP_FONT_FILE / the baked box path). */
  oxaniumFontFile?: string;
  /** The clip window end in the set (ms). Pairs with `inMs` to gate the per-cue lines. */
  outMs?: number;
  /** Bold sans for the title line (env CLIP_SANS_FONT_FILE / the baked box path). */
  sansFontFile?: string;
  /** The full set duration (ms) — the last cued member runs to it. */
  setDurationMs?: number;
  title: string;
  /** The 9:16 framing offset (px from the left of the landscape source). */
  xOffset: number;
};

/** The shared per-line geometry (font role, size, safe-area position, optional time gate). */
type ClipLine = Pick<BrandDrawtextOptions, "enable" | "fontFile" | "size" | "text" | "x" | "y">;

/**
 * The primary title line(s) for the brand frame at title row `y`. A CUED set resolves the
 * clip window → the track(s) playing in it, one line per track, each gated
 * `enable='between(t,relStart,relEnd)'` in seconds relative to the clip start
 * (`relStart = clamp((track.startMs - inMs)/1000, [0, clipDur])`, `relEnd` = the next
 * track's relStart or the clip duration) — so the on-screen Track-ID changes at each blend
 * boundary as the clip plays. An UN-CUED set (or a call without members) yields a single
 * static mixtape-title line — today's behavior. All lines share the title font role/size/
 * position; at any playhead only one cued line is enabled.
 */
function resolveTitleLines(options: ClipCutFilterOptions, y: string): ClipLine[] {
  const inMs = options.inMs ?? 0;
  const outMs = options.outMs ?? 0;
  const clipDur = Math.max(0, (outMs - inMs) / 1000);
  const base = { fontFile: options.sansFontFile, size: CLIP_TITLE_SIZE, x: CLIP_MARGIN_X, y };

  const resolved =
    options.members && options.members.length > 0
      ? resolveClipTracks({
          inMs,
          members: options.members,
          outMs,
          setDurationMs: options.setDurationMs ?? 0,
        })
      : [];

  if (resolved.length === 0) {
    return [{ ...base, text: options.title }];
  }

  const clamp = (seconds: number): number => Math.min(Math.max(seconds, 0), clipDur);

  return resolved.map((track, index): ClipLine => {
    const relStart = clamp((track.startMs - inMs) / 1000);
    const next = resolved[index + 1];
    const relEnd = next ? clamp((next.startMs - inMs) / 1000) : clipDur;

    return {
      ...base,
      enable: `between(t,${relStart.toFixed(3)},${relEnd.toFixed(3)})`,
      text: track.label,
    };
  });
}

/**
 * Build the `-filter_complex` graph: crop 16:9 → 9:16 at `xOffset`, scale to 1080×1920,
 * then the brand frame — a 1:1 mirror of the Remotion TypePlate identity block. Two
 * bottom-left lines: a PRIMARY track line (system-sans stand-in, Starlight Cream, size 40,
 * the trackLine) over the `fluncle://<logId>` COORDINATE (Oxanium, Stardust/dim, size 22,
 * the logId). The block sits in the platform safe-area: `CLIP_MARGIN_X` from the left, its
 * BOTTOM edge `CLIP_SAFE_BOTTOM` above the frame bottom, lines stacked with `CLIP_LINE_GAP`
 * (`th` = each drawtext's own text height, so the stack reads from the safe-area floor up
 * regardless of the font's exact metrics). No top-right meta/Found block (unlike a per-track
 * clip).
 *
 * THE CHANGING ON-SCREEN TRACK-ID: when the set is CUED (`members` carry `startMs`), the
 * primary line is resolved per clip window (`resolveClipTracks`) to the track(s) PLAYING in
 * `[inMs, outMs)` — one gated `drawtext` per track (`enable='between(t,relStart,relEnd)'`),
 * so the ID changes at each blend boundary as the clip plays (see `resolveTitleLines`). An
 * UN-CUED set resolves to `[]` and the primary line falls back to the static mixtape title.
 *
 * THE HALO is FloatingType's soft `inkHalo`, not a hard outline or offset shadow: the same
 * glyphs are drawn in Deep-Field onto a transparent RGBA layer, `gblur`ed in two passes (a
 * tight dense CORE + a wider FEATHER), overlaid UNDER the sharp ink — a symmetric dark
 * glow-out that lifts the type off bright ground. `drawtext` alone cannot blur, hence the
 * `-filter_complex`. The graph's final video pad is `[out]` (mapped by `clipCutFfmpegArgs`).
 *
 * ffmpeg drawtext has no letter-spacing, so the Remotion logId's `0.12em` tracking is not
 * reproduced (a known minor gap; the dim, small Oxanium is the match that carries).
 *
 * LEGIBILITY (the Legible Sky Rule): the set footage is a home-studio DJ deck (mid-tones,
 * no lasers), so the soft halo holds AA there without an occluding box. If a FUTURE clip has
 * white-strobe frames that break the halo, the AA fallback is a warm-dark *translucent* box
 * (`box=1:boxcolor=0x10100d@0.6`, Sleeve Black, never `#000`) on the sharp pass — not a
 * return to the hard black scrim. Pick per footage; the soft halo is the default.
 */
export function clipCutFilterComplex(options: ClipCutFilterOptions): string {
  const xOffset = Math.max(0, Math.round(options.xOffset));
  const crop = `crop=ih*9/16:ih:${xOffset}:0,scale=${CLIP_WIDTH}:${CLIP_HEIGHT}`;

  // Stack from the safe-area floor: the coordinate's bottom sits CLIP_SAFE_BOTTOM above the
  // frame bottom; the title sits above it by (the coordinate's line box + the gap).
  const coordinateBox = Math.round(CLIP_COORDINATE_SIZE * 1.18); // approx line-box height
  const titleBottomOffset = CLIP_SAFE_BOTTOM + coordinateBox + CLIP_LINE_GAP;
  const titleY = `h-${titleBottomOffset}-th`;

  // The PRIMARY line(s). Resolve the clip window → the track(s) playing in it. When the
  // set is cued, each resolved track is its own title line, time-gated to its sub-window
  // (so the on-screen Track-ID CHANGES across a blend). An un-cued set resolves to `[]`,
  // and the primary line falls back to the static mixtape title (unchanged behavior).
  const titleLines = resolveTitleLines(options, titleY);

  const coordinate: ClipLine = {
    fontFile: options.oxaniumFontFile,
    size: CLIP_COORDINATE_SIZE,
    text: `fluncle://${options.logId}`,
    x: CLIP_MARGIN_X,
    y: `h-${CLIP_SAFE_BOTTOM}-th`,
  };

  // The halo source: every line in Deep-Field on a transparent layer, no border/shadow.
  // Each title line keeps its `enable` gate so its halo appears/disappears with its ink.
  const haloGlyphs = [
    ...titleLines.map((line) => brandDrawtext({ ...line, color: CLIP_HALO_COLOR })),
    brandDrawtext({ ...coordinate, color: CLIP_HALO_COLOR }),
  ].join(",");

  // The sharp ink on top: title cream, coordinate dim Stardust, a 1px symmetric core only.
  const sharpGlyphs = [
    ...titleLines.map((line) =>
      brandDrawtext({ ...line, borderw: CLIP_SHARP_BORDERW, color: CLIP_TITLE_COLOR }),
    ),
    brandDrawtext({ ...coordinate, borderw: CLIP_SHARP_BORDERW, color: CLIP_COORDINATE_COLOR }),
  ].join(",");

  return [
    `[0:v]${crop},setsar=1[base]`,
    `color=c=black@0:s=${CLIP_WIDTH}x${CLIP_HEIGHT},format=rgba,${haloGlyphs}[ink]`,
    `[ink]split[ink1][ink2]`,
    `[ink1]gblur=sigma=${CLIP_HALO_CORE_SIGMA}[core]`,
    `[ink2]gblur=sigma=${CLIP_HALO_FEATHER_SIGMA}[feather]`,
    `[base][feather]overlay=0:0[b1]`,
    `[b1][core]overlay=0:0[b2]`,
    `[b2]${sharpGlyphs}[out]`,
  ].join(";");
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
 *
 * The brand frame is a `-filter_complex` (the soft blurred halo needs `gblur`, which a
 * simple `-vf` chain can't feed), so the video output pad `[out]` is mapped explicitly and
 * the source audio rides through with `-map 0:a?` (optional — a set with no audio still cuts).
 */
export function clipCutFfmpegArgs(options: ClipCutFfmpegOptions): string[] {
  const inSeconds = (options.inMs / 1000).toFixed(3);
  const durationSeconds = ((options.outMs - options.inMs) / 1000).toFixed(3);
  const filter = clipCutFilterComplex(options);

  return [
    "-y",
    "-ss",
    inSeconds,
    "-i",
    options.setUrl,
    "-t",
    durationSeconds,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-map",
    "0:a?",
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
      // The cued members drive the changing on-screen Track-ID; an un-cued set (no
      // startMs on any member) resolves to [] and the cut falls back to the title.
      members: mixtape.members,
      outMs: clip.outMs,
      outputPath,
      oxaniumFontFile: resolveClipFontFile(),
      sansFontFile: resolveClipSansFontFile(),
      setDurationMs: mixtape.durationMs ?? 0,
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
