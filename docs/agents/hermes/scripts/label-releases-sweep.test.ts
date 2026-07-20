// Unit tests for label-releases-sweep.ts — the `--no-agent` freshness tap cron's orchestrator
// (D8). A PURE trigger (zero LLM tokens): it drives ONE bounded `fluncle admin backfills
// label-releases` probe and reports the merged counts. The contract worth pinning is exactly the
// cover-masters-sweep's — parse-first, so a partial pass is RECORDED with its real counts rather
// than discarded as a crash, and the CLI's own error payload throws.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/label-releases-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is side-effect
// free (no fluncle spawn, no network). The fluncle CLI itself is stubbed with a tiny executable
// selected via FLUNCLE_BIN (read at module load, hence the dynamic import in beforeAll).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = `#!/bin/bash
case "$(cat "$(dirname "$0")/mode")" in
  unconfigured) printf '{"ok":true,"configured":false,"dryRun":false,"labelsProbed":0,"newRows":0,"skippedKnown":0,"labelSlugs":[],"failedLabels":[],"albumsSeen":0,"albumsMatched":0,"rateLimited":false,"failedCount":0}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"configured":true,"dryRun":false,"labelsProbed":3,"newRows":7,"skippedKnown":12,"skippedUngrounded":5,"labelSlugs":["medschool","hospital","ram"],"failedLabels":["tiny-imprint"],"failedFetches":2,"fetchCeilingHit":false,"albumsSeen":9,"albumsMatched":4,"rateLimited":false,"failedCount":0}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./label-releases-sweep").fluncleJson;

function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "label-releases-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson } = await import("./label-releases-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  albumsMatched?: number;
  skippedUngrounded?: number;
  configured?: boolean;
  failedFetches?: number;
  failedLabels?: string[];
  labelSlugs?: string[];
  labelsProbed?: number;
  newRows?: number;
  ok?: boolean;
  skippedKnown?: number;
};

describe("label-releases-sweep's fluncleJson", () => {
  test("returns a clean probe summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-releases", "--limit", "5"]);

    expect(pass.ok).toBe(true);
    expect(pass.labelsProbed).toBe(3);
    expect(pass.newRows).toBe(7);
    expect(pass.skippedKnown).toBe(12);
    expect(pass.albumsMatched).toBe(4);
    expect(pass.skippedUngrounded).toBe(5);
    expect(pass.failedFetches).toBe(2);
    expect(pass.labelSlugs).toEqual(["medschool", "hospital", "ram"]);
    expect(pass.failedLabels).toEqual(["tiny-imprint"]);
  });

  test("carries the no-op through as a clean success (a gone Spotify grant)", () => {
    mode("unconfigured");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-releases", "--limit", "5"]);

    expect(pass.ok).toBe(true);
    expect(pass.configured).toBe(false);
    expect(pass.newRows).toBe(0);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() =>
      fluncleJson<Pass>(["admin", "backfills", "label-releases", "--limit", "5"]),
    ).toThrow(/missing_token/);
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() =>
      fluncleJson<Pass>(["admin", "backfills", "label-releases", "--limit", "5"]),
    ).toThrow(/exited 1/);
  });
});
