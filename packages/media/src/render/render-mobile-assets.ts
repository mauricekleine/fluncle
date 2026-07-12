// Render the mobile app's committed brand assets: the app icon (the operator's
// pick — the traveler on plain Deep Field), the Android adaptive-icon
// foreground, and the splash mark.
//
//   bun src/render/render-mobile-assets.ts     (or: bun run render:mobile-assets)
//
// These are NOT built at deploy time — like the /galaxy OG card they are
// checked-in static assets, referenced by apps/mobile/app.config.ts. Run this
// script whenever the icon design changes, then commit the regenerated files
// under apps/mobile/assets/. NOTE: icon + splash are NATIVE assets — a change
// needs a native rebuild (`expo run:ios` / a new EAS build), not a JS reload.
//
// Mirrors render-og.ts: bundle the registry once, then select + renderStill
// each asset through ANGLE (hardware GL) so @remotion/fonts' loadFont settles.

import fs from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { MOBILE_ASSET_SPECS } from "../remotion/app-icon-specs";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

// apps/mobile/assets/, resolved relative to this file so the script works from
// any cwd.
const OUT_DIR = path.resolve(import.meta.dirname, "../../../../apps/mobile/assets");

async function renderMobileAssets(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  for (const spec of MOBILE_ASSET_SPECS) {
    const composition = await selectComposition({
      // Match packages/video / render-og: ANGLE (Metal on Apple Silicon) gives a
      // real hardware GL context headlessly, matching remotion.config.ts.
      chromiumOptions: { gl: "angle" },
      id: spec.id,
      serveUrl,
    });

    const output = path.join(OUT_DIR, spec.file);

    await renderStill({
      chromiumOptions: { gl: "angle" },
      composition,
      frame: 0,
      imageFormat: "png",
      output,
      serveUrl,
    });

    console.error(`[mobile-assets] ${composition.width}×${composition.height} -> ${output}`);
    console.error(`                ${spec.rationale}`);
  }
}

renderMobileAssets().catch((err) => {
  console.error(err);
  process.exit(1);
});
