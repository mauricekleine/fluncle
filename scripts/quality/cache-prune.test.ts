import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("cleanup retains the newest saved main snapshot and leaves other cache owners alone", () => {
  const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
  const root = mkdtempSync(join(tmpdir(), "cache-prune-"));
  const cargo = `cargo-quality-v2-${"0".repeat(32)}`;
  const oldCargo = `cargo-quality-v2-${"1".repeat(32)}`;
  const musl = `cargo-musl-v2-${"2".repeat(32)}`;
  const caches = [
    { created_at: "2026-10-01", id: 1, key: "turbo-v2-old", ref: "refs/heads/main" },
    { created_at: "2026-10-02", id: 2, key: "turbo-v2-current", ref: "refs/heads/main" },
    { created_at: "2026-10-03", id: 3, key: "turbo-v2-concurrent", ref: "refs/heads/main" },
    { created_at: "2026-10-04", id: 4, key: "turbo-v2-pr", ref: "refs/pull/1/merge" },
    { created_at: "2026-10-01", id: 5, key: musl, ref: "refs/heads/main" },
    { created_at: "2026-10-01", id: 6, key: oldCargo, ref: "refs/heads/main" },
    { created_at: "2026-10-02", id: 7, key: cargo, ref: "refs/heads/main" },
    { created_at: "2026-10-01", id: 8, key: "playwright-old", ref: "refs/heads/main" },
  ];
  try {
    writeFileSync(
      join(root, "pages.json"),
      JSON.stringify([{ actions_caches: caches.slice(0, 4) }, { actions_caches: caches.slice(4) }]),
    );
    writeFileSync(
      join(root, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("DELETE")) {
  fs.appendFileSync(process.env.CACHE_TEST_LOG, args.at(-1) + "\\n");
  process.exit(process.env.CACHE_TEST_DELETE_FAILURE ? 1 : 0);
}
process.stdout.write(fs.readFileSync(process.env.CACHE_TEST_PAGES, "utf8"));
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      CACHE_TEST_LOG: join(root, "deletes"),
      CACHE_TEST_PAGES: join(root, "pages.json"),
      CARGO_CACHE_KEY: cargo,
      GITHUB_REPOSITORY: "fixture/repository",
      PATH: `${root}:${process.env.PATH}`,
      PLAYWRIGHT_CACHE_KEY: "playwright-not-saved",
      TURBO_CACHE_KEY: "turbo-v2-current",
    };
    const run = () =>
      spawnSync(node, [join(import.meta.dir, "cache-prune.mjs")], {
        encoding: "utf8",
        env,
      });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(env.CACHE_TEST_LOG, "utf8").trim().split("\n")).toEqual([
      "repos/fixture/repository/actions/caches/2",
      "repos/fixture/repository/actions/caches/1",
      "repos/fixture/repository/actions/caches/6",
    ]);
    expect(result.stdout).toContain("playwright-: current snapshot absent; retaining prior caches");
    env.TURBO_CACHE_KEY = "";
    env.CARGO_CACHE_KEY = "";
    rmSync(env.CACHE_TEST_LOG);
    expect(run().status).toBe(0);
    expect(() => readFileSync(env.CACHE_TEST_LOG)).toThrow();
    env.TURBO_CACHE_KEY = "turbo-v2-current";
    const failure = spawnSync(node, [join(import.meta.dir, "cache-prune.mjs")], {
      encoding: "utf8",
      env: { ...env, CACHE_TEST_DELETE_FAILURE: "true" },
    });
    expect(failure.status).toBe(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
