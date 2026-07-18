// Unit tests for label-lineage-sweep.ts — the `--no-agent` label-lineage fill cron's orchestrator
// (the label entity's lineage half).
//
// The sweep is a PURE trigger (zero LLM tokens): it drives ONE bounded `fluncle admin backfills
// label-lineage` pass and reports it. So the contract worth pinning is exactly the recording-mbids
// sweep's — parse-first, so a pass that stopped on the vendor circuit breaker is RECORDED with its
// real counts rather than discarded as a crash — plus the summary the cron output (and the /status
// marker) is read from.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/label-lineage-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is side-effect
// free (no fluncle spawn, no network). The fluncle CLI itself is stubbed with a tiny executable
// selected via FLUNCLE_BIN (read at module load, hence the dynamic import in beforeAll).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stub fluncle: a mode FILE beside it selects the response shape. (The sweep builds its own
// argv, so the mode cannot ride on an arg — and Bun's spawnSync snapshots the environment, so it
// cannot ride on an env var either.)
const STUB = `#!/bin/bash
case "$(cat "$(dirname "$0")/mode")" in
  throttled) printf '{"ok":true,"dryRun":false,"resolved":["hospital-records"],"resolvedCount":1,"none":[],"noneCount":0,"failed":[],"failedCount":0,"unmatchedParents":2,"rateLimited":true}\\n' ;;
  partial) printf '{"ok":true,"dryRun":false,"resolved":["med-school"],"resolvedCount":1,"none":["tiny-imprint"],"noneCount":1,"failed":[{"error":"boom","slug":"broke"}],"failedCount":1,"unmatchedParents":0,"rateLimited":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"dryRun":false,"resolved":["med-school","hospital-records"],"resolvedCount":2,"none":["tiny-imprint"],"noneCount":1,"failed":[],"failedCount":0,"unmatchedParents":1,"rateLimited":false}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./label-lineage-sweep").fluncleJson;

/** Point the stub at one of its canned responses. */
function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "label-lineage-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson } = await import("./label-lineage-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  rateLimited?: boolean;
  resolvedCount?: number;
  unmatchedParents?: number;
};

describe("label-lineage-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-lineage", "--limit", "25"]);

    expect(pass.ok).toBe(true);
    expect(pass.resolvedCount).toBe(2);
    expect(pass.noneCount).toBe(1);
    expect(pass.unmatchedParents).toBe(1);
    expect(pass.rateLimited).toBe(false);
  });

  test("RECORDS a pass that stopped on a vendor circuit breaker", () => {
    // The pass did real work (one label walked) and then MusicBrainz throttled us. That is a
    // throttled tick, not a crash: its counts must survive, and `rateLimited` must reach the cron
    // output so a "1 resolved" tick does not read as a drained worklist.
    mode("throttled");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-lineage"]);

    expect(pass.rateLimited).toBe(true);
    expect(pass.resolvedCount).toBe(1);
    expect(pass.unmatchedParents).toBe(2);
  });

  test("RECORDS a partial batch (per-row failure, exit 1) rather than discarding it", () => {
    // The CLI exits 1 when any row failed, but still prints its full summary. That partial summary
    // must be RECORDED (some resolved, some none, some failed), not thrown as a crash.
    mode("partial");
    const pass = fluncleJson<Pass>(["admin", "backfills", "label-lineage"]);

    expect(pass.resolvedCount).toBe(1);
    expect(pass.noneCount).toBe(1);
    expect(pass.failedCount).toBe(1);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "label-lineage"])).toThrow(
      /missing_token/,
    );
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "label-lineage"])).toThrow(/exited 1/);
  });
});
