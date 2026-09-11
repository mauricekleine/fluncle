// Integration tests for crawl-sweep.ts. Fixtures exercise the phase protocol at the same process
// boundary the Hermes timer uses: admission is supplied by the runner, while provider work goes
// directly through the CLI's hidden --phase-file command.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SWEEP = resolve(import.meta.dirname, "crawl-sweep.ts");
const REAL_PHASE_RUNNER = resolve(import.meta.dirname, "database-admission-runner.sh");
const TEST_TIMEOUT_MS = 20_000;
const PROCESS_TIMEOUT_MS = 8_000;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function executable(path: string, body: string): string {
  writeFileSync(path, "#!/usr/bin/env bash\nset -u\n" + body + "\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

type Fixture = {
  bin: string;
  calls: string;
  directory: string;
  effects: string;
  fetchRelease: string;
  fetchStarted: string;
  mode: string;
  runner: string;
  timeline: string;
};

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "fluncle-crawl-phase-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const data: Fixture = {
    bin,
    calls: join(directory, "calls"),
    directory,
    effects: join(directory, "effects"),
    fetchRelease: join(directory, "fetch-release"),
    fetchStarted: join(directory, "fetch-started"),
    mode: join(directory, "mode"),
    runner: join(directory, "runner"),
    timeline: join(directory, "timeline"),
  };
  writeFileSync(data.mode, "normal");

  // The test-only runner keeps the same phase argv boundary as the real runner.
  executable(
    data.runner,
    'if [ "$1" = phase ]; then shift; fi\n' +
      'owner="$1"\n' +
      "shift\n" +
      '[ "$1" = -- ] && shift\n' +
      "mode=$(sed -n '1p' " +
      data.mode +
      ")\n" +
      'if [ "$mode" = "initialize-yield" ]; then exit 75; fi\n' +
      'if [ "$mode" = "yield-after-work" ]; then\n' +
      "  count=0; [ -f " +
      data.timeline +
      " ] && count=$(wc -l < " +
      data.timeline +
      ")\n" +
      '  if [ "$count" -ge 3 ]; then exit 75; fi\n' +
      "fi\n" +
      "printf '%s\\n' \"$owner\" >> " +
      data.timeline +
      "\n" +
      'exec "$@"',
  );

  const stub = [
    'phase_file=""',
    "next=false",
    'for argument in "$@"; do',
    '  if [ "$next" = true ]; then phase_file="$argument"; next=false; continue; fi',
    '  [ "$argument" = --phase-file ] && next=true',
    "done",
    "mode=$(sed -n '1p' " + data.mode + ")",
    'if [ -n "$phase_file" ]; then',
    '  phase=$(sed -n \'s/.*"phase":"\\([^"]*\\)".*/\\1/p\' "$phase_file")',
    '  printf \'%s:%s\\n\' "$phase" "$*" >> ' + data.calls,
    '  if [ -n "${COORDINATOR_LOCK-}" ]; then if [ -e "$COORDINATOR_LOCK" ]; then printf \'phase-lock:%s:held\\n\' "$phase" >> ' +
      data.timeline +
      "; else printf 'phase-lock:%s:free\\n' \"$phase\" >> " +
      data.timeline +
      "; fi; fi",
    '  case "$phase:$mode" in',
    '    initialize:unavailable) printf \'%s\\n\' \'{"ok":true,"phase":"initialize","kind":"unavailable"}\' ;;',
    '    initialize:*) printf \'%s\\n\' \'{"ok":true,"phase":"initialize","kind":"initialized"}\' ;;',
    "    prepare:batch)",
    '      limit=$(sed -n \'s/.*"limit":\\([0-9]*\\).*/\\1/p\' "$phase_file")',
    "      printf 'prepare-limit:%s\\n' \"$limit\" >> " + data.calls,
    '      printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","items":[{"nodeId":"node-1","preparedToken":"prepared-token-1"},{"nodeId":"node-2","preparedToken":"prepared-token-2"}],"frontierPending":2}\' ;;',
    "    prepare:throttled-after-failure|prepare:yield-after-work)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","items":[{"nodeId":"node-1","preparedToken":"prepared-token-1"},{"nodeId":"node-2","preparedToken":"prepared-token-2"}],"frontierPending":2}\' ;;',
    '    prepare:*) printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","items":[{"nodeId":"node-1","preparedToken":"prepared-token"}],"frontierPending":1}\' ;;',
    "    fetch:*)",
    '      if [ "$mode" = provider-pause ]; then',
    "        printf provider-started >> " + data.timeline,
    "        printf started > " + data.fetchStarted,
    "        while [ ! -e " + data.fetchRelease + " ]; do sleep 0.01; done",
    "      fi",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"fetch","commitToken":"commit-token","operationId":"crawl-op","operationKey":"crawl-key","requestDigest":"digest"}\' ;;',
    "    commit:normal|commit:batch|commit:provider-pause)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"commit","receipt":{"outcome":"committed","state":"committed","result":{"expanded":1,"failed":0,"tracksFound":3,"tracksWritten":3,"tracksSkipped":0,"rateLimited":false}}}\' ;;',
    "    commit:throttled)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"commit","receipt":{"outcome":"committed","state":"committed","result":{"expanded":0,"failed":1,"tracksFound":0,"tracksWritten":0,"tracksSkipped":0,"rateLimited":true}}}\' ;;',
    "    commit:throttled-after-failure)",
    "      count=$(grep -c '^commit:' " + data.calls + ")",
    '      if [ "$count" -eq 1 ]; then rate_limited=false; else rate_limited=true; fi',
    '      printf \'%s\\n\' "{\\"ok\\":true,\\"phase\\":\\"commit\\",\\"receipt\\":{\\"outcome\\":\\"committed\\",\\"state\\":\\"committed\\",\\"result\\":{\\"expanded\\":0,\\"failed\\":1,\\"tracksFound\\":0,\\"tracksWritten\\":0,\\"tracksSkipped\\":0,\\"rateLimited\\":$rate_limited}}}" ;;',
    "    commit:yield-after-work)",
    "      printf committed > " + data.effects,
    '      printf \'%s\\n\' \'{"ok":true,"phase":"commit","receipt":{"outcome":"committed","state":"committed","result":{"expanded":1,"failed":0,"tracksFound":3,"tracksWritten":3,"tracksSkipped":0,"rateLimited":false}}}\' ;;',
    "    commit:lost-success|commit:lost-provider-failure)",
    "      count=0; [ -f " + data.effects + " ] && count=$(wc -l < " + data.effects + ")",
    '      if [ "$count" -eq 0 ]; then',
    "        printf 'effect\\n' >> " + data.effects,
    '        printf \'%s\\n\' \'{"code":"transport","message":"response lost after commit","ok":false}\'',
    "        exit 1",
    "      fi",
    '      if [ "$mode" = lost-success ]; then',
    '        result=\'{"expanded":1,"failed":0,"tracksFound":3,"tracksWritten":3,"tracksSkipped":0,"rateLimited":false}\'',
    "      else",
    '        result=\'{"expanded":0,"failed":1,"tracksFound":0,"tracksWritten":0,"tracksSkipped":0,"rateLimited":false}\'',
    "      fi",
    '      printf \'%s\\n\' "{\\"ok\\":true,\\"phase\\":\\"commit\\",\\"receipt\\":{\\"outcome\\":\\"committed\\",\\"state\\":\\"committed\\",\\"result\\":$result}}" ;;',
    '    *) printf \'%s\\n\' \'{"ok":true,"phase":"unknown"}\' ;;',
    "  esac",
    'elif [[ "$*" == *"admin receipts reconcile"* ]]; then',
    '  printf \'%s\\n\' \'{"receipt":{"outcome":"committed","state":"committed"}}\'',
    "else",
    "  printf 'unexpected fluncle call: %s\\n' \"$*\" >&2; exit 2",
    "fi",
  ].join("\n");
  executable(join(bin, "fluncle"), stub);
  return data;
}

