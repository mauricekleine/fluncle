import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deriveRunOk, normalizeRunSummary } from "../../../../apps/web/src/lib/server/run-events";

import { DAILY_RETRY_SCHEDULES, dailyRetryState, RERUN_SAFE_JOBS } from "./daily-retry-state";

const ROOT = resolve(import.meta.dir, "..");
const RUNNER = resolve(import.meta.dir, "daily-retry-runner.sh");
const jobs = ["backup", "reach", "cluster"] as const;
const temporaryDirectories: string[] = [];
const FIXED_DAY = "2026-09-25";
const FIXED_NOW = new Date("2026-09-25T12:00:00Z");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture(job: string) {
  const root = mkdtempSync(join(tmpdir(), "fluncle-daily-retry-"));
  temporaryDirectories.push(root);
  const output = join(root, "cron", "output");
  const markerDirectory = join(output, `fluncle-${job}`);
  const bin = join(root, "bin");
  const attempts = join(root, "attempts");
  const payload = join(root, "payload.sh");
  mkdirSync(markerDirectory, { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(bin, "date"),
    '#!/usr/bin/env bash\nif [ "${1:-}" = "-u" ]; then printf "%s" "${FAKE_STARTED_AT:-2026-09-25T12:00:00Z}"; elif [ "${1:-}" = "+%Y%m%d" ]; then if [ -s "${ATTEMPTS:-/nonexistent}" ]; then printf "%s" "${FAKE_AFTER_LOCAL_DAY:-20260925}"; else printf "%s" "${FAKE_LOCAL_DAY:-20260925}"; fi; elif [ -n "${FAKE_AFTER_LOCAL_TIME:-}" ] && [ -s "${ATTEMPTS:-/nonexistent}" ]; then printf "%s" "$FAKE_AFTER_LOCAL_TIME"; else printf "%s" "${FAKE_LOCAL_TIME:-1200}"; fi\n',
  );
  chmodSync(join(bin, "date"), 0o755);
  writeFileSync(
    payload,
    '#!/usr/bin/env bash\nprintf x >> "$ATTEMPTS"\nprintf "%s\\n" "${FLUNCLE_DAILY_RETRY_STATE:-}" >> "$ATTEMPTS.states"\nprintf "%s\\n" "${FLUNCLE_DAILY_RETRY_SLOT_DAY:-}" >> "$ATTEMPTS.days"\ncount="$(wc -c < "$ATTEMPTS" | tr -d " ")"\nsource="${RESULT_MARKER:-}"\nif [ "$count" -ge 2 ] && [ -n "${SECOND_RESULT_MARKER:-}" ]; then source="$SECOND_RESULT_MARKER"; fi\nif [ -n "$source" ]; then marker="$MARKER_DIR/result-${count}.md"; cp "$source" "$marker"; TZ=UTC touch -t "${RESULT_MTIME:-202609251200}" "$marker"; fi\nexit "${PAYLOAD_EXIT:-0}"\n',
  );
  chmodSync(payload, 0o755);

  return { attempts, bin, markerDirectory, output, payload, root };
}

function skipSummary(job: (typeof jobs)[number]): string {
  const waits = { backup: 120012, cluster: 120027, reach: 120006 };

  return JSON.stringify({
    admissionOutcome: "wait-expired",
    admissionWaitMs: waits[job],
    admissionYieldReason: "database-health",
    checked: null,
    errors: 0,
    gateState: "admission-skipped",
    ok: true,
    payloadStarted: false,
    produced: null,
  });
}

function writeMarker(directory: string, name: string, summary: string): void {
  const path = join(directory, `${name}.md`);
  writeFileSync(path, `# Cron Job\n\n${summary}\n`);
  utimesSync(path, FIXED_NOW, FIXED_NOW);
}

function run(
  setup: ReturnType<typeof fixture>,
  job: string,
  finalSlot: string,
  options: {
    afterLocalDay?: string;
    afterLocalTime?: string;
    exit?: number;
    localDay?: string;
    localTime?: string;
    primarySlot?: string;
    resultMarker?: string;
    resultMtime?: string;
    secondResultMarker?: string;
    startedAt?: string;
    timeZone?: string;
    weekday?: string;
  } = {},
) {
  return spawnSync(
    "bash",
    [
      RUNNER,
      `fluncle-${job}`,
      options.timeZone ?? "UTC",
      options.primarySlot ?? (job === "funnel-snapshot" ? "23:45" : "11:00"),
      finalSlot,
      ...(options.weekday === undefined ? [] : ["--weekday", options.weekday]),
      "--",
      "bash",
      setup.payload,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ATTEMPTS: setup.attempts,
        BUN_BIN: process.execPath,
        DAILY_RETRY_STRADDLE_JITTER_SECS: "0",
        FAKE_AFTER_LOCAL_DAY: options.afterLocalDay ?? "20260925",
        FAKE_AFTER_LOCAL_TIME: options.afterLocalTime ?? "",
        FAKE_LOCAL_DAY: options.localDay ?? "20260925",
        FAKE_LOCAL_TIME: options.localTime ?? "1200",
        FAKE_STARTED_AT: options.startedAt ?? "2026-09-25T12:00:00Z",
        HEALTHCHECK_CRON_OUTPUT_DIR: setup.output,
        HOME: setup.root,
        MARKER_DIR: setup.markerDirectory,
        PATH: `${setup.bin}:${process.env.PATH ?? ""}`,
        PAYLOAD_EXIT: String(options.exit ?? 0),
        RESULT_MARKER: options.resultMarker ?? "",
        RESULT_MTIME: options.resultMtime ?? "202609251200",
        SECOND_RESULT_MARKER: options.secondResultMarker ?? "",
      },
    },
  );
}

