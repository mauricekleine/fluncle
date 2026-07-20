// Unit tests for artist-credits-sweep.ts — the `--no-agent` MB-credit-sweep cron's orchestrator
// (RFC artist-primary-capture, slice 1b).
//
// The sweep is a PURE trigger (zero LLM tokens): it drives ONE bounded `fluncle admin backfills
// artist-credits` pass and reports it. So the contract worth pinning is exactly the artist-edges
// sweep's — parse-first, so a partial pass (some tracks failed, exit 1) is RECORDED with its real
// counts rather than discarded as a crash — plus the summary the cron output (and the /status
// marker) is read from.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live outside any
// package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/artist-credits-sweep.test.ts
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
  drained) printf '{"ok":true,"dryRun":false,"scanned":0,"mintedArtists":0,"matchedArtists":0,"edgesWritten":0,"skippedNoIdentity":0,"rateLimited":false,"nextCursor":null}\\n' ;;
  throttled) printf '{"ok":true,"dryRun":false,"scanned":3,"mintedArtists":2,"matchedArtists":1,"edgesWritten":3,"skippedNoIdentity":0,"rateLimited":true,"nextCursor":null}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"dryRun":false,"scanned":5,"mintedArtists":4,"matchedArtists":2,"edgesWritten":7,"skippedNoIdentity":1,"rateLimited":false,"nextCursor":"t-5"}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./artist-credits-sweep").fluncleJson;

/** Point the stub at one of its canned responses. */
function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "artist-credits-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ fluncleJson } = await import("./artist-credits-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  edgesWritten?: number;
  matchedArtists?: number;
  mintedArtists?: number;
  ok?: boolean;
  rateLimited?: boolean;
  scanned?: number;
  skippedNoIdentity?: number;
};

describe("artist-credits-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "backfills", "artist-credits", "--limit", "40"]);

    expect(pass.ok).toBe(true);
    expect(pass.scanned).toBe(5);
    expect(pass.mintedArtists).toBe(4);
    expect(pass.matchedArtists).toBe(2);
    expect(pass.edgesWritten).toBe(7);
    expect(pass.skippedNoIdentity).toBe(1);
    expect(pass.rateLimited).toBe(false);
  });

  test("RECORDS a drained tick (the residual is complete) as a clean no-op", () => {
    mode("drained");
    const pass = fluncleJson<Pass>(["admin", "backfills", "artist-credits"]);

    expect(pass.ok).toBe(true);
    expect(pass.scanned).toBe(0);
    expect(pass.mintedArtists).toBe(0);
    expect(pass.edgesWritten).toBe(0);
  });

  test("RECORDS a throttle-stopped tick with its real counts (a pause, not a crash)", () => {
    mode("throttled");
    const pass = fluncleJson<Pass>(["admin", "backfills", "artist-credits"]);

    expect(pass.ok).toBe(true);
    expect(pass.rateLimited).toBe(true);
    expect(pass.scanned).toBe(3);
    expect(pass.mintedArtists).toBe(2);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "artist-credits"])).toThrow(
      /missing_token/,
    );
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson<Pass>(["admin", "backfills", "artist-credits"])).toThrow(/exited 1/);
  });
});
