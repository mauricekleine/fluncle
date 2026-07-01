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

// The brand-frame ink (DESIGN.md tokens). The overlay is print floating over the cosmos,
// not a screen-grab caption bar: Starlight-Cream glyphs lifted off the footage by a
// warm-dark ink-halo (a Deep-Field border + a small Deep-Field drop shadow) — the Warm
// Dark + Through-the-Glass + Legible Sky rules. NO #000, NO gold: the overlay stays quiet
// and well under the One-Sun budget (the eclipse gold is spent elsewhere in the brand).
export const CLIP_TEXT_COLOR = "0xf4ead7"; // Starlight Cream (#f4ead7)
export const CLIP_HALO_COLOR = "0x090a0b"; // Deep Field (#090a0b), the warm near-black
export const CLIP_SHADOW_OFFSET = 2; // px; a soft Deep-Field drop shadow for depth

// The Oxanium SemiBold the brand speaks in (DESIGN.md "One Voice"). freetype (ffmpeg's
// drawtext) can only read a .ttf/.otf, never the app's .woff2 — so the box bakes a static
// TTF here (docs/agents/hermes/Dockerfile) and the cut defaults to it with no manual step.
// The repo copy for local renders lives at apps/cli/assets/fonts/Oxanium-SemiBold.ttf.
export const BOX_CLIP_FONT_FILE = "/opt/fonts/Oxanium-SemiBold.ttf";

/** The clip's pseudo-finding master key on R2 — what every MT helper resolves against. */
export function clipFootageKey(clipId: string): string {
  return `${clipId}/footage.mp4`;
}

/**
 * Resolve the drawtext font with no manual step: an explicit `CLIP_FONT_FILE` wins;
 * otherwise fall back to the Oxanium the Hermes image bakes at `BOX_CLIP_FONT_FILE` when
 * it's present (the box always has it, so the cron cut speaks Oxanium automatically). When
 * neither exists — a bare local shell without the baked path — return `undefined` so the
 * filter omits `fontfile=` and freetype uses fontconfig's default rather than failing.
 */
export function resolveClipFontFile(): string | undefined {
  const explicit = process.env.CLIP_FONT_FILE;

  if (explicit) {
    return explicit;
  }

  return existsSync(BOX_CLIP_FONT_FILE) ? BOX_CLIP_FONT_FILE : undefined;
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
  /** Optional absolute path to a .ttf/.otf freetype can read (Oxanium on the box). */
  fontFile?: string;
  /** The font size in px. Drives the ink-halo weight so it scales with the glyphs. */
  size: number;
  /** RAW text (unescaped) — the helper runs it through `escapeDrawtextValue`. */
  text: string;
  /** ffmpeg drawtext x/y expressions (e.g. `56`, `h-208`). */
  x: number | string;
  y: number | string;
};

/**
 * One brand `drawtext` node in the Nostalgic-Cosmos treatment: Starlight-Cream glyphs
 * (Oxanium when `fontFile` is threaded) lifted off the footage by a warm-dark ink-halo —
 * a generous Deep-Field `borderw` plus a small Deep-Field drop shadow — NOT a `#000` box.
 * The halo scales with `size` so the outline stays proportional across the title and the
 * smaller coordinate. Reusable so a later Phase-2 per-cue Track-ID line stamps identically
 * (it becomes the changing text over this exact style). Takes RAW text and escapes it.
 */
export function brandDrawtext(options: BrandDrawtextOptions): string {
  const value = escapeDrawtextValue(options.text);
  const font = options.fontFile ? `:fontfile='${options.fontFile}'` : "";
  // A generous halo (~13% of the cap height) reads as an ink outline, not a hairline.
  const borderw = Math.max(2, Math.round(options.size * 0.13));

  return (
    `drawtext=text='${value}'${font}:` +
    `fontcolor=${CLIP_TEXT_COLOR}:fontsize=${options.size}:` +
    `x=${options.x}:y=${options.y}:` +
    `borderw=${borderw}:bordercolor=${CLIP_HALO_COLOR}:` +
    `shadowcolor=${CLIP_HALO_COLOR}:shadowx=${CLIP_SHADOW_OFFSET}:shadowy=${CLIP_SHADOW_OFFSET}`
  );
}

export type ClipCutFilterOptions = {
  /** Optional absolute path to a .ttf/.otf the box has installed (env CLIP_FONT_FILE). */
  fontFile?: string;
  logId: string;
  title: string;
  /** The 9:16 framing offset (px from the left of the landscape source). */
  xOffset: number;
};

/**
 * Build the single `-vf` filtergraph: crop 16:9 → 9:16 at `xOffset`, scale to
 * 1080×1920, then the minimal brand frame — the mixtape title + the `fluncle://<logId>`
 * coordinate, both as `brandDrawtext` (Starlight-Cream print + warm-dark ink-halo). Pure
 * + testable; the per-track title is Phase-2 (needs cues) — v1 stamps the mixtape level.
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

  // Both lines bottom-left: the mixtape title over the fluncle:// coordinate.
  const titleDraw = brandDrawtext({
    fontFile: options.fontFile,
    size: 46,
    text: options.title,
    x: 56,
    y: "h-208",
  });
  const coordinateDraw = brandDrawtext({
    fontFile: options.fontFile,
    size: 30,
    text: `fluncle://${options.logId}`,
    x: 56,
    y: "h-132",
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
      fontFile: resolveClipFontFile(),
      inMs: clip.inMs,
      logId: mixtape.logId,
      outMs: clip.outMs,
      outputPath,
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
