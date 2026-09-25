import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { blockedReason, recordBoxAttempt } from "./crawl-sweep";

const SWEEP = resolve(import.meta.dirname, "crawl-sweep.ts");
const REAL_PHASE_RUNNER = resolve(import.meta.dirname, "database-admission-runner.sh");
const TEST_TIMEOUT_MS = 20_000;
const PROCESS_TIMEOUT_MS = 8_000;

const CHOREOGRAPHY_TEST_TIMEOUT_MS = 45_000;
const temporaryDirectories: string[] = [];

test("request kinds count every box attempt, including retries, and identify a label-only block", () => {
  const requestsByKind = {
    artist_browse: 0,
    label_browse: 0,
    rearm_probe: 0,
    release_detail: 0,
    seed_search: 0,
  };
  const tally = { boxFetched: 0, requestsByKind };
  const browse = { kind: "single" as const, url: "https://musicbrainz.org/ws/2/release?artist=a" };
  const detail = { kind: "single" as const, url: "https://musicbrainz.org/ws/2/release/r" };
  const stderr = console.error;
  console.error = () => {};
  try {
    recordBoxAttempt(tally, browse, "artist", { outcome: "retry_503", url: browse.url });
    recordBoxAttempt(tally, browse, "artist", { outcome: "body", url: browse.url });
    recordBoxAttempt(tally, detail, "release", { outcome: "body", url: detail.url });
    recordBoxAttempt(tally, detail, undefined, { outcome: "body", url: detail.url });
  } finally {
    console.error = stderr;
  }
  expect(tally.requestsByKind).toMatchObject({ artist_browse: 2, release_detail: 2 });
  expect(Object.values(tally.requestsByKind).reduce((sum, count) => sum + count, 0)).toBe(
    tally.boxFetched,
  );
  expect(
    blockedReason({
      error: null,
      failed: 0,
      ok: true,
      pending: 0,
      reason: null,
      storableReady: false,
      throttled: false,
      tracksFound: 4,
      tracksSkippedLabelGate: 4,
      tracksWritten: 0,
    }),
  ).toBe("label_gate");
  expect(
    blockedReason({
      error: "MusicBrainz request failed",
      failed: 1,
      ok: false,
      pending: 1,
      reason: null,
      storableReady: true,
      throttled: false,
      tracksFound: 0,
      tracksSkippedLabelGate: 0,
      tracksWritten: 0,
    }),
  ).toBeNull();
  expect(
    blockedReason({
      error: null,
      failed: 0,
      ok: true,
      pending: 1,
      reason: null,
      storableReady: true,
      throttled: false,
      tracksFound: 0,
      tracksSkippedLabelGate: 0,
      tracksWritten: 0,
    }),
  ).toBeNull();
});

const COMMIT_BATCH_ALL_COMMITTED =
  '{"ok":true,"deferred":0,"receipts":[{"operationKey":"crawl-key","outcome":"committed","replayed":false,"state":"committed","result":{"expanded":1,"failed":0,"tracksFound":3,"tracksWritten":3,"tracksSkipped":0,"rateLimited":false}},{"operationKey":"crawl-key","outcome":"committed","replayed":false,"state":"committed","result":{"expanded":1,"failed":0,"tracksFound":3,"tracksWritten":3,"tracksSkipped":0,"rateLimited":false}}]}';

