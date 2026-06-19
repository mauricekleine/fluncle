// Bake the SHARED mixtape cover background (the cosmonaut on the Deep Field, sans
// markers) at the three sizes a mixtape ships at, into apps/web/public. Run once,
// or again whenever the cover art changes:
//
//   bun run render:mixtape-bg
//
// The per-mixtape "MIXTAPE #N" + coordinate text is no longer baked here — it's
// stamped over these backgrounds on the fly by the cover endpoint
// (apps/web/src/routes/api/mixtape-cover.$logId.ts, Satori/workers-og), so
// publishing needs no render step. Remotion stays only as this one-time bg tool.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { MIXTAPE_COVER_SPECS } from "../remotion/mixtape-cover-specs";

// A fixed starfield seed — the background is shared across every mixtape, so the
// field is identical (the uniqueness lives in the stamped text).
const SEED = "fluncle-mixtape-bg";

// Composition id -> the static asset the cover endpoint fetches for that size.
const OUTPUT_FOR_ID: Record<string, string> = {
  MixtapeCoverOg: "mixtape-bg-og.png",
  MixtapeCoverSquare: "mixtape-bg-square.png",
  MixtapeCoverWide: "mixtape-bg-wide.png",
};

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
const OUT_DIR = path.resolve(import.meta.dirname, "../../../../apps/web/public");

async function renderMixtapeBackgrounds(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });
  const inputProps = { coordinate: SEED, markers: false, number: "" };

  for (const spec of MIXTAPE_COVER_SPECS) {
    const file = OUTPUT_FOR_ID[spec.id];

    if (!file) {
      continue;
    }

    const composition = await selectComposition({
      chromiumOptions: { gl: "angle" },
      id: spec.id,
      inputProps,
      serveUrl,
    });

    const output = path.join(OUT_DIR, file);

    await renderStill({
      chromiumOptions: { gl: "angle" },
      composition,
      frame: 0,
      imageFormat: "png",
      inputProps,
      output,
      serveUrl,
    });

    console.error(
      `[mixtape-bg] ${spec.id} ${composition.width}×${composition.height} -> ${output}`,
    );
  }
}

renderMixtapeBackgrounds().catch((err) => {
  console.error(err);
  process.exit(1);
});
