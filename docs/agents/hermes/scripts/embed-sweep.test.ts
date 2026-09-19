// Tests for embed-sweep.ts. The box-script sweep is self-contained (it can't import the workspace)
// and lives outside any package's test runner, so this file uses `bun:test`. Run it from the
// scripts directory so the shared no-network preload is armed:
//
//   bun test --cwd docs/agents/hermes/scripts embed-sweep.test.ts
//
// The pure helpers and the injectable `runEmbedSweep` driver run in-process. The phase protocol
// runs the real script as a child process against a fake admission runner, a fake `fluncle`, a
// fake embedder, and a loopback fixture serving the worklist, the R2 object, and the cost ledger.
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is side-effect
// free (no R2 GET, no embedder spawn, no CLI).
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEmbedFatalSummary,
  buildEmbedSummary,
  chooseEmbedSource,
  DEFAULT_EMBED_BATCH_CAP,
  type EmbedDatabaseWindows,
  type EmbedManifestEntry,
  type EmbedWriteItem,
  type EmbedWriteWindow,
  MAX_EMBED_BATCH_CAP,
  parseEmbedQueue,
  parseQueueWindowEnvelope,
  parseWriteWindowEnvelope,
  resolveEmbedBatchCap,
  runEmbedSweep,
  sourceAudioExt,
} from "./embed-sweep";

const SWEEP = join(import.meta.dir, "embed-sweep.ts");
// Each protocol test spawns the sweep, the fake runner, bun window children, and the fake embedder.
const PROCESS_TEST_TIMEOUT_MS = 30_000;
const temporaryDirectories: string[] = [];
const servers: { stop: (closeActiveConnections?: boolean) => unknown }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("the batch cap env knob", () => {
  test("takes the default when the knob is absent or blank", () => {
    expect(resolveEmbedBatchCap(undefined)).toBe(DEFAULT_EMBED_BATCH_CAP);
    expect(resolveEmbedBatchCap("")).toBe(DEFAULT_EMBED_BATCH_CAP);
    expect(resolveEmbedBatchCap("   ")).toBe(DEFAULT_EMBED_BATCH_CAP);
  });

  test("accepts every integer inside the validated range", () => {
    for (let cap = 1; cap <= MAX_EMBED_BATCH_CAP; cap += 1) {
      expect(resolveEmbedBatchCap(String(cap))).toBe(cap);
    }

    expect(resolveEmbedBatchCap(" 2 ")).toBe(2);
  });

  test("refuses a value that would unbound or empty the batch, keeping the default", () => {
    // Each of these once reached the sweep as a silent `Number()`: a zero-width batch embeds
    // nothing forever, and an unbounded one outruns the unit's derived TimeoutStartSec and is
    // killed mid-forward.
    for (const raw of ["0", "-1", "7", "99", "2.5", "three", "1e3", "NaN", "Infinity"]) {
      expect(resolveEmbedBatchCap(raw), raw).toBe(DEFAULT_EMBED_BATCH_CAP);
    }
  });

  test("keeps the unit's committed batch inside the range its timeout was derived for", () => {
    const unit = readFileSync(
      join(import.meta.dir, "..", "embed-timer", "fluncle-embed.service"),
      "utf8",
    );
    const committed = /-e FLUNCLE_EMBED_BATCH=(\d+)/.exec(unit)?.[1];

    expect(committed).toBeDefined();
    expect(resolveEmbedBatchCap(committed)).toBe(Number(committed));

    // The timeout is the cap's other half: one 120s worklist window, then per track a 300s
    // fetch-and-forward budget plus its own 120s write window, plus 30s of overhead.
    const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)?.[1]);

    expect(timeout).toBeGreaterThanOrEqual(120 + Number(committed) * (300 + 120) + 30);
  });
});

