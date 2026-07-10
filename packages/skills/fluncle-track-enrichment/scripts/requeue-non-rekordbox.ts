#!/usr/bin/env bun
// requeue-non-rekordbox — ONE-TIME repair (prune this file once the archive re-keys).
//
// The 2026-07-10 archive-wide re-derive drained BEFORE the box baked the rebuilt key
// estimator, so every finding whose key the DJ has not graded (`keySource` not
// "rekordbox"/"operator") still carries an OLD-estimator key or an old honest null.
// This flips exactly those findings back to `enrichment_status = pending`; the on-box
// enrich sweep then re-derives them from captured full audio with the current
// estimator. DJ-graded rows are excluded here and server-guarded anyway (the source
// hierarchy: operator > rekordbox > DSP).
//
// Dry-run by default (prints the target table, writes nothing). `--apply` flips.
// Needs an operator-authenticated `fluncle` CLI; runs on any machine (pure HTTP).
//
//   bun requeue-non-rekordbox.ts            # dry-run
//   bun requeue-non-rekordbox.ts --apply    # flip them

import { spawnSync } from "node:child_process";

const PROTECTED = new Set(["operator", "rekordbox"]);
const apply = process.argv.includes("--apply");

function fluncleJson<T>(args: string[]): T {
  const r = spawnSync("fluncle", args, { encoding: "utf8", timeout: 60_000 });
  const stdout = r.stdout ?? "";
  const start = stdout.indexOf("{");

  if (r.status !== 0 || start < 0) {
    throw new Error(`fluncle ${args.join(" ")} failed: ${(r.stderr || stdout).slice(0, 200)}`);
  }

  return JSON.parse(stdout.slice(start)) as T;
}

type Row = {
  bpm?: number;
  key?: string;
  keySource?: string;
  logId?: string;
  title?: string;
  trackId?: string;
};

const { tracks } = fluncleJson<{ tracks: Row[] }>([
  "admin",
  "tracks",
  "list",
  "--limit",
  "100",
  "--json",
]);
// An old CLI (< 0.119.0) silently drops `keySource` from the JSON, which would make
// EVERY row look ungraded and target the whole archive. Refuse to guess: the field
// must be present on at least one row (35 rows carry "rekordbox" as of 2026-07-10).
if (!tracks.some((t) => t.keySource !== undefined)) {
  console.error(
    "keySource is absent from every row — the installed fluncle CLI predates 0.119.0. `brew upgrade fluncle` first.",
  );
  process.exit(1);
}

const targets = tracks.filter((t) => t.trackId && !PROTECTED.has(t.keySource ?? ""));

console.log(`${targets.length} finding(s) without a DJ-graded key (of ${tracks.length}):`);

for (const t of targets) {
  console.log(
    `  ${t.logId ?? "?"}  ${t.trackId}  ${t.title ?? "?"} — ${t.key ?? "no key"} (${t.keySource ?? "no source"}), ${t.bpm ?? "no"} bpm`,
  );
}

if (!apply) {
  console.log(
    `\nDry-run — nothing flipped. Re-run with --apply to re-queue all ${targets.length}.`,
  );
  process.exit(0);
}

let ok = 0;
const failed: string[] = [];

for (const t of targets) {
  try {
    const res = fluncleJson<{ ok?: boolean }>([
      "admin",
      "tracks",
      "update",
      t.trackId ?? "",
      "--status",
      "pending",
      "--json",
    ]);
    if (res.ok) {
      ok++;
    } else {
      failed.push(t.logId ?? t.trackId ?? "?");
    }
  } catch (error) {
    failed.push(
      `${t.logId ?? t.trackId ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

console.log(`\nApplied — re-queued ${ok}/${targets.length}.`);

if (failed.length > 0) {
  console.log(`Failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
