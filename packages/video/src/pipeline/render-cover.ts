// Render the profile-grid cover (a still) for one or more shipped bundles.
//
//   bun src/pipeline/render-cover.ts <bundleDir...>
//
// For each bundle (out/<log-id>/ holding footage.mp4 + props.json) it grabs a
// vivid late frame of the footage (after the in-video TypePlate has cleared, so
// the art is clean), then renders the <Cover> composition over it as cover.jpg.
// The operator AirDrops cover.jpg to Photos and sets it as the post's cover.
//
// Exposed as renderCover() so `ship` produces the cover as part of the bundle;
// the CLI entry below renders covers for existing bundles standalone.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

/** Probe a media file's duration in seconds via ffprobe. */
function durationSec(file: string): number {
  const out = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  const d = Number.parseFloat((out.stdout ?? "").trim());
  return Number.isFinite(d) && d > 0 ? d : 20;
}

/** Grab a single frame at `atSec` as a JPEG data URL (1080×1920 source frame). */
function frameDataUrl(footage: string, atSec: number): string {
  const tmp = mkdtempSync(path.join(tmpdir(), "cover-"));
  const frame = path.join(tmp, "frame.jpg");
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-ss", String(atSec), "-i", footage, "-frames:v", "1", "-q:v", "2", frame],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    rmSync(tmp, { force: true, recursive: true });
    throw new Error(`ffmpeg frame grab failed for ${footage}: ${res.stderr ?? ""}`);
  }
  const b64 = readFileSync(frame).toString("base64");
  rmSync(tmp, { force: true, recursive: true });
  return `data:image/jpeg;base64,${b64}`;
}

/**
 * Render cover.jpg into each bundle dir. Bundles Remotion once, then renders a
 * still per track over a clean late frame of its own footage. Each bundle needs
 * footage.mp4 + props.json (track facts + palette ink); a bundle missing either
 * is skipped with a warning rather than failing the batch.
 */
export async function renderCover(bundleDirs: string[]): Promise<void> {
  if (bundleDirs.length === 0) {
    return;
  }

  const serveUrl = await bundle({ entryPoint: ENTRY_POINT, webpackOverride: (c) => c });

  for (const dir of bundleDirs) {
    const bundleDir = path.resolve(dir);
    const footage = path.join(bundleDir, "footage.mp4");
    const propsPath = path.join(bundleDir, "props.json");
    if (!existsSync(footage) || !existsSync(propsPath)) {
      console.error(`[cover] skipped ${dir} (needs footage.mp4 + props.json)`);
      continue;
    }

    const props = JSON.parse(readFileSync(propsPath, "utf8")) as {
      palette?: { ink?: string };
      track: {
        artists: string[];
        discoveredAt: string;
        label?: string;
        logId?: string;
        releaseDate?: string;
        title: string;
      };
    };

    // A clean late frame — past the type, into the pure-art drop window.
    const at = durationSec(footage) * 0.72;
    const background = frameDataUrl(footage, at);

    const inputProps = {
      background,
      ink: props.palette?.ink,
      track: {
        artists: props.track.artists,
        discoveredAt: props.track.discoveredAt,
        label: props.track.label,
        logId: props.track.logId,
        releaseDate: props.track.releaseDate,
        title: props.track.title,
      },
    };

    const composition = await selectComposition({
      chromiumOptions: { gl: "angle" },
      id: "Cover",
      inputProps,
      serveUrl,
    });

    const output = path.join(bundleDir, "cover.jpg");
    await renderStill({
      chromiumOptions: { gl: "angle" },
      composition,
      frame: 0,
      imageFormat: "jpeg",
      inputProps,
      jpegQuality: 92,
      output,
      serveUrl,
    });

    console.error(`[cover] ${props.track.artists.join(", ")} — ${props.track.title} -> ${output}`);
  }
}

// CLI entry: render covers for the given bundle dirs.
if (import.meta.main) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: bun src/pipeline/render-cover.ts <bundleDir...>");
    process.exit(1);
  }
  renderCover(dirs).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
