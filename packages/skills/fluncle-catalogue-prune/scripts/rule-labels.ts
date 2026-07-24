#!/usr/bin/env bun
// Apply operator label rulings: enable the clearly-DnB, disable the clearly-not-DnB. Matches
// labels by exact NAME. Dry-run by default; --confirm writes. Writes a rollback of prior states.
//
//   bun run rule-labels.ts --enable "Kos.Mos.Music|Syncopix Records" --disable "Paradoxx Music|Carbon Music"
//   bun run rule-labels.ts --disable "Paradoxx Music" --confirm
//
// Only pass labels you are SURE about — a wrong disable makes an artist's tracks purge-eligible,
// a wrong enable pulls its releases into the catalogue on the next crawl. Leave anything you can't
// identify UNDECIDED (it stays in the /admin/labels review queue). Disabling is reversible; the
// rollback file restores the prior seed_state.
import { writeFileSync } from "node:fs";
import { getDb } from "./lib";

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
const labels = (await db.execute(`select id, name, seed_state from labels`)).rows as unknown as {
  id: string;
  name: string;
  seed_state: string;
}[];
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
