import fs from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { MOBILE_ASSET_SPECS } from "../remotion/app-icon-specs";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

const OUT_DIR = path.resolve(import.meta.dirname, "../../../../apps/mobile/assets");

async function renderMobileAssets(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  for (const spec of MOBILE_ASSET_SPECS) {
    const composition = await selectComposition({
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
