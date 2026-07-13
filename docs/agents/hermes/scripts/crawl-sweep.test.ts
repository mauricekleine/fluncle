// Unit tests for crawl-sweep.ts — the `--no-agent` catalogue-crawl cron's orchestrator.
//
// The sweep is a PURE trigger (zero LLM tokens): it drives ONE bounded `fluncle admin
// catalogue crawl` pass and reports it. So the contract worth pinning is exactly the one
// backfill-sweep's is — parse-first, so a pass that stopped on the MusicBrainz circuit
// breaker is RECORDED with its real counts rather than discarded as a crash — plus the
// summary mapping the cron output (and the /status marker) is read from.
//
// The box-script sweeps are self-contained (they cannot import the workspace) and live
// outside any package's test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/crawl-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no fluncle spawn, no network). The fluncle CLI itself is stubbed with
// a tiny executable selected via FLUNCLE_BIN (read at module load, hence the dynamic
// import in beforeAll).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stub fluncle: a mode FILE beside it selects the response shape. (The sweep builds
// its own argv, so the mode cannot ride on an arg the way backfill-sweep's does — and
// Bun's spawnSync snapshots the environment, so it cannot ride on an env var either.)
const STUB = `#!/bin/bash
case "$(cat "$(dirname "$0")/mode")" in
  throttled) printf '{"ok":true,"expanded":3,"failed":1,"tracksFound":21,"tracksWritten":18,"tracksSkipped":3,"nodesEnqueued":5,"frontierPending":212,"seeded":0,"maxHop":2,"dryRun":false,"labelsDiscovered":["Hospital Records"],"rateLimited":true}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  timeout-once) if [ -f "$(dirname "$0")/tried" ]; then printf '{"ok":true,"expanded":10,"failed":0,"tracksFound":40,"tracksWritten":31,"tracksSkipped":9,"nodesEnqueued":80,"frontierPending":150,"seeded":0,"maxHop":2,"dryRun":false,"labelsDiscovered":[],"rateLimited":false}\\n'; else touch "$(dirname "$0")/tried"; printf 'error: The operation timed out.\\n' >&2; exit 1; fi ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"expanded":10,"failed":0,"tracksFound":77,"tracksWritten":63,"tracksSkipped":14,"nodesEnqueued":100,"frontierPending":191,"seeded":1,"maxHop":2,"dryRun":false,"labelsDiscovered":[],"rateLimited":false}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./crawl-sweep").fluncleJson;
let crawlPassWithRetry: typeof import("./crawl-sweep").crawlPassWithRetry;

/** Point the stub at one of its canned responses. */
function mode(name: string): void {
  writeFileSync(join(dir, "mode"), name);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "crawl-sweep-"));
  const bin = join(dir, "fluncle");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.FLUNCLE_BIN = bin;
  mode("ok");

  ({ crawlPassWithRetry, fluncleJson } = await import("./crawl-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  expanded?: number;
  labelsDiscovered?: string[];
  ok?: boolean;
  rateLimited?: boolean;
  tracksWritten?: number;
};

describe("crawl-sweep's fluncleJson", () => {
  test("returns a clean pass summary", () => {
    mode("ok");
    const pass = fluncleJson<Pass>(["admin", "catalogue", "crawl", "--limit", "10"]);

    expect(pass.ok).toBe(true);
    expect(pass.expanded).toBe(10);
    expect(pass.tracksWritten).toBe(63);
    expect(pass.rateLimited).toBe(false);
  });

  test("RECORDS a pass that stopped on the MusicBrainz circuit breaker", () => {
    // The pass did real work (18 rows written) and then MusicBrainz throttled us. That is
    // a throttled tick, not a crash: its counts must survive, and `rateLimited` must reach
    // the cron output so a "3 expanded" tick does not read as a drained frontier.
    mode("throttled");
    const pass = fluncleJson<Pass>(["admin", "catalogue", "crawl"]);

    expect(pass.rateLimited).toBe(true);
    expect(pass.tracksWritten).toBe(18);
    expect(pass.labelsDiscovered).toEqual(["Hospital Records"]);
  });

  test("throws on the CLI's own error payload (a failed command, not a partial pass)", () => {
    mode("cli-error");

    expect(() => fluncleJson<Pass>(["admin", "catalogue", "crawl"])).toThrow(/missing_token/);
  });

  test("throws when the CLI crashes with no parseable JSON", () => {
    mode("crash");

    expect(() => fluncleJson<Pass>(["admin", "catalogue", "crawl"])).toThrow(/exited 1/);
  });
});

describe("crawl-sweep's transient-timeout retry", () => {
  test("a pass that times out ONCE self-heals inside the tick (no ok:false flap)", () => {
    // The 2026-07-13 flap: a slow MusicBrainz day timed the CLI call out, the tick wrote
    // `ok: false`, /status went DOWN, and the very next tick recovered. The retry makes the
    // transient invisible: first call times out, the immediate retry lands, the summary is
    // a clean pass. (The frontier is idempotent, so re-running a pass never double-writes.)
    rmSync(join(dir, "tried"), { force: true });
    mode("timeout-once");

    const pass = crawlPassWithRetry();

    expect(pass.ok).toBe(true);
    expect(pass.tracksWritten).toBe(31);
  });

  test("a NON-transient failure is not retried — it throws first time", () => {
    mode("cli-error");

    expect(() => crawlPassWithRetry()).toThrow(/missing_token|exited/);
  });
});
