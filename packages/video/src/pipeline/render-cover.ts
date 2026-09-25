import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { glRenderer } from "./gl";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

function durationSec(file: string): number {
  const out = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  const d = Number.parseFloat((out.stdout ?? "").trim());
  return Number.isFinite(d) && d > 0 ? d : 20;
}

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
      chromiumOptions: { gl: glRenderer() },
      id: "Cover",
      inputProps,
      serveUrl,
    });

    const output = path.join(bundleDir, "cover.jpg");
    await renderStill({
      chromiumOptions: { gl: glRenderer() },
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