describe("the inference script's cgroup-sized thread pool", () => {
  // embed-track.py's module scope is import-safe (torch and muq are imported inside main), so the
  // quota arithmetic can be read back through a real interpreter. Skipped where python3 is absent.
  const python = Bun.which("python3");
  const threadsFor = (cpuMax: string | null): number => {
    if (python === null) {
      throw new Error("python3 unavailable");
    }

    const directory = mkdtempSync(join(tmpdir(), "fluncle-embed-cgroup-"));
    temporaryDirectories.push(directory);
    const cpuMaxPath = join(directory, "cpu.max");

    if (cpuMax !== null) {
      writeFileSync(cpuMaxPath, cpuMax);
    }

    const result = Bun.spawnSync({
      cmd: [
        python,
        "-c",
        [
          "import importlib.util, os",
          `spec = importlib.util.spec_from_file_location("embed_track", ${JSON.stringify(join(import.meta.dir, "embed-track.py"))})`,
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "print(module.torch_thread_count(), os.cpu_count())",
        ].join("\n"),
      ],
      env: { ...process.env, MUQ_CPU_MAX_PATH: cpuMaxPath },
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const [threads] = result.stdout.toString().trim().split(" ");

    return Number(threads);
  };

  test.skipIf(python === null)("floors a fractional quota into whole CPUs", () => {
    expect(threadsFor("250000 100000")).toBe(2);
    expect(threadsFor("300000 100000")).toBe(3);
    // A sub-1.0 quota still gets one thread — there is no half a thread.
    expect(threadsFor("50000 100000")).toBe(1);
  });

  test.skipIf(python === null)("falls back to the host count when uncapped or unreadable", () => {
    const hostThreads = threadsFor("max 100000");

    expect(hostThreads).toBeGreaterThanOrEqual(1);
    // A missing file (a bare host, a GPU pod, macOS) reads the same as an uncapped one.
    expect(threadsFor(null)).toBe(hostThreads);
    expect(threadsFor("not-a-quota 100000")).toBe(hostThreads);
  });
});

describe("embed-sweep canonical counters", () => {
  test("counts the attempted batch, successful write-backs, and every continued item failure", () => {
    const summary = buildEmbedSummary({
      checked: 6,
      counts: { done: 2, failed: 1, fetchFailed: 1, noSource: 1, skipped: 1 },
      errors: 0,
      ok: true,
      queued: 10,
    });

    expect(summary).toMatchObject({
      checked: 6,
      embedFailed: 1,
      errors: 0,
      failed: 4,
      produced: 2,
      queue_depth: 8,
      queued: 10,
    });
  });

  test("preserves an authoritative queued:0 and measured checked:0 as zero", () => {
    const summary = buildEmbedSummary({
      checked: 0,
      counts: { done: 0, failed: 0, fetchFailed: 0, noSource: 0, skipped: 0 },
      errors: 0,
      ok: true,
      queued: 0,
    });

    expect(summary.checked).toBe(0);
    expect(summary.queue_depth).toBe(0);
    expect(summary.produced).toBe(0);
  });

  test("omits queue_depth when the server did not return an authoritative count", () => {
    const summary = buildEmbedSummary({
      checked: 1,
      counts: { done: 0, failed: 0, fetchFailed: 1, noSource: 0, skipped: 0 },
      errors: 0,
      ok: true,
    });

    expect(summary).not.toHaveProperty("queue_depth");
  });

  test("batch-level embed fallout is a run error, not a set of item failures", () => {
    const summary = buildEmbedSummary({
      batchFallout: 3,
      checked: 3,
      counts: { done: 0, failed: 0, fetchFailed: 0, noSource: 0, skipped: 3 },
      errors: 1,
      ok: false,
      queued: 20,
      reason: "embed_failed",
    });

    expect(summary).toMatchObject({
      checked: 3,
      errors: 1,
      failed: 0,
      produced: 0,
      queue_depth: 20,
      skipped: 3,
    });
  });

  test("a fatal/config-level failure does not guess item counters", () => {
    expect(buildEmbedFatalSummary(new Error("queue unavailable"))).toMatchObject({
      checked: null,
      errors: 1,
      failed: null,
      produced: null,
    });
  });
});

describe("chooseEmbedSource", () => {
  test("embeds a finding with both a trackId and a captured key", () => {
    const source = chooseEmbedSource({
      logId: "004.7.2I",
      sourceAudioKey: "004.7.2I/abc123.webm",
      trackId: "track-1",
    });

    expect(source).toEqual({ key: "004.7.2I/abc123.webm", kind: "embed", trackId: "track-1" });
  });

  test("skips a finding with no captured full song — NEVER falls back to the preview", () => {
    // The queue is key-gated upstream, so this is the defensive path: no source_audio_key →
    // leave it queued, never preview-embed (the blind preview vectors are the thing we kill).
    const source = chooseEmbedSource({ logId: "004.7.2I", trackId: "track-1" });

    expect(source).toEqual({ kind: "skip", reason: "no_source_audio" });
  });

  test("skips a finding with no trackId (there is nothing to write the vector back to)", () => {
    const source = chooseEmbedSource({ logId: "004.7.2I", sourceAudioKey: "004.7.2I/abc.webm" });

    expect(source).toEqual({ kind: "skip", reason: "no_track_id" });
  });

  test("an empty-string key is treated as absent (skip, not embed)", () => {
    const source = chooseEmbedSource({ sourceAudioKey: "", trackId: "track-1" });

    expect(source).toEqual({ kind: "skip", reason: "no_source_audio" });
  });
});

describe("parseEmbedQueue", () => {
  test("reports the server's whole-backlog count, not the capped page length", () => {
    const tracks = Array.from({ length: 50 }, (_, index) => ({
      sourceAudioKey: `audio/${index}.webm`,
      trackId: `track-${index}`,
    }));

    expect(parseEmbedQueue({ queued: 913, tracks })).toEqual({ queued: 913, tracks });
  });

  test("omits the gauge when the server does not provide a trustworthy count", () => {
    expect(parseEmbedQueue({ tracks: [{ trackId: "track-1" }] })).toEqual({
      tracks: [{ trackId: "track-1" }],
    });
  });
});

describe("sourceAudioExt", () => {
  test("returns the captured container's extension, lowercased, with the leading dot", () => {
    expect(sourceAudioExt("004.7.2I/abc123.webm")).toBe(".webm");
    expect(sourceAudioExt("F-0001/deadbeef.OPUS")).toBe(".opus");
    expect(sourceAudioExt("010.2.9Z/hash.m4a")).toBe(".m4a");
  });

  test("falls back to .audio when the key has no usable extension", () => {
    // ffmpeg decodes by content, so the extension is hygiene, not load-bearing.
    expect(sourceAudioExt("004.7.2I/noext")).toBe(".audio");
    expect(sourceAudioExt("004.7.2I/trailingdot.")).toBe(".audio");
  });

  test("does not mistake a dotted logId directory for the extension", () => {
    // The logId "004.7.2I" carries dots, but the ext is parsed from the basename after the
    // last slash, so those dots never leak into the extension.
    expect(sourceAudioExt("004.7.2I/abcdef.mp3")).toBe(".mp3");
  });
});

describe("database window envelopes", () => {
  test("a queue envelope carries the worklist and its authoritative count", () => {
    expect(
      parseQueueWindowEnvelope(
        JSON.stringify({ kind: "queue", queued: 3, tracks: [{ trackId: "track-1" }] }),
      ),
    ).toEqual({ kind: "queue", queued: 3, tracks: [{ trackId: "track-1" }] });
  });

  test("the typed due-work deferral crosses the window boundary as data", () => {
    expect(
      parseQueueWindowEnvelope(JSON.stringify({ kind: "repair-pending", message: "deferred" })),
    ).toEqual({ kind: "repair-pending", message: "deferred" });
  });

  test("a failed window surfaces the child's own error message", () => {
    expect(() =>
      parseWriteWindowEnvelope(
        JSON.stringify({ error: "queue read failed (500)", kind: "failed" }),
      ),
    ).toThrow("queue read failed (500)");
  });

  test("a malformed write envelope is a run failure, never a counted write", () => {
    expect(() =>
      parseWriteWindowEnvelope(JSON.stringify({ costWriteFailures: 0, kind: "write" })),
    ).toThrow("invalid envelope");
    expect(() => parseWriteWindowEnvelope("not json")).toThrow("invalid envelope");
    expect(
      parseWriteWindowEnvelope('{"costWriteFailures":1,"kind":"write","written":true}'),
    ).toEqual({ costWriteFailures: 1, written: true });
  });
});

// ---------------------------------------------------------------------------
// The driver, in-process, with fake database windows.
// ---------------------------------------------------------------------------

type DriverOptions = {
  batchCap: number;
  embedCode?: number;
  embedErrors?: readonly string[];
  queue?: "tracks" | "yield";
  queued?: number;
  trackIds: readonly string[];
  write: (item: EmbedWriteItem) => EmbedWriteWindow | undefined;
};

async function driveSweep(options: DriverOptions) {
  const timeline: string[] = [];
  const writeCalls: string[] = [];
  const embedErrors = new Set(options.embedErrors ?? []);
  const windows: EmbedDatabaseWindows = {
    readQueue: () => {
      timeline.push("read");
      if (options.queue === "yield") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        kind: "queue",
        ...(options.queued === undefined ? {} : { queued: options.queued }),
        tracks: options.trackIds.map((trackId) => ({
          sourceAudioKey: `catalogue/${trackId}.webm`,
          trackId,
        })),
      });
    },
    writeResult: (item) => {
      timeline.push(`write:${item.trackId}`);
      writeCalls.push(item.trackId);
      return Promise.resolve(options.write(item));
    },
  };
  const outcome = await runEmbedSweep({
    batchCap: options.batchCap,
    embed: (manifest: EmbedManifestEntry[]) => {
      timeline.push("inference");
      return {
        code: options.embedCode ?? 0,
        stderr: "",
        stdout: JSON.stringify({
          errors: manifest
            .filter(({ id }) => embedErrors.has(id))
            .map(({ id }) => ({ error: "decode failed", id })),
          results: manifest
            .filter(({ id }) => !embedErrors.has(id))
            .map(({ id }) => ({ embedding: [0.25, 0.5], id })),
        }),
      };
    },
    fetchSourceAudio: (key) => {
      timeline.push(`audio:${key}`);
      return Promise.resolve(new Uint8Array([82, 73, 70, 70]));
    },
    windows,
  });

  return { outcome, timeline, writeCalls };
}

