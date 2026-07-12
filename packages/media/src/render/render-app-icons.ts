// Render the Fluncle mobile app-icon candidates as 1024² stills.
//
//   bun src/render/render-app-icons.ts        (or: bun run render:app-icons)
//
// A TASTE deliverable: this renders every <AppIcon> variant (app-icon-specs.ts)
// to out/app-icon/icon-<slug>.png so the operator can eyeball the candidates side
// by side and pick one. out/ is gitignored — these are throwaway working stills,
// NOT a committed asset. Once the operator picks, the chosen master gets wired
// into apps/mobile (icon + Android adaptive foreground + splash); see the PR body.
//
// Mirrors render-og.ts: bundle the registry once, then select + renderStill each
// candidate through ANGLE (hardware GL) so @remotion/fonts' loadFont settles.

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
      // Match packages/video / render-og: ANGLE (Metal on Apple Silicon) gives a
      // real hardware GL context headlessly, matching remotion.config.ts.
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
