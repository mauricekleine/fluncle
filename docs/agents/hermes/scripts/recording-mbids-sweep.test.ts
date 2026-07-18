// Unit tests for recording-mbids-sweep.ts — the `--no-agent` recording-MBID fill cron's
// orchestrator (the MusicBrainz identity layer).
//
// The sweep is a PURE trigger (zero LLM tokens): it drives ONE bounded `fluncle admin backfills
// recording-mbids` pass and reports it. So the contract worth pinning is exactly the label-images
// sweep's — parse-first, so a pass that stopped on the vendor circuit breaker is RECORDED with its
// real counts rather than discarded as a crash — plus the summary the cron output (and the /status
// marker) is read from.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/recording-mbids-sweep.test.ts
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
  throttled) printf '{"ok":true,"dryRun":false,"prefixStripped":3,"resolved":["4aBcD"],"resolvedCount":1,"missed":[],"missedCount":0,"failed":[],"failedCount":0,"rateLimited":true}\\n' ;;
  partial) printf '{"ok":true,"dryRun":false,"prefixStripped":0,"resolved":["4aBcD"],"resolvedCount":1,"missed":["7xYz"],"missedCount":1,"failed":[{"error":"boom","trackId":"1qWe"}],"failedCount":1,"rateLimited":false}\\n'; exit 1 ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"dryRun":false,"prefixStripped":5,"resolved":["4aBcD","9pQr"],"resolvedCount":2,"missed":["7xYz"],"missedCount":1,"failed":[],"failedCount":0,"rateLimited":false}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./recording-mbids-sweep").fluncleJson;

/** Point the stub at one of its canned responses. */
function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "recording-mbids-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson } = await import("./recording-mbids-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  failedCount?: number;
  missedCount?: number;
  ok?: boolean;
  prefixStripped?: number;
  rateLimited?: boolean;
  resolvedCount?: number;
};

describe("recording-mbids-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "backfills", "recording-mbids", "--limit", "25"]);

    expect(pass.ok).toBe(true);
    expect(pass.prefixStripped).toBe(5);
    expect(pass.resolvedCount).toBe(2);
    expect(pass.missedCount).toBe(1);
    expect(pass.rateLimited).toBe(false);
  });

  test("RECORDS a pass that stopped on a vendor circuit breaker", () => {
    // The pass did real work (one MBID resolved) and then MusicBrainz throttled us. That is a
    // throttled tick, not a crash: its counts must survive, and `rateLimited` must reach the cron
    // output so a "1 resolved" tick does not read as a drained worklist.
    mode("throttled");
    const pass = fluncleJson<Pass>(["admin", "backfills", "recording-mbids"]);

    expect(pass.rateLimited).toBe(true);
    expect(pass.resolvedCount).toBe(1);
    expect(pass.prefixStripped).toBe(3);
  });

  test("RECORDS a partial batch (per-row failure, exit 1) rather than discarding it", () => {
    // The CLI exits 1 when any row failed, but still prints its full summary. That partial summary
    // must be RECORDED (some resolved, some missed, some failed), not thrown as a crash.
    mode("partial");
    const pass = fluncleJson<Pass>(["admin", "backfills", "recording-mbids"]);

    expect(pass.resolvedCount).toBe(1);
    expect(pass.missedCount).toBe(1);
    expect(pass.failedCount).toBe(1);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "recording-mbids"])).toThrow(
      /missing_token/,
    );
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "recording-mbids"])).toThrow(/exited 1/);
  });
});
