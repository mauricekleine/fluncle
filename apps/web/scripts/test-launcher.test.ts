import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the complete fleet suite uses its launcher exit, while missing launchers and filtered runs stay local", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "web-test-launcher-")));
  try {
    const scripts = join(root, "apps/web/scripts");
    const bin = join(root, "bin");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    mkdirSync(join(root, "node_modules/vitest"), { recursive: true });
    copyFileSync(fileURLToPath(new URL("test.ts", import.meta.url)), join(scripts, "test.ts"));
    writeFileSync(
      join(root, "node_modules/vitest/vitest.mjs"),
      'console.log("LOCAL", ...process.argv.slice(2)); process.exit(23);',
    );
    const launcher = join(bin, "hyperspeed-boat-check");
    writeFileSync(launcher, '#!/bin/sh\nprintf "REMOTE %s\\n" "$*"\nexit 17\n');
    chmodSync(launcher, 0o700);
    const env = {
      ...process.env,
      FLEET_BOAT_CHECK: "1",
      FLEET_CPU_CAP: "1",
      FLUNCLE_VITEST_COVERAGE: "true",
      PATH: bin,
    };
    const run = (args: string[] = []) =>
      spawnSync(process.execPath, [join(scripts, "test.ts"), ...args], {
        cwd: join(root, "apps/web"),
        env,
        stdio: "pipe",
      });
    const remote = run();
    expect(remote.status).toBe(17);
    expect(remote.stdout.toString()).toContain(`--repo ${root}/ --coverage true`);
    expect(remote.stdout.toString()).not.toContain("LOCAL");
    const filtered = run(["src/example.test.ts"]);
    expect(filtered.status).toBe(23);
    expect(filtered.stdout.toString()).toContain(
      "LOCAL run --coverage.enabled=true src/example.test.ts",
    );
    rmSync(launcher);
    const fallback = run();
    expect(fallback.status).toBe(23);
    expect(fallback.stdout.toString()).toContain("LOCAL run --coverage.enabled=true");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