function retryStates(path: string): string[] {
  try {
    return readFileSync(`${path}.states`, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

function slotDays(path: string): string[] {
  try {
    return readFileSync(`${path}.days`, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

function attempts(path: string): number {
  try {
    return readFileSync(path, "utf8").length;
  } catch {
    return 0;
  }
}

describe("daily and weekly retry", () => {
  for (const job of jobs) {
    test(`the real ${job} admission skip retries, then a completed payload never runs twice`, () => {
      const setup = fixture(job);
      const now = FIXED_DAY;
      const completed =
        job === "backup"
          ? JSON.stringify({
              boxState: { key: `box-state/daily/${now}/box-state.tar.gz.enc` },
              dailyKey: `db-backups/daily/${now}/fluncle.sql.gz`,
              errors: 0,
              ok: true,
              produced: 2,
            })
          : JSON.stringify({ checked: 13, errors: 0, ok: true, produced: 12 });
      const resultMarker = join(setup.root, "completed.md");
      writeMarker(setup.markerDirectory, "admission-skip", skipSummary(job));
      writeFileSync(resultMarker, `# Cron Job\n\n${completed}\n`);

      expect(run(setup, job, "11:00", { resultMarker }).status).toBe(0);
      expect(attempts(setup.attempts)).toBe(1);
      expect(run(setup, job, "11:00", { resultMarker }).status).toBe(0);
      expect(attempts(setup.attempts)).toBe(1);
      expect(
        dailyRetryState({
          directory: setup.output,
          job: `fluncle-${job}`,
          now: FIXED_NOW,
          primarySlot: "11:00",
          timeZone: "UTC",
        }),
      ).toBe(job === "backup" ? "complete" : "started");
    });

    test(`the real ${job} admission skip alerts only after the final failed slot`, () => {
      const setup = fixture(job);
      const skipMarker = join(setup.root, "skip.md");
      writeMarker(setup.markerDirectory, "admission-skip", skipSummary(job));
      writeFileSync(skipMarker, `# Cron Job\n\n${skipSummary(job)}\n`);

      const intermediate = run(setup, job, "13:00", { resultMarker: skipMarker });
      expect(attempts(setup.attempts)).toBe(0);
      const final = run(setup, job, "11:00", { resultMarker: skipMarker });

      expect(intermediate.status).toBe(0);
      expect(final.status).toBe(75);
      expect(attempts(setup.attempts)).toBe(1);
      expect([intermediate.status, final.status].filter((status) => status !== 0)).toEqual([75]);
      expect(run(setup, job, "11:00", { resultMarker: skipMarker }).status).toBe(0);
      expect(attempts(setup.attempts)).toBe(1);
    });
  }

  test("a partial backup uses the retry slot and needs both artifacts before it is complete", () => {
    const setup = fixture("backup");
    const day = FIXED_DAY;
    const partial = join(setup.root, "partial.md");
    const complete = join(setup.root, "complete.md");
    writeFileSync(
      partial,
      `# Cron Job\n\n${JSON.stringify({ dailyKey: `db-backups/daily/${day}/fluncle.sql.gz`, errors: 1, ok: false })}\n`,
    );
    writeFileSync(
      complete,
      `# Cron Job\n\n${JSON.stringify({ boxState: { key: `box-state/daily/${day}/box-state.tar.gz.enc` }, dailyKey: `db-backups/daily/${day}/fluncle.sql.gz`, errors: 0, ok: true })}\n`,
    );

    expect(run(setup, "backup", "13:00", { exit: 1, resultMarker: partial }).status).toBe(0);
    expect(
      dailyRetryState({
        directory: setup.output,
        job: "fluncle-backup",
        now: FIXED_NOW,
        primarySlot: "11:00",
        timeZone: "UTC",
      }),
    ).toBe("partial");
    expect(run(setup, "backup", "11:00", { resultMarker: complete }).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
  });

  test("an unreadable or unrecognized backup marker never repeats an unknown payload", () => {
    const unreadable = fixture("backup");
    writeMarker(unreadable.markerDirectory, "unreadable", "backup log without a JSON summary");
    expect(run(unreadable, "backup", "11:00").status).toBe(0);
    expect(attempts(unreadable.attempts)).toBe(0);

    const unrecognized = fixture("backup");
    writeMarker(
      unrecognized.markerDirectory,
      "unrecognized",
      JSON.stringify({ errors: 1, ok: false, reason: "backup_failed" }),
    );
    expect(run(unrecognized, "backup", "11:00").status).toBe(0);
    expect(attempts(unrecognized.attempts)).toBe(0);
  });

  test("a TERM delivered to the runner inside the container reaches a nested Bash payload before it exits", async () => {
    const setup = fixture("backup");
    const nestedPid = join(setup.root, "nested-pid");
    const nestedSignal = join(setup.root, "nested-term");
    writeFileSync(
      setup.payload,
      '#!/usr/bin/env bash\nbash -c \'trap "printf reached > $NESTED_SIGNAL; exit 0" TERM; printf "%s" "$$" > "$NESTED_PID"; sleep 30 & wait\' &\nwait\n',
    );
    const child = spawn(
      "bash",
      [RUNNER, "fluncle-backup", "UTC", "11:00", "13:00", "--", "bash", setup.payload],
      {
        env: {
          ...process.env,
          BUN_BIN: process.execPath,
          FAKE_LOCAL_DAY: "20260925",
          FAKE_LOCAL_TIME: "1200",
          FAKE_STARTED_AT: "2026-09-25T12:00:00Z",
          HEALTHCHECK_CRON_OUTPUT_DIR: setup.output,
          HOME: setup.root,
          NESTED_PID: nestedPid,
          NESTED_SIGNAL: nestedSignal,
          PATH: `${setup.bin}:${process.env.PATH ?? ""}`,
        },
        stdio: "ignore",
      },
    );

    for (let attempt = 0; attempt < 100 && !existsSync(nestedPid); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(existsSync(nestedPid)).toBe(true);
    child.kill("SIGTERM");
    const exit = await new Promise<number | null>((resolveExit) => {
      child.once("exit", (code) => resolveExit(code));
    });
    expect(exit).toBe(143);
    expect(existsSync(nestedSignal)).toBe(true);
  }, 8000);

  test("a zero-window reconcile admission pause retries, while work from one window never repeats", () => {
    const setup = fixture("reconcile-hub-counts");
    const paused = JSON.stringify({
      admissionOutcome: "phase-yielded",
      checked: 0,
      errors: 1,
      gateState: "paused",
      ok: false,
      partial: true,
      produced: 0,
      reason: "database_admission",
      windows: 0,
    });
    const pauseMarker = join(setup.root, "paused.md");
    const completeMarker = join(setup.root, "complete.md");
    writeFileSync(pauseMarker, `# Cron Job\n\n${paused}\n`);
    writeFileSync(
      completeMarker,
      '# Cron Job\n\n{"checked":3,"errors":0,"ok":true,"produced":2,"windows":3}\n',
    );

    expect(
      run(setup, "reconcile-hub-counts", "13:00", { exit: 1, resultMarker: pauseMarker }).status,
    ).toBe(0);
    expect(
      dailyRetryState({
        directory: setup.output,
        job: "fluncle-reconcile-hub-counts",
        now: FIXED_NOW,
        primarySlot: "11:00",
        timeZone: "UTC",
      }),
    ).toBe("skipped");
    expect(
      run(setup, "reconcile-hub-counts", "11:00", { resultMarker: completeMarker }).status,
    ).toBe(0);
    expect(
      run(setup, "reconcile-hub-counts", "11:00", { resultMarker: completeMarker }).status,
    ).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);

    const partialSetup = fixture("reconcile-hub-counts");
    writeMarker(
      partialSetup.markerDirectory,
      "worked",
      JSON.stringify({
        admissionOutcome: "phase-yielded",
        checked: 0,
        errors: 0,
        gateState: "paused",
        ok: true,
        partial: true,
        produced: 2,
        reason: "database_admission",
        windows: 1,
      }),
    );
    expect(run(partialSetup, "reconcile-hub-counts", "11:00").status).toBe(0);
    expect(attempts(partialSetup.attempts)).toBe(0);
  });

  test("a zero-window reconcile pause fails the service only after its final retry", () => {
    const setup = fixture("reconcile-hub-counts");
    const paused = join(setup.root, "paused.md");
    writeFileSync(
      paused,
      '# Cron Job\n\n{"admissionOutcome":"phase-yielded","checked":0,"errors":1,"gateState":"paused","ok":false,"partial":true,"produced":0,"reason":"database_admission","windows":0}\n',
    );

    const intermediate = run(setup, "reconcile-hub-counts", "13:00", {
      exit: 1,
      resultMarker: paused,
    });
    const final = run(setup, "reconcile-hub-counts", "11:00", { exit: 1, resultMarker: paused });

    expect(intermediate.status).toBe(0);
    expect(final.status).toBe(75);
    expect(attempts(setup.attempts)).toBe(2);
  });

  test("a skipped backup straddling its final calendar slot retries inside the active service", () => {
    const setup = fixture("backup");
    const skip = join(setup.root, "skip.md");
    const complete = join(setup.root, "complete.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("backup")}\n`);
    writeFileSync(
      complete,
      '# Cron Job\n\n{"boxState":{"key":"box-state/daily/2026-09-25/box-state.tar.gz.enc"},"dailyKey":"db-backups/daily/2026-09-25/fluncle.sql.gz","errors":0,"ok":true}\n',
    );
    const options = {
      afterLocalTime: "0521",
      localTime: "0519",
      primarySlot: "03:00",
      resultMarker: skip,
      resultMtime: "202609250521",
      secondResultMarker: complete,
      startedAt: "2026-09-25T05:19:00Z",
    };

    expect(run(setup, "backup", "05:20", options).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
    expect(run(setup, "backup", "05:20", options).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
  });

  test("a final slot lost to an active admission wait still alerts once if both attempts skip", () => {
    const setup = fixture("backup");
    const skip = join(setup.root, "skip.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("backup")}\n`);

    expect(
      run(setup, "backup", "05:20", {
        afterLocalTime: "0521",
        localTime: "0519",
        primarySlot: "03:00",
        resultMarker: skip,
        resultMtime: "202609250521",
        startedAt: "2026-09-25T05:19:00Z",
      }).status,
    ).toBe(75);
    expect(attempts(setup.attempts)).toBe(2);
    expect(run(setup, "backup", "05:20", { localTime: "0522", primarySlot: "03:00" }).status).toBe(
      0,
    );
    expect(attempts(setup.attempts)).toBe(2);
  });

  test("a catch-up starting after both calendar slots retries once inside the active service", () => {
    const setup = fixture("backup");
    const skip = join(setup.root, "skip.md");
    const complete = join(setup.root, "complete.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("backup")}\n`);
    writeFileSync(
      complete,
      '# Cron Job\n\n{"boxState":{"key":"box-state/daily/2026-09-25/box-state.tar.gz.enc"},"dailyKey":"db-backups/daily/2026-09-25/fluncle.sql.gz","errors":0,"ok":true}\n',
    );
    const options = {
      afterLocalTime: "0602",
      localTime: "0600",
      primarySlot: "03:00",
      resultMarker: skip,
      resultMtime: "202609250601",
      secondResultMarker: complete,
      startedAt: "2026-09-25T06:00:00Z",
    };

    expect(run(setup, "backup", "05:20", options).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
    expect(run(setup, "backup", "05:20", options).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
  });

  test("a catch-up after both calendar slots alerts once after its bounded retry skips", () => {
    const setup = fixture("backup");
    const skip = join(setup.root, "skip.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("backup")}\n`);

    expect(
      run(setup, "backup", "05:20", {
        afterLocalTime: "0602",
        localTime: "0600",
        primarySlot: "03:00",
        resultMarker: skip,
        resultMtime: "202609250601",
        startedAt: "2026-09-25T06:00:00Z",
      }).status,
    ).toBe(75);
    expect(attempts(setup.attempts)).toBe(2);
  });

  test("a final slot crossed after midnight fails instead of silently losing its retry", () => {
    const setup = fixture("funnel-snapshot");
    const skip = join(setup.root, "skip.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("cluster")}\n`);

    expect(
      run(setup, "funnel-snapshot", "23:57", {
        afterLocalDay: "20260926",
        afterLocalTime: "0001",
        localTime: "2356",
        resultMarker: skip,
        resultMtime: "202609260001",
        startedAt: "2026-09-25T23:56:00Z",
      }).status,
    ).toBe(75);
    expect(attempts(setup.attempts)).toBe(1);
  });

  test("an unconfirmed start of a re-run-safe payload is marked, then retried once by the final slot", () => {
    const setup = fixture("cluster");

    expect(run(setup, "cluster", "13:00", { exit: 75 }).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(1);
    const markers = readdirSync(setup.markerDirectory);
    expect(markers).toHaveLength(1);
    const marker = readFileSync(join(setup.markerDirectory, markers[0] ?? ""), "utf8");
    const summaryRaw = marker.split("\n").find((line) => line.startsWith("{"));
    const summary = normalizeRunSummary(summaryRaw);
    expect(summary.summaryStatus).toBe("parsed");
    expect(summary.gateState).toBe("active");
    expect(summary.errors).toBe(1);
    expect(summary.unrecognisedFields).toEqual([]);
    expect(deriveRunOk(75, summary.errors)).toBe(false);
    expect(marker).toContain('"outcome":"payload-unconfirmed"');
    expect(
      dailyRetryState({
        directory: setup.output,
        job: "fluncle-cluster",
        now: FIXED_NOW,
        primarySlot: "11:00",
        timeZone: "UTC",
      }),
    ).toBe("partial");

    expect(run(setup, "cluster", "11:00", { exit: 75 }).status).toBe(75);
    expect(attempts(setup.attempts)).toBe(2);
    expect(run(setup, "cluster", "11:00", { exit: 75 }).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
  });

  test("a fenced backup whose retry completes ends the day complete with one alert-free exit", () => {
    const setup = fixture("backup");
    const complete = join(setup.root, "complete.md");
    writeFileSync(
      complete,
      '# Cron Job\n\n{"boxState":{"key":"box-state/daily/2026-09-25/box-state.tar.gz.enc"},"dailyKey":"db-backups/daily/2026-09-25/fluncle.sql.gz","errors":0,"ok":true}\n',
    );

    expect(run(setup, "backup", "13:00", { exit: 75 }).status).toBe(0);
    expect(run(setup, "backup", "11:00", { secondResultMarker: complete }).status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
    expect(retryStates(setup.attempts)).toEqual(["pending", "partial"]);
  });

  test("an unconfirmed start of a payload outside the re-run-safe roster is never repeated", () => {
    const setup = fixture("unlisted");

    expect(run(setup, "unlisted", "13:00", { exit: 75 }).status).toBe(75);
    expect(run(setup, "unlisted", "11:00").status).toBe(0);
    expect(attempts(setup.attempts)).toBe(1);
    expect(
      dailyRetryState({
        directory: setup.output,
        job: "fluncle-unlisted",
        now: FIXED_NOW,
        primarySlot: "11:00",
        timeZone: "UTC",
      }),
    ).toBe("started");
  });

  test("every covered sweep except the git-workspace agent passes retries an unconfirmed start", () => {
    const covered = readdirSync(ROOT)
      .flatMap((directory) =>
        directory.endsWith("-timer")
          ? readdirSync(join(ROOT, directory))
              .filter((name) => name.endsWith(".service"))
              .map((name) => readFileSync(join(ROOT, directory, name), "utf8"))
          : [],
      )
      .flatMap((service) => {
        const unit = /daily-retry-runner\.sh (fluncle-[a-z0-9-]+) /.exec(service)?.[1];
        return unit === undefined ? [] : [unit];
      })
      .sort();
    const gitWorkspaceAgents = ["fluncle-audit", "fluncle-audit-review", "fluncle-sentry-triage"];

    expect(covered).toEqual([...RERUN_SAFE_JOBS, ...gitWorkspaceAgents].sort());
  });

  test("the funnel final slot keeps its UTC day when its marker lands after midnight", () => {
    const setup = fixture("funnel-snapshot");
    const skip = join(setup.markerDirectory, "admission-skip.md");
    const completed = join(setup.root, "completed.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("cluster")}\n`);
    utimesSync(skip, new Date("2026-09-25T23:50:00Z"), new Date("2026-09-25T23:50:00Z"));
    writeFileSync(completed, '# Cron Job\n\n{"day":"2026-09-25","errors":0,"ok":true}\n');

    expect(
      run(setup, "funnel-snapshot", "23:57", {
        localTime: "2357",
        resultMarker: completed,
        resultMtime: "202609260001",
        startedAt: "2026-09-25T23:57:00Z",
      }).status,
    ).toBe(0);
    expect(
      dailyRetryState({
        directory: setup.output,
        job: "fluncle-funnel-snapshot",
        now: new Date("2026-09-25T23:57:00Z"),
        primarySlot: "23:45",
        timeZone: "UTC",
      }),
    ).toBe("started");
    expect(
      dailyRetryState({
        directory: setup.output,
        job: "fluncle-funnel-snapshot",
        now: new Date("2026-09-26T23:45:00Z"),
        primarySlot: "23:45",
        timeZone: "UTC",
      }),
    ).toBe("pending");
  });

  test("the funnel final skip still fails when its marker lands after midnight", () => {
    const setup = fixture("funnel-snapshot");
    const skip = join(setup.root, "skip.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("cluster")}\n`);

    expect(
      run(setup, "funnel-snapshot", "23:57", {
        localTime: "2357",
        resultMarker: skip,
        resultMtime: "202609260001",
        startedAt: "2026-09-25T23:57:00Z",
      }).status,
    ).toBe(75);
  });

  test("a next-day funnel snapshot only completes the prior slot when it backfilled that day", () => {
    const setup = fixture("funnel-snapshot");
    const marker = join(setup.markerDirectory, "late.md");
    const modified = new Date("2026-09-26T00:01:00Z");
    writeFileSync(marker, '# Cron Job\n\n{"day":"2026-09-26","ok":true}\n');
    utimesSync(marker, modified, modified);
    const options = {
      directory: setup.output,
      job: "fluncle-funnel-snapshot",
      now: new Date("2026-09-25T23:57:00Z"),
      primarySlot: "23:45",
      timeZone: "UTC",
    };

    expect(dailyRetryState(options)).toBe("partial");
    writeFileSync(
      marker,
      '# Cron Job\n\n{"backfilledDays":["2026-09-25"],"day":"2026-09-26","ok":true}\n',
    );
    utimesSync(marker, modified, modified);
    expect(dailyRetryState(options)).toBe("started");
  });

  test("an admission skip under the retry wrapper is a failed ledger attempt with a successful service exit", () => {
    const setup = fixture("reach");
    const curl = join(setup.bin, "curl");
    writeFileSync(curl, '#!/usr/bin/env bash\nprintf \'{"code":"database_busy"}\\n409\'\n');
    chmodSync(curl, 0o755);
    const result = spawnSync(
      "bash",
      [
        RUNNER,
        "fluncle-reach",
        "UTC",
        "11:00",
        "13:00",
        "--",
        "bash",
        resolve(import.meta.dir, "database-admission-runner.sh"),
        "fluncle-reach",
        "--",
        "true",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BUN_BIN: process.execPath,
          DATABASE_ADMISSION_FAIL_CLOSED: "true",
          FLUNCLE_API_BASE_URL: "https://example.invalid",
          FLUNCLE_API_TOKEN: "test-token",
          HEALTHCHECK_CRON_OUTPUT_DIR: setup.output,
          HOME: setup.root,
          PATH: `${setup.bin}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(0);
    const markers = readdirSync(setup.markerDirectory);
    expect(markers).toHaveLength(1);
    const marker = readFileSync(join(setup.markerDirectory, markers[0] ?? ""), "utf8");
    expect(marker).toContain('"errors":1');
    expect(marker).toContain('"payloadStarted":false');
    expect(marker).toContain('"gateState":"admission-skipped"');
  });

  test("a payload SIGKILLed with its runner leaves no marker, so the final slot re-runs it", async () => {
    const setup = fixture("backup");
    const started = join(setup.root, "started");
    const complete = join(setup.root, "complete.md");
    writeFileSync(
      complete,
      '# Cron Job\n\n{"boxState":{"key":"box-state/daily/2026-09-25/box-state.tar.gz.enc"},"dailyKey":"db-backups/daily/2026-09-25/fluncle.sql.gz","errors":0,"ok":true}\n',
    );
    writeFileSync(
      setup.payload,
      '#!/usr/bin/env bash\nprintf x >> "$ATTEMPTS"\nif [ "$(wc -c < "$ATTEMPTS" | tr -d " ")" -ge 2 ]; then cp "$COMPLETE" "$MARKER_DIR/done.md"; exit 0; fi\n: > "$STARTED"\nsleep 30\n',
    );
    const env = {
      ...process.env,
      ATTEMPTS: setup.attempts,
      BUN_BIN: process.execPath,
      COMPLETE: complete,
      FAKE_LOCAL_DAY: "20260925",
      FAKE_LOCAL_TIME: "1200",
      FAKE_STARTED_AT: "2026-09-25T12:00:00Z",
      HEALTHCHECK_CRON_OUTPUT_DIR: setup.output,
      HOME: setup.root,
      MARKER_DIR: setup.markerDirectory,
      PATH: `${setup.bin}:${process.env.PATH ?? ""}`,
      STARTED: started,
    };
    const child = spawn(
      "bash",
      [RUNNER, "fluncle-backup", "UTC", "11:00", "13:00", "--", "bash", setup.payload],
      { detached: true, env, stdio: "ignore" },
    );

    for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(existsSync(started)).toBe(true);
    process.kill(-(child.pid ?? 0), "SIGKILL");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
    });
    expect(readdirSync(setup.markerDirectory)).toEqual([]);

    const retry = spawnSync(
      "bash",
      [RUNNER, "fluncle-backup", "UTC", "11:00", "11:00", "--", "bash", setup.payload],
      { encoding: "utf8", env },
    );
    expect(retry.status).toBe(0);
    expect(attempts(setup.attempts)).toBe(2);
  }, 8000);

  test("a partial backup hands its partial state to the payload so only the missing leg runs", () => {
    const setup = fixture("backup");
    const partial = join(setup.root, "partial.md");
    const complete = join(setup.root, "complete.md");
    writeFileSync(
      partial,
      `# Cron Job\n\n${JSON.stringify({ boxState: { error: "upload failed", ok: false }, dailyKey: `db-backups/daily/${FIXED_DAY}/fluncle.sql.gz`, errors: 0, ok: false })}\n`,
    );
    writeFileSync(
      complete,
      `# Cron Job\n\n${JSON.stringify({ boxState: { key: `box-state/daily/${FIXED_DAY}/box-state.tar.gz.enc` }, dailyKey: `db-backups/daily/${FIXED_DAY}/fluncle.sql.gz`, dumpReused: true, errors: 0, ok: true })}\n`,
    );

    expect(
      run(setup, "backup", "13:00", {
        exit: 1,
        resultMarker: partial,
        secondResultMarker: complete,
      }).status,
    ).toBe(0);
    expect(
      run(setup, "backup", "11:00", {
        resultMarker: partial,
        secondResultMarker: complete,
      }).status,
    ).toBe(0);
    expect(retryStates(setup.attempts)).toEqual(["pending", "partial"]);
    expect(
      dailyRetryState({
        directory: setup.output,
        job: "fluncle-backup",
        now: FIXED_NOW,
        primarySlot: "11:00",
        timeZone: "UTC",
      }),
    ).toBe("complete");
  });

  describe("a weekly timer resolves its slot day by its weekday", () => {
    const newsletterComplete = '# Cron Job\n\n{"checked":1,"errors":0,"ok":true,"produced":1}\n';
    const sunday = {
      localDay: "20260927",
      localTime: "1030",
      primarySlot: "15:00",
      startedAt: "2026-09-27T08:30:00Z",
      timeZone: "Europe/Amsterdam",
      weekday: "Fri",
    };

    test("a Sunday catch-up after a completed Friday is a no-op", () => {
      const setup = fixture("newsletter");
      const friday = join(setup.markerDirectory, "friday.md");
      writeFileSync(friday, newsletterComplete);
      utimesSync(friday, new Date("2026-09-25T13:10:00Z"), new Date("2026-09-25T13:10:00Z"));

      const result = run(setup, "newsletter", "16:15", sunday);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("catch-up activation is a no-op");
      expect(attempts(setup.attempts)).toBe(0);
    });

    test("a Sunday catch-up with no marker at all never authors an off-cycle edition", () => {
      const setup = fixture("newsletter");

      expect(run(setup, "newsletter", "16:15", sunday).status).toBe(0);
      expect(attempts(setup.attempts)).toBe(0);
    });

    test("a Friday catch-up before the primary slot is a no-op", () => {
      const setup = fixture("newsletter");

      expect(
        run(setup, "newsletter", "16:15", {
          ...sunday,
          localDay: "20260925",
          startedAt: "2026-09-25T08:30:00Z",
        }).status,
      ).toBe(0);
      expect(attempts(setup.attempts)).toBe(0);
    });

    test("the Friday primary slot still runs", () => {
      const setup = fixture("newsletter");

      expect(
        run(setup, "newsletter", "16:15", {
          ...sunday,
          localDay: "20260925",
          localTime: "1501",
          startedAt: "2026-09-25T13:01:00Z",
        }).status,
      ).toBe(0);
      expect(attempts(setup.attempts)).toBe(1);
      expect(
        dailyRetryState({
          directory: setup.output,
          job: "fluncle-newsletter",
          now: new Date("2026-09-27T08:30:00Z"),
          primarySlot: "15:00",
          timeZone: "Europe/Amsterdam",
          weekday: "Fri",
        }),
      ).toBe("off-cycle");
    });
  });

  test("every weekly timer under the retry runner hands it its weekday", () => {
    for (const directory of readdirSync(ROOT).filter((name) => name.endsWith("-timer"))) {
      for (const name of readdirSync(join(ROOT, directory)).filter((file) =>
        file.endsWith(".timer"),
      )) {
        const timer = readFileSync(join(ROOT, directory, name), "utf8");
        const weekday = /^OnCalendar=(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /m.exec(timer)?.[1];
        if (weekday === undefined) {
          continue;
        }
        const service = readFileSync(
          join(ROOT, directory, name.replace(/\.timer$/, ".service")),
          "utf8",
        );
        if (!service.includes("daily-retry-runner.sh")) {
          continue;
        }
        expect(service, name).toContain(`--weekday ${weekday} --`);
      }
    }
  });

  test("no calendar slot falls in the Europe/Amsterdam spring-forward gap", () => {
    for (const directory of readdirSync(ROOT).filter((name) => name.endsWith("-timer"))) {
      for (const name of readdirSync(join(ROOT, directory)).filter((file) =>
        file.endsWith(".timer"),
      )) {
        const timer = readFileSync(join(ROOT, directory, name), "utf8");
        for (const slot of timer.match(/^OnCalendar=.*Europe\/Amsterdam$/gm) ?? []) {
          expect(slot, name).not.toMatch(/ 02:\d{2}(:\d{2})? Europe\/Amsterdam$/);
        }
      }
    }
  });

  test("both audit slots hand the payload the same Amsterdam slot day across the summer UTC boundary", () => {
    const setup = fixture("audit");
    const skip = join(setup.root, "skip.md");
    writeFileSync(skip, `# Cron Job\n\n${skipSummary("reach")}\n`);
    const shared = {
      afterLocalDay: "20260715",
      primarySlot: "01:00",
      resultMarker: skip,
      resultMtime: "202607142311",
      timeZone: "Europe/Amsterdam",
    };

    expect(
      run(setup, "audit", "03:10", {
        ...shared,
        localDay: "20260715",
        localTime: "0110",
        startedAt: "2026-07-14T23:10:00Z",
      }).status,
    ).toBe(0);
    expect(
      run(setup, "audit", "03:10", {
        ...shared,
        localDay: "20260715",
        localTime: "0311",
        startedAt: "2026-07-15T01:11:00Z",
      }).status,
    ).toBe(75);
    expect(attempts(setup.attempts)).toBe(2);
    expect(slotDays(setup.attempts)).toEqual(["2026-07-15", "2026-07-15"]);
  });

  test("all daily and weekly services use the shared retry guard and exactly two calendar slots", () => {
    const names = [
      "audit-review",
      "audit",
      "backup",
      "cluster",
      "demand",
      "funnel-snapshot",
      "label-releases",
      "label-triage",
      "logbook",
      "newsletter",
      "reach",
      "reconcile-hub-counts",
      "sentry-triage",
      "social-metrics",
    ];

    expect(Object.keys(DAILY_RETRY_SCHEDULES).sort()).toEqual(
      names.map((name) => `fluncle-${name}`).sort(),
    );

    for (const name of names) {
      const unit = `fluncle-${name}`;
      const directory = join(ROOT, `${name}-timer`);
      const timer = readFileSync(join(directory, `${unit}.timer`), "utf8");
      const service = readFileSync(join(directory, `${unit}.service`), "utf8");

      expect(timer.match(/^OnCalendar=/gm)?.length, unit).toBe(2);
      const args = new RegExp(
        `daily-retry-runner\\.sh ${unit} (\\S+) (\\d{2}:\\d{2}) (\\d{2}:\\d{2})(?: --weekday (\\w{3}))? --`,
      ).exec(service);
      const schedule = DAILY_RETRY_SCHEDULES[unit];
      expect(schedule, unit).toEqual({
        finalSlot: args?.[3],
        primarySlot: args?.[2],
        timeZone: args?.[1],
        ...(args?.[4] === undefined ? {} : { weekday: args[4] }),
      });
      expect(service, unit).toContain(`/opt/hermes-scripts/daily-retry-runner.sh ${unit} `);
      expect(service, unit).toContain("OnFailure=fluncle-sweep-failure@%n.service");
    }
  });
});
