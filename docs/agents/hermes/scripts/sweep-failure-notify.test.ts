import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const notifier = join(import.meta.dir, "..", "sweep-failure", "fluncle-sweep-failure-notify.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function runNotifier(unit: string, status: string) {
  const root = mkdtempSync(join(tmpdir(), "fluncle-sweep-failure-"));
  roots.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "curl.txt");
  mkdirSync(bin);
  const commands = {
    curl: '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CURL_CAPTURE"\n',
    docker:
      '#!/usr/bin/env bash\nprintf "DISCORD_ALERT_WEBHOOK=https://example.invalid/alert\\n"\n',
    systemctl:
      '#!/usr/bin/env bash\ncase "$3" in Result) printf "exit-code\\n" ;; ExecMainStatus) printf "%s\\n" "$TEST_STATUS" ;; ExecMainCode) printf "1\\n" ;; esac\n',
  };
  for (const [name, script] of Object.entries(commands)) {
    const path = join(bin, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  const result = spawnSync("bash", [notifier, unit], {
    encoding: "utf8",
    env: {
      ...process.env,
      CURL_CAPTURE: capture,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SWEEP_FAILURE_STATE_DIR: join(root, "state"),
      TEST_STATUS: status,
    },
  });
  expect(result.status).toBe(0);
  return readFileSync(capture, "utf8");
}

test("an exhausted daily retry alert describes an incomplete payload", () => {
  const posted = runNotifier("fluncle-cluster.service", "75");
  expect(posted).toContain("The daily payload is incomplete or unconfirmed");
  expect(posted).not.toContain("died before writing its /status marker");
});

test("other sweep failures retain the missing marker alert", () => {
  const posted = runNotifier("fluncle-render.service", "1");
  expect(posted).toContain("It died before writing its /status marker");
});
