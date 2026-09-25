#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { getDb, rowString } from "./lib";

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const OUT = process.env.PRUNE_OUT_DIR ?? ".";
function listArg(flag: string): string[] {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1]
    ? args[i + 1]
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}
const enableNames = new Set(listArg("--enable"));
const disableNames = new Set(listArg("--disable"));
if (!enableNames.size && !disableNames.size) {
  console.log("Nothing to do. Pass --enable and/or --disable with pipe-separated names.");
  process.exit(0);
}

const db = await getDb();
const labels = (await db.execute(`select id, name, seed_state from labels`)).rows.map((row) => ({
  id: rowString(row, "id"),
  name: rowString(row, "name"),
  seed_state: rowString(row, "seed_state"),
}));
const enable = labels.filter((l) => enableNames.has(l.name));
const disable = labels.filter((l) => disableNames.has(l.name));

const missing = [...enableNames, ...disableNames].filter((n) => !labels.some((l) => l.name === n));
if (missing.length) {
  console.log(`⚠ no label row for: ${missing.join(", ")}`);
}

console.log(`\n===== LABEL RULINGS (${CONFIRM ? "WRITE" : "DRY RUN"}) =====`);
console.log(
  `ENABLE (${enable.length}): ${enable.map((l) => `${l.name}[${l.seed_state}]`).join(", ")}`,
);
console.log(
  `DISABLE (${disable.length}): ${disable.map((l) => `${l.name}[${l.seed_state}]`).join(", ")}`,
);
if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing written. Re-run with --confirm.`);
  process.exit(0);
}

const nowIso = new Date().toISOString();
writeFileSync(
  `${OUT}/label-rulings-rollback.json`,
  JSON.stringify(
    {
      at: nowIso,
      prior: [...enable, ...disable].map((l) => ({
        id: l.id,
        name: l.name,
        seed_state: l.seed_state,
      })),
    },
    null,
    2,
  ),
);
for (const l of enable) {
  await db.execute({
    args: ["enabled", nowIso, l.id],
    sql: `update labels set seed_state=?, updated_at=? where id=?`,
  });
}
for (const l of disable) {
  await db.execute({
    args: ["disabled", nowIso, l.id],
    sql: `update labels set seed_state=?, updated_at=? where id=?`,
  });
}
console.log(
  `\nDONE — enabled ${enable.length}, disabled ${disable.length}. Rollback: ${OUT}/label-rulings-rollback.json`,
);
