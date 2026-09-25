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
