// The registry ↔ doctrine-doc parity gate — no framework (bun test executes the
// top-level asserts; "0 tests" is the repo pattern). Run: `bun src/doctrine-parity.test.ts`.
//
// docs/surfaces-doctrine.md's §2 kind tables and §3 per-context matrix are HAND-maintained
// against this catalog — nothing generates them — so they drift silently, and they did:
// eleven live surfaces (a web route and ten crons) were registered here and absent from the
// doc before this test existed. This is the build-fail net that stops a twelfth: every
// non-`pending` surface's `name` must appear verbatim in the doc. A `pending` surface is
// deliberately dark everywhere and stays out of the tables until its go-live flip (§3.5).
//
// The check is name-presence only, on purpose: it catches the failure that actually happens
// (a surface with no row at all) without freezing the doc's prose or column wording.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SURFACES } from "./index";

// This file lives at packages/registry/src/, so the repo root is two directories up.
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