const COMMIT_BATCH_POISONED =
  '{"ok":true,"deferred":0,"receipts":[{"operationKey":"crawl-key","outcome":"committed","replayed":false,"state":"committed","result":{"expanded":1,"failed":0,"tracksFound":3,"tracksWritten":3,"tracksSkipped":0,"rateLimited":false}},{"operationKey":"crawl-key","outcome":"failed","replayed":false,"error":"stale claim"}]}';

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
  fetchBody: string;
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
    fetchBody: join(directory, "fetch-body"),
    fetchRelease: join(directory, "fetch-release"),
    fetchStarted: join(directory, "fetch-started"),
    mode: join(directory, "mode"),
    runner: join(directory, "runner"),
    timeline: join(directory, "timeline"),
  };
  writeFileSync(data.mode, "normal");

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
    "    prepare:storable-first)",
    "      count=$(grep -c '^prepare:' " + data.calls + ")",
    '      if [ "$count" -eq 1 ]; then',
    '        printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","items":[{"nodeId":"node-1","preparedToken":"prepared-token-1"}],"frontierPending":1,"storableReady":true}\'',
    "      else",
    '        printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"drained","items":[],"frontierPending":0,"storableReady":false}\'',
    "      fi ;;",
    "    prepare:repair-pending|fetch:repair-pending-fetch)",
    '      printf \'%s\\n\' \'{"code":"due_work_maintenance_pending","message":"Due-work maintenance is still converging","ok":false}\'',
    "      exit 1 ;;",
    "    prepare:commit-batch|prepare:commit-batch-poison)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","capabilities":{"commitBatchLimit":6,"commitBatchMaxTotalBytes":8388608},"items":[{"nodeId":"node-1","preparedToken":"prepared-token-1"},{"nodeId":"node-2","preparedToken":"prepared-token-2"}],"frontierPending":2}\' ;;',
    "    prepare:throttled-after-failure|prepare:yield-after-work)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","items":[{"nodeId":"node-1","preparedToken":"prepared-token-1"},{"nodeId":"node-2","preparedToken":"prepared-token-2"}],"frontierPending":2}\' ;;',
    "    prepare:box-fetch-batch)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","boxFetch":true,"capabilities":{"commitBatchLimit":6,"commitBatchMaxTotalBytes":8388608},"items":[{"nodeId":"node-1","preparedToken":"prepared-token-1","fetchPlan":{"kind":"none"}},{"nodeId":"node-2","preparedToken":"prepared-token-2","fetchPlan":{"kind":"none"}}],"frontierPending":2}\' ;;',
    "    prepare:box-fetch|prepare:box-fetch-off)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","items":[{"nodeId":"node-1","preparedToken":"prepared-token","fetchPlan":{"kind":"none"}}],"frontierPending":1,"boxFetch":true}\' ;;',
    '    prepare:*) printf \'%s\\n\' \'{"ok":true,"phase":"prepare","kind":"prepared","items":[{"nodeId":"node-1","preparedToken":"prepared-token"}],"frontierPending":1}\' ;;',
    "    fetch:*)",
    '      cat "$phase_file" >> ' + data.fetchBody,
    '      if [ "$mode" = provider-pause ]; then',
    "        printf provider-started >> " + data.timeline,
    "        printf started > " + data.fetchStarted,
    "        while [ ! -e " + data.fetchRelease + " ]; do sleep 0.01; done",
    "      fi",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"fetch","commitToken":"commit-token","operationId":"crawl-op","operationKey":"crawl-key","requestDigest":"digest"}\' ;;',
    "    commit:normal|commit:batch|commit:storable-first|commit:provider-pause|commit:box-fetch|commit:box-fetch-off|commit:commit-batch|commit:commit-batch-poison|commit:box-fetch-batch)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"commit","receipt":{"outcome":"committed","state":"committed","result":{"expanded":1,"failed":0,"tracksFound":3,"tracksWritten":3,"tracksSkipped":0,"rateLimited":false}}}\' ;;',
    "    commit:throttle-then-work)",
    "      count=$(grep -c '^commit:' " + data.calls + ")",
    '      if [ "$count" -eq 1 ]; then',
    '        printf \'%s\\n\' \'{"ok":true,"phase":"commit","receipt":{"outcome":"committed","state":"committed","result":{"expanded":0,"failed":1,"tracksFound":0,"tracksWritten":0,"tracksSkipped":0,"rateLimited":true}}}\'',
    "      else",
    '        printf \'%s\\n\' \'{"ok":true,"phase":"commit","receipt":{"outcome":"committed","state":"committed","result":{"expanded":1,"failed":0,"tracksFound":5,"tracksWritten":2,"tracksSkipped":3,"tracksSkippedHeld":1,"tracksSkippedLabelGate":1,"tracksSkippedArtistRule":1,"rateLimited":false}}}\'',
    "      fi ;;",
    "    commit:always-throttled)",
    '      printf \'%s\\n\' \'{"ok":true,"phase":"commit","receipt":{"outcome":"committed","state":"committed","result":{"expanded":0,"failed":1,"tracksFound":0,"tracksWritten":0,"tracksSkipped":0,"rateLimited":true}}}\' ;;',
    "    commit:slow)",
    "      sleep 1.2",
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
    'elif [[ "$*" == *"admin catalogue commit-nodes"* ]]; then',
    "  printf 'commit-nodes\\n' >> " + data.calls + "",
    '  if [ "$mode" = "commit-batch-poison" ]; then',
    "    printf '%s\\n' '" + COMMIT_BATCH_POISONED + "'",
    "  else",
    "    printf '%s\\n' '" + COMMIT_BATCH_ALL_COMMITTED + "'",
    "  fi",
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

