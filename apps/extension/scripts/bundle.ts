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
