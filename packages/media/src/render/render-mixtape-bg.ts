import { mkdir } from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { MIXTAPE_COVER_SPECS } from "../remotion/mixtape-cover-specs";

const SEED = "fluncle-mixtape-bg";

const OUTPUT_FOR_ID: Record<string, string> = {
  MixtapeCoverOg: "bg-og.jpg",
  MixtapeCoverSquare: "bg-square.jpg",
  MixtapeCoverWide: "bg-wide.jpg",
};

const ENTRY_POINT = path.resolve(import.meta.dirname, "../remotion/index.ts");
const OUT_DIR = path.resolve(import.meta.dirname, "../../out/mixtape-bg");

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
      imageFormat: "jpeg",
      inputProps,
      jpegQuality: 88,
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