function sharedDeadline(budgetMs: number): () => number {
  const expiresAt = Date.now() + budgetMs;
  return () => Math.max(1, expiresAt - Date.now());
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
    "keeps tick-start storable work when a later prepare drains the lane",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "storable-first"), FLUNCLE_CRAWL_NODES: "2" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 1,
        storableReady: true,
        tracksWritten: 3,
      });
      expect(readFileSync(data.calls, "utf8").match(/^prepare:/gm)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "settles a whole claim in ONE admitted commit phase when the Worker advertises the batch",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "commit-batch"), FLUNCLE_CRAWL_NODES: "2" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout);
      expect(summary).toMatchObject({ checked: 2, expanded: 2, ok: true, tracksWritten: 6 });
      const calls = readFileSync(data.calls, "utf8");

      expect(calls.match(/^fetch:/gm)).toHaveLength(2);
      expect(calls.match(/^commit-nodes$/gm)).toHaveLength(1);
      expect(calls.match(/^commit:/gm)).toBeNull();

      expect(summary.leases).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "lets a poisoned item inside a batch fall back alone while its neighbour keeps its receipt",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "commit-batch-poison"), FLUNCLE_CRAWL_NODES: "2" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout);

      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^commit-nodes$/gm)).toHaveLength(1);
      expect(calls.match(/^commit:/gm)).toHaveLength(1);
      expect(summary).toMatchObject({ checked: 2, expanded: 2, ok: true });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "commits node by node against a Worker that advertises no batch (new sweep, old Worker)",
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
      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^commit:/gm)).toHaveLength(2);
      expect(calls).not.toContain("commit-nodes");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "puts every node back on its own commit phase when the kill switch is set",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: {
            ...sweepEnvironment(data, "commit-batch"),
            FLUNCLE_CRAWL_COMMIT_BATCH: "0",
            FLUNCLE_CRAWL_NODES: "2",
          },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^commit:/gm)).toHaveLength(2);
      expect(calls).not.toContain("commit-nodes");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "asks one claim for the whole prepare bound so each node does not pay its own admission",
    async () => {
      const data = fixture();
      await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "batch"), FLUNCLE_CRAWL_NODES: "6" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(readFileSync(data.calls, "utf8")).toContain("prepare-limit:6");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "waits out a throttle and keeps working instead of ending the tick on the first one",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: {
            ...sweepEnvironment(data, "throttle-then-work"),
            FLUNCLE_CRAWL_NODES: "3",
            FLUNCLE_CRAWL_THROTTLE_PAUSE_MS: "0",
          },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 3,
        expanded: 2,
        failed: 0,
        ok: true,
        partial: false,
        throttled: true,
        throttles: 1,

        tracksSkippedArtistRule: 2,
        tracksSkippedHeld: 2,
        tracksSkippedLabelGate: 2,
        tracksWritten: 4,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stops on its throttle budget rather than pushing a wall that will not move",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: {
            ...sweepEnvironment(data, "always-throttled"),
            FLUNCLE_CRAWL_NODES: "20",
            FLUNCLE_CRAWL_THROTTLE_PAUSE_MS: "0",
          },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 3,
        failed: 0,
        ok: true,
        partial: true,
        reason: "musicbrainz_throttle",
        throttled: true,
        throttles: 3,
      });
      expect(readFileSync(data.calls, "utf8").match(/^commit:/gm)).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stops itself on its wall-clock budget instead of being killed mid-node by the unit timeout",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: {
            ...sweepEnvironment(data, "slow"),
            FLUNCLE_CRAWL_NODES: "10",
            FLUNCLE_CRAWL_WALL_BUDGET_MS: "1000",
          },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 1,
        expanded: 1,
        ok: true,
        partial: true,
        reason: "wall_budget",
        tracksWritten: 3,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects an out-of-range throttle pause or wall budget before invoking the phase runner",
    async () => {
      for (const [name, override] of [
        ["pause", { FLUNCLE_CRAWL_THROTTLE_PAUSE_MS: "999999" }],
        ["budget", { FLUNCLE_CRAWL_WALL_BUDGET_MS: "10" }],
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
      }
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
    "reports a due-work repair deferral inside an admitted phase as paused, not failed",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "repair-pending"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 0,
        error: null,
        errors: 0,
        gateState: "paused",
        ok: true,
        partial: false,
        produced: 0,
        reason: "due_work_repair_pending",
        throttled: true,
      });
      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^prepare:/m)).toBeTruthy();
      expect(calls.match(/^fetch:/m)).toBeNull();
      expect(calls.match(/^commit:/m)).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports a due-work repair deferral on the direct provider phase as paused, not failed",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "repair-pending-fetch"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: null,
        errors: 0,
        gateState: "paused",
        ok: true,
        produced: 0,
        reason: "due_work_repair_pending",
        throttled: true,
      });
      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^fetch:/m)).toBeTruthy();
      expect(calls.match(/^commit:/m)).toBeNull();
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

          '  *\'"action":"heartbeat"\'*)',
          '    printf \'%s\\n200\\n\' \'{"enforced":true,"fencingToken":7,"heartbeatAfterMs":1000,"lane":"write","operationId":"fixture","outcome":"acquired","queueAgeMs":0,"recovered":false,"waitMs":0,"yieldReason":null}\' ;;',
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

      const remaining = sharedDeadline(CHOREOGRAPHY_TEST_TIMEOUT_MS - 5_000);
      let writer: Bun.Subprocess | undefined;
      try {
        await waitForFile(data.fetchStarted, remaining());
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
        const writerResult = await collect(writer, remaining());
        expect(writerResult.exitCode).toBe(0);
        expect(readFileSync(data.timeline, "utf8")).toContain("writer-completed");
        writeFileSync(data.fetchRelease, "release");
        const sweepResult = await collect(sweep, remaining());
        expect(sweepResult.exitCode, sweepResult.stderr).toBe(0);
        expect(JSON.parse(sweepResult.stdout)).toMatchObject({ ok: true, tracksWritten: 3 });
        const timeline = readFileSync(data.timeline, "utf8");
        expect(timeline).toContain("phase-lock:initialize:held");
        expect(timeline).toContain("phase-lock:prepare:held");
        expect(timeline).toContain("phase-lock:fetch:free");
        expect(timeline).toContain("phase-lock:commit:held");
      } catch (cause) {
        writeFileSync(data.fetchRelease, "release");
        const account = await Promise.race([
          Promise.all([new Response(sweep.stdout).text(), new Response(sweep.stderr).text()]),
          new Promise<[string, string]>((settle) =>
            setTimeout(() => settle(["<not drained>", "<not drained>"]), 5_000),
          ),
        ]);
        const read = (path: string): string =>
          existsSync(path) ? readFileSync(path, "utf8") : "<none>";

        throw new Error(
          `${cause instanceof Error ? cause.message : String(cause)}\n` +
            `sweep stdout: ${account[0]}\nsweep stderr: ${account[1]}\n` +
            `phase timeline: ${read(data.timeline)}\nCLI calls: ${read(data.calls)}`,
          { cause },
        );
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
    CHOREOGRAPHY_TEST_TIMEOUT_MS,
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

  test(
    "reads the server's box-fetch answer and reports it, supplying nothing for a node with no url",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: sweepEnvironment(data, "box-fetch"),
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        boxFetch: true,
        boxFetched: 0,
        ok: true,
      });

      expect(readFileSync(data.fetchBody, "utf8")).not.toContain('"supplied"');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "runs a whole claim with box-fetch ON and the batched commit ON",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "box-fetch-batch"), FLUNCLE_CRAWL_NODES: "2" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout);
      expect(summary).toMatchObject({
        boxFetch: true,
        checked: 2,
        expanded: 2,
        ok: true,
        tracksWritten: 6,
      });
      const calls = readFileSync(data.calls, "utf8");

      expect(calls.match(/^fetch:/gm)).toHaveLength(2);
      expect(calls.match(/^commit-nodes$/gm)).toHaveLength(1);
      expect(calls.match(/^commit:/gm)).toBeNull();

      expect(summary.leases).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "commits node by node with box-fetch ON and the batched commit OFF",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "box-fetch"), FLUNCLE_CRAWL_NODES: "1" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ boxFetch: true, ok: true });
      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^commit:/gm)).toHaveLength(1);
      expect(calls).not.toContain("commit-nodes");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "batches the commits with box-fetch OFF, leaving the reads on Worker egress",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "commit-batch"), FLUNCLE_CRAWL_NODES: "2" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ boxFetch: false, ok: true });
      const calls = readFileSync(data.calls, "utf8");
      expect(calls.match(/^commit-nodes$/gm)).toHaveLength(1);
      expect(readFileSync(data.fetchBody, "utf8")).not.toContain('"supplied"');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "leaves every read on Worker egress when the box-side switch is off",
    async () => {
      const data = fixture();
      const result = await collect(
        Bun.spawn([process.execPath, SWEEP], {
          detached: true,
          env: { ...sweepEnvironment(data, "box-fetch-off"), FLUNCLE_CRAWL_BOX_FETCH: "0" },
          stderr: "pipe",
          stdout: "pipe",
        }),
      );

      expect(result.exitCode, result.stderr).toBe(0);

      expect(JSON.parse(result.stdout)).toMatchObject({ boxFetch: false, boxFetched: 0, ok: true });
      expect(readFileSync(data.fetchBody, "utf8")).not.toContain('"supplied"');
    },
    TEST_TIMEOUT_MS,
  );
});
