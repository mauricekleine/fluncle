// Render a mixtape's cover art at the three sizes it needs, for a given mixtape
// number + Log ID coordinate.
//
//   bun src/render/render-mixtape-cover.ts --number 1 --coordinate 019.F.1A
//   (or: bun run render:mixtape-cover -- --number 1 --coordinate 019.F.1A)
//
// Writes cover-square.png (Mixcloud / SoundCloud + the /log coverImageUrl),
// thumb-youtube.png (1280×720), and og.png (1200×630) under
// packages/media/out/mixtapes/<coordinate>/. Upload the square to Mixcloud /
// SoundCloud and host it as the mixtape's coverImageUrl; the wide one is the
// YouTube thumbnail. The composition is src/remotion/mixtape-cover.tsx; the sizes
// live in src/remotion/mixtape-cover-specs.ts.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { MIXTAPE_COVER_SPECS } from "../remotion/mixtape-cover-specs";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;

  return value && !value.startsWith("--") ? value : fallback;
}

const number = arg("number", "1");
const coordinate = arg("coordinate", "019.F.1A");

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
const OUT_DIR = path.resolve(import.meta.dirname, `../../out/mixtapes/${coordinate}`);

async function renderMixtapeCover(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    webpackOverride: (config) => config,
  });
  const inputProps = { coordinate, number };

  for (const spec of MIXTAPE_COVER_SPECS) {
    const composition = await selectComposition({
      // ANGLE (Metal on Apple Silicon) gives a real headless GL context, matching
      // remotion.config.ts and the other render scripts.
      chromiumOptions: { gl: "angle" },
      id: spec.id,
      inputProps,
      serveUrl,
    });

    const output = path.join(OUT_DIR, spec.file);

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
      `[mixtape-cover] ${spec.id} ${composition.width}×${composition.height} -> ${output}`,
    );
  }
}

renderMixtapeCover().catch((err) => {
  console.error(err);
  process.exit(1);
});
