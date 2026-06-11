// Render the /galaxy Open Graph card as a still and write it into the web app's
// public assets.
//
//   bun src/render/render-og.ts            (or: bun run render:og)
//
// The OG card is NOT built at deploy time — it is a checked-in static asset.
// Run this script whenever the design changes, then commit the regenerated
// apps/web/public/galaxy/og.png. The composition lives in
// src/remotion/galaxy-og.tsx; this script bundles the registry, selects the
// GalaxyOg still, and renders it as a 1200×630 PNG.

import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

// apps/web/public/galaxy/og.png, resolved relative to this file so the script
// works from any cwd.
const OUTPUT = path.resolve(import.meta.dirname, "../../../../apps/web/public/galaxy/og.png");

const COMPOSITION_ID = "GalaxyOg";

async function renderOg(): Promise<void> {
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  const composition = await selectComposition({
    // Match packages/video: ANGLE (Metal on Apple Silicon) gives a real
    // hardware GL context headlessly, matching remotion.config.ts.
    chromiumOptions: { gl: "angle" },
    id: COMPOSITION_ID,
    serveUrl,
  });

  await renderStill({
    chromiumOptions: { gl: "angle" },
    composition,
    frame: 0,
    imageFormat: "png",
    output: OUTPUT,
    serveUrl,
  });

  console.error(`[og] rendered ${composition.width}×${composition.height} -> ${OUTPUT}`);
}

renderOg().catch((err) => {
  console.error(err);
  process.exit(1);
});
