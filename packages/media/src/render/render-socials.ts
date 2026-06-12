// Render the social profile banners / covers as stills and write them into
// docs/socials/banners/ — ready to drop into each platform's profile uploader.
//
//   bun src/render/render-socials.ts        (or: bun run render:socials)
//
// These are checked-in static assets, NOT built at deploy time. Run this script
// whenever the banner design changes, then commit the regenerated files. The
// composition is src/remotion/cosmos-banner.tsx; the per-platform dimensions,
// formats, and safe areas live in src/remotion/socials-specs.ts. Only specs with
// `render: true` (a claimed account) are written; the rest are previewable in
// `bun run studio` but not output until the account exists.

import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { SOCIAL_SPECS } from "../remotion/socials-specs";

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");

// docs/socials/banners/, resolved relative to this file so the script works from
// any cwd.
const OUT_DIR = path.resolve(import.meta.dirname, "../../../../docs/socials/banners");

async function renderSocials(): Promise<void> {
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });

  const targets = SOCIAL_SPECS.filter((spec) => spec.render);

  for (const spec of targets) {
    const composition = await selectComposition({
      // Match packages/video: ANGLE (Metal on Apple Silicon) gives a real
      // hardware GL context headlessly, matching remotion.config.ts.
      chromiumOptions: { gl: "angle" },
      id: spec.id,
      serveUrl,
    });

    const output = path.join(OUT_DIR, spec.file);

    await renderStill({
      chromiumOptions: { gl: "angle" },
      composition,
      frame: 0,
      imageFormat: spec.format,
      jpegQuality: spec.format === "jpeg" ? 92 : undefined,
      output,
      serveUrl,
    });

    console.error(`[socials] ${spec.id} ${composition.width}×${composition.height} -> ${output}`);
  }
}

renderSocials().catch((err) => {
  console.error(err);
  process.exit(1);
});
