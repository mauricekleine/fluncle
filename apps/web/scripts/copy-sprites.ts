// Mirror @fluncle/sprites' canonical assets into this app's public/ so the Galaxy
// game's image loaders serve them at the same stable paths they always had (a
// dropped-in PNG still hot-swaps). The package owns the files; this
// regenerates the served copies. Runs on every `dev` boot and before `build`.
//
// The mirrored dirs are gitignored (generated) — packages/sprites/assets is the
// single source of truth.
//
// DRIVEN BY THE MANIFEST, NOT BY readdir. The fluncle-sprites skill's add-a-sprite
// runbook ends at "wire it in packages/sprites/src/index.ts: add the id to
// SPRITES.<collection> so the manifest stays true" — and while this script copied
// whatever it found on disk, that step was decorative: a sprite worked perfectly
// having never been declared, so the manifest silently rotted and `spriteUrl` /
// `SPRITES` stopped describing the set. Copying THROUGH `SPRITES` makes the wiring
// step load-bearing, and turns the two ways the manifest and the assets can disagree
// into signals:
//   - a declared id with NO PNG is a hard failure (the manifest promises a sprite the
//     app will 404 on), and
//   - a PNG nobody declared is a warning naming it (a stray render, or a wiring step
//     that was skipped) — a warning rather than a failure so a leftover scratch PNG
//     cannot block a dev boot.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SPRITES } from "@fluncle/sprites";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const src = join(repoRoot, "packages", "sprites", "assets");
const publicDir = join(import.meta.dir, "..", "public");

const missing: string[] = [];
const undeclared: string[] = [];
let count = 0;

for (const [collection, ids] of Object.entries(SPRITES)) {
  const from = join(src, collection);
  const to = join(publicDir, collection);

  mkdirSync(to, { recursive: true });

  for (const id of ids) {
    const file = `${id}.png`;

    if (!existsSync(join(from, file))) {
      missing.push(`${collection}/${file}`);
      continue;
    }

    cpSync(join(from, file), join(to, file));
    count += 1;
  }

  // The other direction: a PNG in the collection that the manifest never named.
  const declared = new Set(ids.map((id) => `${id}.png`));

  for (const file of existsSync(from) ? readdirSync(from) : []) {
    if (file.endsWith(".png") && !declared.has(file)) {
      undeclared.push(`${collection}/${file}`);
    }
  }
}

if (undeclared.length > 0) {
  console.warn(
    `[copy-sprites] NOT copied — no entry in SPRITES (packages/sprites/src/index.ts): ${undeclared.join(", ")}`,
  );
}

if (missing.length > 0) {
  throw new Error(
    `[copy-sprites] SPRITES declares ${missing.length} sprite(s) with no PNG under packages/sprites/assets: ${missing.join(", ")}. Render them, or drop the entries from the manifest.`,
  );
}

console.log(`[copy-sprites] synced ${count} sprite(s): @fluncle/sprites/assets -> public/`);
