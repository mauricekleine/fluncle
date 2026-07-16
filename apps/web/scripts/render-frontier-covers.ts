#!/usr/bin/env bun
/**
 * The Frontier cover leg (E2, the public recommendation machine) — an OPERATOR-RUN,
 * idempotent pass that renders + uploads the custom cover for every Frontier playlist
 * that does not have one yet.
 *
 * ── WHY THIS IS A NODE-SIDE SCRIPT, NOT PART OF THE MINT ─────────────────────
 * The cover is a per-user Remotion render (the Nostalgic Cosmos base + the crew №
 * stamped in a corner). Remotion needs a real headless Chromium and does NOT run in a
 * Cloudflare Worker, so the render CANNOT happen where the playlist is minted. The
 * honest split (frontier-playlist.ts documents the other half):
 *   - `mintOrRefreshFrontierPlaylist` (Worker) creates the playlist and leaves the
 *     row's `cover_uploaded_at` NULL;
 *   - THIS script (Node) reads the "cover_uploaded_at IS NULL" worklist, shells out to
 *     `@fluncle/media`'s `render:frontier-cover` to make the JPEG, and calls
 *     `putFrontierCover` (Worker-importable — a plain Spotify PUT) to upload it and
 *     stamp `cover_uploaded_at`.
 *
 * ── INERT BY DESIGN UNTIL THE SCOPE EXISTS ──────────────────────────────────
 * The upload needs the `ugc-image-upload` Spotify scope. Until the operator re-auths
 * with it, every PUT 403s the missing scope, `putFrontierCover` returns
 * `{ uploaded: false, reason: "missing_scope" }`, and nothing is stamped — so the row
 * stays on the worklist and the next run retries for free. Running this today is safe:
 * it renders (cheap) and degrades cleanly on every upload.
 *
 * ── RUN IT ──────────────────────────────────────────────────────────────────
 *   bun run --cwd apps/web scripts/render-frontier-covers.ts [--limit <n>] [--dry-run]
 *
 * Reads `TURSO_*` + `SPOTIFY_*` from the environment (locally from apps/web/.dev.vars,
 * auto-loaded), exactly like the other operator scripts. `--dry-run` renders but skips
 * the upload (proves the render leg without touching Spotify). It is operator/box-run,
 * NOT a repo deploy step.
 */
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

/** Render one cover to a temp JPEG via the media package's render CLI. Throws on failure. */
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
