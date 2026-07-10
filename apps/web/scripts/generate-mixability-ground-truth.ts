#!/usr/bin/env bun
/**
 * Regenerate the committed mixability ground-truth extract — the 17 tracks of
 * Fluncle's mixtape `019.F.1A`, joined to each finding's live `key` / `bpm` /
 * spectral `features`, in set order. The pure floor-check test
 * (`src/lib/server/mixability-ground-truth.test.ts`) runs on this committed file so
 * it lives inside `deploy:gate` WITHOUT a database (the local DB is gitignored +
 * CI-invisible).
 *
 * The 17 coordinates + their set order come from the video fixture
 * (`packages/video/src/set-video/__fixtures__/019.F.1A.tracklist.json`); the per-
 * finding `key`/`bpm`/`features` are all PUBLIC on every track chip, so this reads
 * them straight off the public API — no DB, no secret, reproducible by anyone. Point
 * `--base` at a local dev server to regenerate against a work-in-progress archive.
 *
 * Usage:
 *   bun run scripts/generate-mixability-ground-truth.ts
 *   bun run scripts/generate-mixability-ground-truth.ts --base http://localhost:3000
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const TRACKLIST = resolve(
  import.meta.dirname,
  "../../../packages/video/src/set-video/__fixtures__/019.F.1A.tracklist.json",
);
const OUT = resolve(
  import.meta.dirname,
  "../src/lib/server/__fixtures__/mixability-ground-truth.json",
);

type ExtractRow = {
  bpm: number | null;
  features: Record<string, number> | null;
  i: number;
  key: string | null;
  logId: string;
};

function baseArg(): string {
  const index = process.argv.indexOf("--base");
  const value = index >= 0 ? process.argv[index + 1] : undefined;

  return (value ?? "https://www.fluncle.com").replace(/\/$/, "");
}

async function main(): Promise<void> {
  const base = baseArg();
  const fixture = JSON.parse(await readFile(TRACKLIST, "utf8")) as { i: number; logId: string }[];
  const ordered = [...fixture].sort((a, b) => a.i - b.i);

  const rows: ExtractRow[] = [];

  for (const { i, logId } of ordered) {
    const response = await fetch(`${base}/api/v1/tracks/${logId}`);

    if (!response.ok) {
      throw new Error(`GET /api/v1/tracks/${logId} → ${response.status}`);
    }

    const body = (await response.json()) as { track?: Record<string, unknown> };
    const track = body.track ?? {};

    rows.push({
      bpm: typeof track.bpm === "number" ? track.bpm : null,
      features: (track.features as Record<string, number> | undefined) ?? null,
      i,
      key: typeof track.key === "string" ? track.key : null,
      logId,
    });
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

  const keyed = rows.filter((row) => row.key).length;
  console.log(`Wrote ${rows.length} rows (${keyed} keyed) → ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
