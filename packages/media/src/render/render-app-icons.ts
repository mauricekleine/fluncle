import fs from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { APP_ICON_SPECS } from "../remotion/app-icon-specs";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
const OUT_DIR = path.resolve(import.meta.dirname, "../../out/app-icon");

async function renderAppIcons(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  for (const spec of APP_ICON_SPECS) {
    const composition = await selectComposition({
      chromiumOptions: { gl: "angle" },
      id: spec.id,
      serveUrl,
    });

    const output = path.join(OUT_DIR, `icon-${spec.slug}.png`);

    await renderStill({
      chromiumOptions: { gl: "angle" },
      composition,
      frame: 0,
      imageFormat: "png",
      output,
      serveUrl,
    });

    console.error(`[app-icon] ${composition.width}×${composition.height} -> ${output}`);
    console.error(`           ${spec.rationale}`);
  }
}

renderAppIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
