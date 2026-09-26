import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DAILY_RETRY_SCHEDULES } from "./daily-retry-state";

const notifier = join(import.meta.dir, "..", "sweep-failure", "fluncle-sweep-failure-notify.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function runNotifier(unit: string, status: string, clock = { time: "1200", weekday: "Sat" }) {
  const root = mkdtempSync(join(tmpdir(), "fluncle-sweep-failure-"));
  roots.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "curl.txt");
  mkdirSync(bin);
  const commands = {
    curl: '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CURL_CAPTURE"\n',
    date: '#!/usr/bin/env bash\ncase "${1:-}" in +%H%M) printf "%s\\n" "$FAKE_TIME" ;; +%a) printf "%s\\n" "$FAKE_WEEKDAY" ;; *) exec /bin/date "$@" ;; esac\n',
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
      FAKE_TIME: clock.time,
      FAKE_WEEKDAY: clock.weekday,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SWEEP_FAILURE_STATE_DIR: join(root, "state"),
      TEST_STATUS: status,
    },
  });
  expect(result.status).toBe(0);
  try {
    return readFileSync(capture, "utf8");
  } catch {
    return "";
  }
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

test("a first-slot kill of a retry-runner job stays quiet until its final slot decides", () => {
  expect(runNotifier("fluncle-backup.service", "137", { time: "0305", weekday: "Sat" })).toBe("");
  expect(runNotifier("fluncle-audit.service", "255", { time: "0130", weekday: "Sat" })).toBe("");
});

test("a retry-runner job failing at or after its final slot alerts once", () => {
  expect(runNotifier("fluncle-backup.service", "137", { time: "0521", weekday: "Sat" })).toContain(
    "fluncle-backup.service",
  );
  expect(runNotifier("fluncle-backup.service", "75", { time: "0305", weekday: "Sat" })).toContain(
    "The daily payload is incomplete or unconfirmed",
  );
});

test("a weekly job's final-slot window only applies on its weekday", () => {
  expect(runNotifier("fluncle-newsletter.service", "137", { time: "1505", weekday: "Fri" })).toBe(
    "",
  );
  expect(
    runNotifier("fluncle-newsletter.service", "137", { time: "1505", weekday: "Sun" }),
  ).toContain("fluncle-newsletter.service");
});

test("the notifier's final slots match every retry-runner service", () => {
  const source = readFileSync(notifier, "utf8");
  for (const [job, schedule] of Object.entries(DAILY_RETRY_SCHEDULES)) {
    const line = `${job}.service) echo "${schedule.timeZone} ${schedule.finalSlot}${schedule.weekday === undefined ? "" : ` ${schedule.weekday}`}" ;;`;
    expect(source, job).toContain(line);
  }
  expect(source.match(/\.service\) echo "/g)?.length).toBe(
    Object.keys(DAILY_RETRY_SCHEDULES).length,
  );
});
