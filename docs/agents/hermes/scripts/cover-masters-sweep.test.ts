// Unit tests for cover-masters-sweep.ts — the `--no-agent` owned-cover-master resolve cron's
// orchestrator (RFC musickit-second-authority U3b). A PURE trigger (zero LLM tokens): it drives ONE
// bounded `fluncle admin backfills cover-masters` pass PER KIND and reports the merged counts. So
// the contract worth pinning is exactly label-images-sweep's — parse-first, so a partial batch is
// RECORDED with its real counts rather than discarded as a crash.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/cover-masters-sweep.test.ts
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
  partial) printf '{"ok":true,"kind":"album","dryRun":false,"resolved":["some-album"],"resolvedCount":1,"none":["bare-album"],"noneCount":1,"failed":[{"error":"boom","slug":"flaky-album"}],"failedCount":1,"rateLimited":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"kind":"album","dryRun":false,"resolved":["some-album","other-album"],"resolvedCount":2,"none":["bare-album"],"noneCount":1,"failed":[],"failedCount":0,"rateLimited":false}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./cover-masters-sweep").fluncleJson;

function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cover-masters-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson } = await import("./cover-masters-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  resolvedCount?: number;
};

describe("cover-masters-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>([
      "admin",
      "backfills",
      "cover-masters",
      "--kind",
      "album",
      "--limit",
      "24",
    ]);

    expect(pass.ok).toBe(true);
    expect(pass.resolvedCount).toBe(2);
    expect(pass.noneCount).toBe(1);
  });

  test("RECORDS a partial batch (per-entity failure, exit 1) rather than discarding it", () => {
    mode("partial");
    const pass = fluncleJson<Pass>(["admin", "backfills", "cover-masters", "--kind", "artist"]);

    expect(pass.resolvedCount).toBe(1);
    expect(pass.noneCount).toBe(1);
    expect(pass.failedCount).toBe(1);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() =>
      fluncleJson<Pass>(["admin", "backfills", "cover-masters", "--kind", "album"]),
    ).toThrow(/missing_token/);
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() =>
      fluncleJson<Pass>(["admin", "backfills", "cover-masters", "--kind", "album"]),
    ).toThrow(/exited 1/);
  });
});