type ProcessResult = { exitCode: number; stderr: string; stdout: string };

async function stopProcessTree(child: Bun.Subprocess): Promise<void> {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ESRCH") {
      child.kill("SIGKILL");
    }
  }
  await child.exited;
}

async function collect(
  process: Bun.Subprocess,
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<ProcessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  const completed = Promise.all([process.exited, stdout, stderr]);
  try {
    const outcome = await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("crawl fixture process deadline exceeded")),
          timeoutMs,
        );
      }),
    ]);
    return { exitCode: outcome[0], stderr: outcome[2], stdout: outcome[1] };
  } catch (error) {
    await stopProcessTree(process);
    await Promise.allSettled([stdout, stderr]);
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForFile(path: string, timeoutMs = PROCESS_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for " + path);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function sweepEnvironment(data: Fixture, mode: string): Record<string, string> {
  writeFileSync(data.mode, mode);
  return {
    ...process.env,
    DATABASE_ADMISSION_RUNNER: data.runner,
    FLUNCLE_BIN: join(data.bin, "fluncle"),
    FLUNCLE_CRAWL_MAX_HOP: "2",
    FLUNCLE_CRAWL_NODES: "1",
    NODE_ENV: "test",
  };
}

describe("crawl-sweep phase protocol", () => {
  test(
    "drives initialize, prepare, fetch, and commit through the direct phase-file service path",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "normal"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        admissionOutcome: "completed",
        checked: 1,
        expanded: 1,
        failed: 0,
        ok: true,
        produced: 1,
        tracksFound: 3,
        tracksWritten: 3,
      });
      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^initialize:/m)).toBeTruthy();
      expect(calls.match(/^prepare:/m)).toBeTruthy();
      expect(calls.match(/^fetch:/m)).toBeTruthy();
      expect(calls.match(/^commit:/m)).toBeTruthy();
      expect(calls).not.toContain("--limit");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "requests a two-item prepare batch when two node slots remain and processes both serially",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "batch"), FLUNCLE_CRAWL_NODES: "2" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 2,
        expanded: 2,
        ok: true,
        tracksWritten: 6,
      });
      const calls = readFileSync(data.calls, "utf8");
      expect(calls).toContain("prepare-limit:2");
      expect(calls.match(/^fetch:/gm)).toHaveLength(2);
      expect(calls.match(/^commit:/gm)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports a disabled cutover without preparing or mutating crawl work",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "unavailable"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        admissionOutcome: "cutover-disabled",
        gateState: "disabled",
        ok: true,
        reason: "crawl_due_cutover_disabled",
      });
      const calls = readFileSync(data.calls, "utf8");
      expect(calls).toContain("initialize:");
      expect(calls).not.toMatch(/^(prepare|fetch|commit):/m);
      expect(existsSync(data.effects)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports an initialize admission yield as paused without claiming work",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "initialize-yield"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        admissionOutcome: "phase-yielded",
        checked: 0,
        gateState: "paused",
        ok: true,
        partial: false,
        produced: 0,
        reason: "database_admission",
        throttled: true,
      });
      expect(existsSync(data.calls)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "counts a rate-limit provider failure as checked backpressure, not failed work",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "throttled"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 1,
        expanded: 0,
        failed: 0,
        ok: true,
        throttled: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "preserves an earlier genuine provider failure when a later node is rate-limited",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: {
            ...sweepEnvironment(data, "throttled-after-failure"),
            FLUNCLE_CRAWL_NODES: "2",
          },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 2,
        expanded: 0,
        failed: 1,
        ok: true,
        throttled: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "marks a later admission yield partial while preserving committed counts",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "yield-after-work"), FLUNCLE_CRAWL_NODES: "2" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        admissionOutcome: "phase-yielded",
        checked: 1,
        gateState: "paused",
        ok: true,
        partial: true,
        produced: 1,
        reason: "database_admission",
        throttled: true,
        tracksWritten: 3,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "lets an unrelated writer acquire the real phase runner while the provider is paused",
    async () => {
      const data = fixture();
      const lock = join(data.directory, "coordinator-lock");
      executable(join(data.bin, "setsid"), 'exec "$@"');
      executable(join(data.bin, "setpriv"), 'shift 2\nexec "$@"');
      executable(
        join(data.bin, "curl"),
        [
          'case "$*" in',
          '  *\'"action":"acquire"\'*)',
          "    if [ -e " + lock + " ]; then",
          '      printf \'%s\\n200\\n\' \'{"enforced":true,"fencingToken":null,"heartbeatAfterMs":1000,"lane":"write","operationId":"fixture","outcome":"queued","queueAgeMs":0,"recovered":false,"waitMs":0,"yieldReason":"queue"}\'',
          "    else",
          "      printf held > " + lock,
          '      printf \'%s\\n200\\n\' \'{"enforced":true,"fencingToken":7,"heartbeatAfterMs":1000,"lane":"write","operationId":"fixture","outcome":"acquired","queueAgeMs":0,"recovered":false,"waitMs":0,"yieldReason":null}\'',
          "    fi ;;",
          '  *\'"action":"release"\'*) rm -f ' + lock + "; printf '%s\\n200\\n' '{\"ok\":true}' ;;",
          '  *\'"action":"cancel"\'*) rm -f ' + lock + "; printf '%s\\n200\\n' '{\"ok\":true}' ;;",
          "  *) printf '%s\\n200\\n' '{}' ;;",
          "esac",
        ].join("\n"),
      );
      const environment = {
        ...sweepEnvironment(data, "provider-pause"),
        COORDINATOR_LOCK: lock,
        DATABASE_ADMISSION_HTTP_TIMEOUT_SECS: "1",
        DATABASE_ADMISSION_KILL_GRACE_SECS: "1",
        DATABASE_ADMISSION_MAX_WAIT_SECS: "5",
        DATABASE_ADMISSION_POLL_SECS: "1",
        DATABASE_ADMISSION_RUNNER: REAL_PHASE_RUNNER,
        FLUNCLE_ADMISSION_RUNNER_PID: "",
        FLUNCLE_API_BASE_URL: "http://fixture.invalid",
        FLUNCLE_API_TOKEN: "fixture-token",
        PATH: data.bin + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
      };
      const sweep = Bun.spawn([process.execPath, SWEEP], {
        detached: true,
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      });
      let writer: Bun.Subprocess | undefined;
      try {
        await waitForFile(data.fetchStarted);
        writer = Bun.spawn(
          [
            "bash",
            REAL_PHASE_RUNNER,
            "phase",
            "unrelated-writer",
            "--",
            "bash",
            "-c",
            "printf writer-completed >> " + data.timeline,
          ],
          { detached: true, env: environment, stderr: "pipe", stdout: "pipe" },
        );
        const writerResult = await collect(writer);
        expect(writerResult.exitCode).toBe(0);
        expect(readFileSync(data.timeline, "utf8")).toContain("writer-completed");
        writeFileSync(data.fetchRelease, "release");
        const sweepResult = await collect(sweep);
        expect(sweepResult.exitCode, sweepResult.stderr).toBe(0);
        expect(JSON.parse(sweepResult.stdout)).toMatchObject({ ok: true, tracksWritten: 3 });
        const timeline = readFileSync(data.timeline, "utf8");
        expect(timeline).toContain("phase-lock:initialize:held");
        expect(timeline).toContain("phase-lock:prepare:held");
        expect(timeline).toContain("phase-lock:fetch:free");
        expect(timeline).toContain("phase-lock:commit:held");
      } finally {
        writeFileSync(data.fetchRelease, "release");
        if (writer?.exitCode === null) {
          await stopProcessTree(writer);
        }
        if (sweep.exitCode === null) {
          await stopProcessTree(sweep);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reconciles a lost committed-success response without duplicating its cached effect",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "lost-success"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        admissionOutcome: "commit-result-reconciled",
        checked: 1,
        expanded: 1,
        reconciledCommits: 1,
        tracksWritten: 3,
      });
      expect(readFileSync(data.effects, "utf8").trim()).toBe("effect");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reconciles a lost committed-provider-failure response without duplicating failure counters",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "lost-provider-failure"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        admissionOutcome: "commit-result-reconciled",
        checked: 1,
        expanded: 0,
        failed: 1,
        reconciledCommits: 1,
        tracksWritten: 0,
      });
      expect(readFileSync(data.effects, "utf8").trim()).toBe("effect");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "runs one inherited legacy pass and never blindly retries its timeout",
    async () => {
      const data = fixture();
      executable(
        join(data.bin, "fluncle"),
        "printf attempt >> " +
          data.calls +
          "\n" +
          "printf '%s\\n' 'The operation timed out' >&2\n" +
          "exit 1",
      );
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "legacy"), FLUNCLE_ADMISSION_RUNNER_PID: "1234" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(data.calls, "utf8").trim()).toBe("attempt");
      expect(result.stderr).toContain("The operation timed out");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects invalid NODES and MAX_HOP before invoking the phase runner",
    async () => {
      for (const [name, override] of [
        ["NODES", { FLUNCLE_CRAWL_NODES: "0" }],
        ["MAX_HOP", { FLUNCLE_CRAWL_MAX_HOP: "4" }],
      ] as const) {
        const data = fixture();
        const result = await collect(
          Bun.spawn([process.execPath, SWEEP], {
            detached: true,
            env: { ...sweepEnvironment(data, "normal"), ...override },
            stderr: "pipe",
            stdout: "pipe",
          }),
        );
        expect(result.exitCode, name).toBe(1);
        expect(JSON.parse(result.stdout), name).toMatchObject({ errors: 1, ok: false });
        expect(existsSync(data.calls), name).toBe(false);
        expect(existsSync(data.effects), name).toBe(false);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
