import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SURFACES } from "./index";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const doctrinePath = join(repoRoot, "docs", "surfaces-doctrine.md");
const doctrine = readFileSync(doctrinePath, "utf8");

const missing = SURFACES.filter(
  (surface) => surface.pending !== true && !doctrine.includes(`\`${surface.name}\``),
).map((surface) => surface.name);

assert.deepEqual(
  missing,
  [],
  `docs/surfaces-doctrine.md is missing rows for: ${missing.join(", ")} — add each to the §2 kind table and the §3 matrix`,
);