describe("runEmbedSweep", () => {
  test("a yield mid-batch keeps measured counts, reports unapplied results, and starts no later write", async () => {
    const { outcome, timeline, writeCalls } = await driveSweep({
      batchCap: 4,
      embedErrors: ["track-d"],
      queued: 10,
      trackIds: ["track-a", "track-b", "track-c", "track-d"],
      write: (item) =>
        item.trackId === "track-a" ? { costWriteFailures: 0, written: true } : undefined,
    });

    // Fetch and inference run between the two database windows; the yielded write for track-b is
    // never re-issued and track-c's write never starts.
    expect(timeline).toEqual([
      "read",
      "audio:catalogue/track-a.webm",
      "audio:catalogue/track-b.webm",
      "audio:catalogue/track-c.webm",
      "audio:catalogue/track-d.webm",
      "inference",
      "write:track-a",
      "write:track-b",
    ]);
    expect(writeCalls).toEqual(["track-a", "track-b"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toMatchObject({
      admissionOutcome: "phase-yielded",
      checked: 4,
      done: 1,
      embedFailed: 1,
      errors: 0,
      failed: 1,
      gateState: "paused",
      ok: true,
      partial: true,
      produced: 1,
      queue_depth: 9,
      queued: 10,
      reason: "database_admission",
      throttled: true,
      writesPending: 2,
    });
  });

  test("a failed write is counted once and the batch continues without re-issuing it", async () => {
    const { outcome, writeCalls } = await driveSweep({
      batchCap: 2,
      queued: 2,
      trackIds: ["track-a", "track-b"],
      write: (item) =>
        item.trackId === "track-a"
          ? { costWriteFailures: 1, written: false }
          : { costWriteFailures: 0, written: true },
    });

    expect(writeCalls).toEqual(["track-a", "track-b"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toMatchObject({
      costWriteFailures: 1,
      done: 1,
      errors: 0,
      failed: 1,
      ok: true,
      produced: 1,
      skipped: 1,
    });
    expect(outcome.summary).not.toHaveProperty("gateState");
    expect(outcome.summary).not.toHaveProperty("writesPending");
  });

  test("a yielded worklist window reads nothing, fetches nothing, and pauses", async () => {
    const { outcome, timeline, writeCalls } = await driveSweep({
      batchCap: 1,
      queue: "yield",
      trackIds: ["track-a"],
      write: () => ({ costWriteFailures: 0, written: true }),
    });

    expect(timeline).toEqual(["read"]);
    expect(writeCalls).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toMatchObject({
      admissionOutcome: "phase-yielded",
      checked: 0,
      errors: 0,
      gateState: "paused",
      ok: true,
      produced: 0,
      reason: "database_admission",
    });
  });

  test("a batch-level embedder failure opens no write window and fails the run", async () => {
    const { outcome, writeCalls } = await driveSweep({
      batchCap: 1,
      embedCode: 1,
      queued: 4,
      trackIds: ["track-a"],
      write: () => ({ costWriteFailures: 0, written: true }),
    });

    expect(writeCalls).toEqual([]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary).toMatchObject({
      errors: 1,
      ok: false,
      produced: 0,
      reason: "embed_failed",
      skipped: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// The phase protocol, end to end, against a fake runner and a loopback fixture.
// ---------------------------------------------------------------------------

type ProtocolOptions = {
  fluncle?: "ok" | "timeout";
  inheritedRunner?: boolean;
  queue?: "pending" | "tracks";
  runner?: "fence-write" | "run" | "yield-write";
};

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/usr/bin/env bash\nset -uo pipefail\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

async function runProtocol(options: ProtocolOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "embed-sweep-protocol-"));
  temporaryDirectories.push(directory);
  const timeline = join(directory, "timeline");
  const updates = join(directory, "updates");
  const mark = (line: string) => appendFileSync(timeline, `${line}\n`);

  const server = Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/admin/tracks/work") {
        mark("queue");
        if (options.queue === "pending") {
          return Response.json(
            {
              code: "due_work_maintenance_pending",
              message: "Due-work maintenance is still converging",
              ok: false,
            },
            { status: 503 },
          );
        }
        return Response.json({
          queued: 7,
          tracks: [
            {
              certified: false,
              logId: null,
              sourceAudioKey: "catalogue/track-1.webm",
              trackId: "track-1",
            },
          ],
        });
      }
      if (url.pathname === "/fluncle-source-audio/catalogue/track-1.webm") {
        mark("audio");
        return new Response(new Uint8Array([82, 73, 70, 70]));
      }
      if (url.pathname === "/api/v1/admin/costs/events" && request.method === "POST") {
        mark("cost");
        return Response.json({ inserted: 1, ok: true });
      }
      return new Response("unexpected fixture request", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const runnerMode = options.runner ?? "run";

  // The fake runner records each lease around its command. `yield-write` exits 75 before a write
  // window starts; `fence-write` runs the write command and then reports the lease as lost.
  const runner = executable(
    join(directory, "runner"),
    `[ "$1" = "phase" ] && shift
shift
[ "\${1:-}" = "--" ] && shift
case " $* " in
  *" --admission-phase read "*) label=read ;;
  *" --admission-phase write "*) label=write ;;
  *) printf 'unexpected phase: %s\\n' "$*" >&2; exit 2 ;;
esac
if [ "$label" = write ] && [ "${runnerMode}" = yield-write ]; then
  printf 'write-yielded\\n' >> "${timeline}"
  exit 75
fi
printf 'acquire\\n%s\\n' "$label" >> "${timeline}"
"$@"
status="$?"
if [ "$label" = write ] && [ "${runnerMode}" = fence-write ]; then
  printf 'fenced\\n' >> "${timeline}"
  exit 75
fi
printf 'release\\n' >> "${timeline}"
exit "$status"`,
  );
  const updateOutcome =
    options.fluncle === "timeout"
      ? `printf 'The operation timed out\\n' >&2; exit 1`
      : `printf '{"ok":true}\\n'`;
  const fluncle = executable(
    join(directory, "fluncle"),
    `case " $* " in
  *" admin tracks update "*)
    printf 'update\\n' >> "${timeline}"
    printf '%s\\n' "$4" >> "${updates}"
    ${updateOutcome}
    ;;
  *) printf 'unexpected fluncle call: %s\\n' "$*" >&2; exit 2 ;;
esac`,
  );
  const embedder = join(directory, "embed-track.ts");
  writeFileSync(
    embedder,
    `import { appendFileSync, statSync } from "node:fs";
const manifest = JSON.parse(await Bun.stdin.text()) as { id: string; path: string }[];
for (const entry of manifest) {
  if (statSync(entry.path).size === 0) {
    process.exit(3);
  }
}
appendFileSync(${JSON.stringify(timeline)}, "inference\\n");
console.log(JSON.stringify({ errors: [], results: manifest.map(({ id }) => ({ embedding: [0.25, 0.5], id })) }));
`,
    "utf8",
  );

  const sweep = Bun.spawn([process.execPath, SWEEP], {
    env: {
      ...process.env,
      DATABASE_ADMISSION_RUNNER: runner,
      FLUNCLE_ADMISSION_RUNNER_PID: options.inheritedRunner ? "4242" : "",
      FLUNCLE_API_BASE_URL: base,
      FLUNCLE_API_TOKEN: "fixture-token",
      FLUNCLE_BIN: fluncle,
      FLUNCLE_EMBED_SCRIPT: embedder,
      FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID: "fixture-access-key",
      FLUNCLE_SOURCE_AUDIO_R2_BUCKET: "fluncle-source-audio",
      FLUNCLE_SOURCE_AUDIO_R2_ENDPOINT: base,
      FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY: "fixture-secret-key",
      HOME: join(directory, "home"),
      PYTHON_BIN: process.execPath,
      R2_ACCOUNT_ID: "fixture-account",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(sweep.stdout).text(),
    new Response(sweep.stderr).text(),
    sweep.exited,
  ]);
  let summary: Record<string, unknown>;
  try {
    summary = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`sweep printed no JSON summary (exit ${exitCode}): ${stderr}`);
  }

  return { exitCode, stderr, summary, timeline: lines(timeline), writes: lines(updates) };
}

describe("embed-sweep phased admission protocol", () => {
  test(
    "holds admission around the worklist read and the write, never the audio fetch or MuQ inference",
    async () => {
      const result = await runProtocol();

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.timeline).toEqual([
        "acquire",
        "read",
        "queue",
        "release",
        "audio",
        "inference",
        "acquire",
        "write",
        "update",
        "cost",
        "release",
      ]);
      expect(result.writes).toEqual(["track-1"]);
      expect(result.summary).toMatchObject({
        checked: 1,
        costWriteFailures: 0,
        done: 1,
        embedFailed: 0,
        errors: 0,
        failed: 0,
        ok: true,
        produced: 1,
        queue_depth: 6,
        queued: 7,
      });
      expect(result.summary).not.toHaveProperty("gateState");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "a typed due-work deferral pauses the tick inside the worklist window",
    async () => {
      const result = await runProtocol({ queue: "pending" });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.timeline).toEqual(["acquire", "read", "queue", "release"]);
      expect(result.writes).toEqual([]);
      expect(result.summary).toMatchObject({
        checked: 0,
        errors: 0,
        gateState: "paused",
        ok: true,
        partial: false,
        produced: 0,
        reason: "due_work_repair_pending",
        throttled: true,
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "a write window fenced after its command leaves the write unproven and never replays it",
    async () => {
      const result = await runProtocol({ runner: "fence-write" });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.timeline).toEqual([
        "acquire",
        "read",
        "queue",
        "release",
        "audio",
        "inference",
        "acquire",
        "write",
        "update",
        "cost",
        "fenced",
      ]);
      expect(result.writes).toEqual(["track-1"]);
      expect(result.summary).toMatchObject({
        admissionOutcome: "phase-yielded",
        checked: 1,
        done: 0,
        errors: 0,
        gateState: "paused",
        ok: true,
        partial: true,
        produced: 0,
        queue_depth: 7,
        reason: "database_admission",
        throttled: true,
        writesPending: 1,
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "a write window that yields before starting applies nothing and stops the run",
    async () => {
      const result = await runProtocol({ runner: "yield-write" });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.timeline).toEqual([
        "acquire",
        "read",
        "queue",
        "release",
        "audio",
        "inference",
        "write-yielded",
      ]);
      expect(result.writes).toEqual([]);
      expect(result.summary).toMatchObject({
        gateState: "paused",
        produced: 0,
        reason: "database_admission",
        writesPending: 1,
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "an update with an unknown transport outcome is counted once and never re-issued",
    async () => {
      const result = await runProtocol({ fluncle: "timeout" });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.timeline).toEqual([
        "acquire",
        "read",
        "queue",
        "release",
        "audio",
        "inference",
        "acquire",
        "write",
        "update",
        "cost",
        "release",
      ]);
      expect(result.writes).toEqual(["track-1"]);
      expect(result.stderr).toContain("write-back failed");
      expect(result.summary).toMatchObject({
        done: 0,
        errors: 0,
        failed: 1,
        ok: true,
        produced: 0,
        skipped: 1,
      });
      expect(result.summary).not.toHaveProperty("writesPending");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "an inherited whole-lifetime runner keeps the single-lease path and never nests admission",
    async () => {
      const result = await runProtocol({ inheritedRunner: true });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.timeline).toEqual(["queue", "audio", "inference", "update", "cost"]);
      expect(result.writes).toEqual(["track-1"]);
      expect(result.summary).toMatchObject({
        checked: 1,
        costWriteFailures: 0,
        done: 1,
        errors: 0,
        ok: true,
        produced: 1,
        queue_depth: 6,
        queued: 7,
      });
      expect(result.summary).not.toHaveProperty("admissionOutcome");
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});
