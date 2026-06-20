// Fluncle Lens build: bundle the TypeScript entry points into plain MV3 assets and
// copy the static files (manifest, HTML, CSS, icons) into dist/. Zero runtime deps,
// matching the CLI's `bun build` approach. `--watch` rebuilds on change for dev.

import { watch } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dirname);
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

// Each entry becomes a top-level bundle Chrome loads by the filename the manifest
// (content.js), popup.html, options.html, and the service worker reference.
const ENTRIES = [
  join(SRC, "content.ts"),
  join(SRC, "popup.ts"),
  join(SRC, "options.ts"),
  join(SRC, "background.ts"),
];

// Static assets copied verbatim into dist/. Icons are copied as a directory.
const STATIC_FILES = [
  "manifest.json",
  "src/popup.html",
  "src/options.html",
  "src/content.css",
  "src/ui.css",
];

async function bundle(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ENTRIES,
    minify: false,
    outdir: DIST,
    sourcemap: "none",
    target: "browser",
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }

    throw new Error("Bun.build failed");
  }
}

async function copyStatic(): Promise<void> {
  for (const file of STATIC_FILES) {
    const base = file.split("/").pop() as string;

    await cp(join(ROOT, file), join(DIST, base));
  }

  await cp(join(ROOT, "icons"), join(DIST, "icons"), { recursive: true });
  // The bundled Oxanium woff2 (the brand display face), referenced by ui.css.
  await cp(join(ROOT, "src/fonts"), join(DIST, "fonts"), { recursive: true });
}

async function build(): Promise<void> {
  await rm(DIST, { force: true, recursive: true });
  await mkdir(DIST, { recursive: true });
  await bundle();
  await copyStatic();

  const produced = await readdir(DIST);

  console.log(`Fluncle Lens built → dist/ (${produced.length} files)`);
}

await build();

if (process.argv.includes("--watch")) {
  console.log("Watching src/ for changes…");

  let pending: ReturnType<typeof setTimeout> | undefined;

  watch(SRC, { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      build().catch((error: unknown) => console.error(error));
    }, 150);
  });
}
