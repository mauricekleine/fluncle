// Fluncle Lens packaging: produce the ready-to-upload Chrome Web Store .zip.
//
// The store builds the listing from exactly what's in the uploaded zip — so the
// zip must carry the built `dist/` AND the full icon set the manifest references
// (16/32/48/128). An earlier upload missed the icons because they weren't in the
// zip, which is why the store couldn't pick the icon. This runs the build, then
// zips the contents of dist/ at the archive root (manifest.json at the top level,
// not nested under a folder — the store requires that), writing it to
// `web-store/fluncle-lens-<version>.zip`.

import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dirname);
const DIST = join(ROOT, "dist");
const OUT_DIR = join(ROOT, "web-store");

async function readVersion(): Promise<string> {
  const manifest = (await Bun.file(join(ROOT, "manifest.json")).json()) as { version: string };

  return manifest.version;
}

async function main(): Promise<void> {
  // Always build fresh so the zip matches source (icons + fonts + bundles included).
  const built = spawnSync("bun", ["run", join(ROOT, "scripts", "build.ts")], {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (built.status !== 0) {
    throw new Error("build failed");
  }

  const version = await readVersion();
  const zipPath = join(OUT_DIR, `fluncle-lens-${version}.zip`);

  await mkdir(OUT_DIR, { recursive: true });
  await rm(zipPath, { force: true });

  // Zip the *contents* of dist/ (so manifest.json sits at the archive root). `-r`
  // recurses; `-X` drops extra macOS attributes; running with cwd = dist keeps the
  // paths relative. Exclude the macOS .DS_Store noise.
  const zipped = spawnSync(
    "zip",
    ["-r", "-X", zipPath, ".", "-x", ".DS_Store", "-x", "**/.DS_Store"],
    {
      cwd: DIST,
      stdio: "inherit",
    },
  );

  if (zipped.status !== 0) {
    throw new Error("zip failed (is the `zip` CLI available?)");
  }

  const size = Bun.file(zipPath).size;

  console.log(
    `\nFluncle Lens packaged → web-store/fluncle-lens-${version}.zip (${(size / 1024).toFixed(0)} KB)`,
  );
  console.log("Upload that zip at chrome.google.com/webstore/devconsole.");
}

await main();
