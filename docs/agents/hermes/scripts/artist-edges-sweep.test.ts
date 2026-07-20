// Unit tests for artist-edges-sweep.ts — the `--no-agent` track_artists graph-backfill cron's
// orchestrator (RFC artist-primary-capture, slice 0).
//
// The sweep is a PURE trigger (zero LLM tokens): it drives ONE bounded `fluncle admin backfills
// artist-edges` pass and reports it. So the contract worth pinning is exactly the recording-mbids
// sweep's — parse-first, so a partial pass (some tracks failed, exit 1) is RECORDED with its real
// counts rather than discarded as a crash — plus the summary the cron output (and the /status
// marker) is read from.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/artist-edges-sweep.test.ts
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
  drained) printf '{"ok":true,"dryRun":false,"scanned":0,"edgesWritten":0,"fullyMatched":[],"fullyMatchedCount":0,"partiallyMatched":[],"partiallyMatchedCount":0,"zeroMatched":[],"zeroMatchedCount":0,"unmatchedNames":0}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"dryRun":false,"scanned":5,"edgesWritten":6,"fullyMatched":["a","b"],"fullyMatchedCount":2,"partiallyMatched":["c"],"partiallyMatchedCount":1,"zeroMatched":["d","e"],"zeroMatchedCount":2,"unmatchedNames":3}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./artist-edges-sweep").fluncleJson;

/** Point the stub at one of its canned responses. */
function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "artist-edges-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson } = await import("./artist-edges-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  edgesWritten?: number;
  fullyMatchedCount?: number;
  ok?: boolean;
  partiallyMatchedCount?: number;
  scanned?: number;
  unmatchedNames?: number;
  zeroMatchedCount?: number;
};

describe("artist-edges-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "backfills", "artist-edges", "--limit", "200"]);

    expect(pass.ok).toBe(true);
    expect(pass.scanned).toBe(5);
    expect(pass.edgesWritten).toBe(6);
    expect(pass.fullyMatchedCount).toBe(2);
    expect(pass.partiallyMatchedCount).toBe(1);
    expect(pass.zeroMatchedCount).toBe(2);
    expect(pass.unmatchedNames).toBe(3);
  });

  test("RECORDS a drained tick (nothing left to backfill) as a clean no-op", () => {
    mode("drained");
    const pass = fluncleJson<Pass>(["admin", "backfills", "artist-edges"]);

    expect(pass.ok).toBe(true);
    expect(pass.scanned).toBe(0);
    expect(pass.edgesWritten).toBe(0);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "artist-edges"])).toThrow(
      /missing_token/,
    );
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "artist-edges"])).toThrow(/exited 1/);
  });
});
