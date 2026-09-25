import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

export function hashBundleInputs(dirs: string[]): string {
  const hash = createHash("sha256");

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    const files: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };
    walk(dir);
    files.sort();

    hash.update(`\0root:${dir}\0`);
    for (const file of files) {
      const stat = statSync(file);
      hash.update(path.relative(dir, file));
      hash.update(String(stat.mtimeMs));
      hash.update(String(stat.size));
    }
  }

  return hash.digest("hex").slice(0, 16);
}

export function bundleInputsHash(): string {
  return hashBundleInputs([SRC_DIR, PUBLIC_DIR]);
}
