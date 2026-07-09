// Mirror @fluncle/sprites' canonical assets into this app's public/ so the Galaxy
// game's image loaders serve them at the same stable paths they always had (a
// dropped-in PNG still hot-swaps). The package owns the files; this
// regenerates the served copies. Runs on every `dev` boot and before `build`.
//
// The mirrored dirs are gitignored (generated) — packages/sprites/assets is the
// single source of truth.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const src = join(repoRoot, "packages", "sprites", "assets");
const publicDir = join(import.meta.dir, "..", "public");

let count = 0;
for (const collection of readdirSync(src)) {
  const from = join(src, collection);
  const to = join(publicDir, collection);
  mkdirSync(to, { recursive: true });
  for (const file of readdirSync(from)) {
    cpSync(join(from, file), join(to, file));
    count += 1;
  }
}
console.log(`[copy-sprites] synced ${count} sprite(s): @fluncle/sprites/assets -> public/`);
