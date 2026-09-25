#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listFrontierCoverTargets, putFrontierCover } from "../src/lib/server/frontier-playlist";

const MEDIA_DIR = path.resolve(import.meta.dirname, "../../../packages/media");

type Args = { dryRun: boolean; limit: number };

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let limit = 200;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--limit") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);

      if (Number.isFinite(value) && value > 0) {
        limit = value;
      }

      index += 1;
    }
  }

  return { dryRun, limit };
}

function renderCover(crewNumber: null | number, out: string): void {
  const result = spawnSync(
    "bun",
    [
      "run",
      "--cwd",
      MEDIA_DIR,
      "render:frontier-cover",
      "--",
      "--crew",
      String(crewNumber ?? 0),
      "--out",
      out,
    ],
    { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] },
  );

  if (result.status !== 0) {
    throw new Error(`render:frontier-cover exited ${result.status ?? "null"}`);
  }
}

async function main(): Promise<void> {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const targets = await listFrontierCoverTargets(limit);

  const summary = { failed: 0, missingScope: 0, rendered: 0, targets: targets.length, uploaded: 0 };

  for (const target of targets) {
    const out = path.join(tmpdir(), `frontier-cover-${target.userId}.jpg`);

    try {
      renderCover(target.crewNumber, out);
      summary.rendered += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`[frontier-covers] render failed for ${target.userId}:`, error);
      continue;
    }

    if (dryRun) {
      continue;
    }

    const jpegBase64 = (await readFile(out)).toString("base64");
    const result = await putFrontierCover(target.userId, target.playlistId, jpegBase64);

    if (result.uploaded) {
      summary.uploaded += 1;
    } else if (result.reason === "missing_scope") {
      summary.missingScope += 1;
    } else {
      summary.failed += 1;
      console.error(`[frontier-covers] upload failed for ${target.userId}: ${result.reason}`);
    }
  }

  console.log(JSON.stringify({ ok: true, ...summary }));

  if (summary.missingScope > 0) {
    console.error(
      `[frontier-covers] ${summary.missingScope} cover(s) rendered but NOT uploaded — the Spotify grant is missing the ugc-image-upload scope. Re-auth to enable the upload leg; the rows stay queued.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
