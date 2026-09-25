import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

const OUTPUT = path.resolve(import.meta.dirname, "../../../../apps/web/public/galaxy/og.png");

const COMPOSITION_ID = "GalaxyOg";

async function renderOg(): Promise<void> {
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  const composition = await selectComposition({
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
