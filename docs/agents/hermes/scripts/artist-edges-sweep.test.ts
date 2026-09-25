import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = `#!/bin/bash
case "$(cat "$(dirname "$0")/mode")" in
  drained) printf '{"ok":true,"dryRun":false,"scanned":0,"edgesWritten":0,"fullyMatched":[],"fullyMatchedCount":0,"partiallyMatched":[],"partiallyMatchedCount":0,"queueDepth":0,"zeroMatched":[],"zeroMatchedCount":0,"unmatchedNames":0}\\n' ;;
  cli-error) printf '{"code":"missing_token","message":"Missing required env vars: FLUNCLE_API_TOKEN","ok":false}\\n'; exit 1 ;;
  crash) printf 'boom\\n' >&2; exit 1 ;;
  *) printf '{"ok":true,"dryRun":false,"scanned":5,"edgesWritten":6,"fullyMatched":["a","b"],"fullyMatchedCount":2,"partiallyMatched":["c"],"partiallyMatchedCount":1,"queueDepth":17,"zeroMatched":["d","e"],"zeroMatchedCount":2,"unmatchedNames":3}\\n' ;;
esac
`;

let dir: string;
let fluncleJson: typeof import("./artist-edges-sweep").fluncleJson;
let main: typeof import("./artist-edges-sweep").main;

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

  ({ fluncleJson, main } = await import("./artist-edges-sweep"));
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

type Pass = {
  edgesWritten?: number;
  fullyMatchedCount?: number;
  ok?: boolean;
  partiallyMatchedCount?: number;
  queueDepth?: number;
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

function run(): Record<string, unknown> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);

  try {
    main();
  } finally {
    console.log = original;
  }

  return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

describe("artist-edges-sweep's canonical counters", () => {
  test("every visited-and-stamped track is checked + produced, with indexed post-pass depth", () => {
    mode("ok");

    expect(run()).toMatchObject({
      checked: 5,
      errors: 0,
      failed: 0,
      produced: 5,
      queue_depth: 17,
      scanned: 5,
    });
  });

  test("a measured drained worklist preserves checked: 0 and queue_depth: 0", () => {
    mode("drained");

    expect(run()).toMatchObject({
      checked: 0,
      errors: 0,
      failed: 0,
      produced: 0,
      queue_depth: 0,
    });
  });

  test("a command failure is a run error, never an item failure", () => {
    mode("crash");
    const summary = run();

    expect(summary).toMatchObject({ checked: 0, errors: 1, failed: 0, ok: false, produced: 0 });
    expect(summary).not.toHaveProperty("queue_depth");
  });
});
