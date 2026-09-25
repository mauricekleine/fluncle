import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RUN_EVENT_ENDPOINT } from "./api-surface";
import {
  cronCheck,
  findJsonSummary,
  judgeCron,
  markerStrain,
  probeSweepStrain,
  STDERR_DELIMITER,
} from "./fluncle-healthcheck";

const HELPER = join(import.meta.dir, "cron-output.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

type EmitOptions = { env?: Record<string, string>; sharedRoot?: string };
type EmitResult = { code: number; dir: string; marker: string; stderr: string; stdout: string };

function writeRunner(
  job: string,
  payload: string,
  options: EmitOptions = {},
): { outputDir: string; script: string } {
  const root = options.sharedRoot ?? mkdtempSync(join(tmpdir(), "fluncle-cron-output-"));
  if (options.sharedRoot === undefined) {
    temporaryDirectories.push(root);
  }
  const outputDir = join(root, "output");
  const script = join(root, "run.sh");

  const payloadPath = join(root, "payload.sh");

  writeFileSync(payloadPath, `#!/usr/bin/env bash\n${payload}\n`, "utf8");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",

      "set -euo pipefail",
      "unset FLUNCLE_API_TOKEN FLUNCLE_API_BASE_URL",
      `export HEALTHCHECK_CRON_OUTPUT_DIR=${JSON.stringify(outputDir)}`,

      `export HOME=${JSON.stringify(join(root, "home"))}`,
      ...Object.entries(options.env ?? {}).map(
        ([key, value]) => `export ${key}=${JSON.stringify(value)}`,
      ),
      `. ${JSON.stringify(HELPER)}`,
      `emit_cron_output ${job} -- bash ${JSON.stringify(payloadPath)}`,
    ].join("\n"),
    "utf8",
  );

  return { outputDir, script };
}

function readNewestMarker(outputDir: string, job: string): { dir: string; marker: string } {
  const dir = join(outputDir, `fluncle-${job}`);
  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort();
  const newest = files.at(-1) ?? "";

  return { dir, marker: readFileSync(join(dir, newest), "utf8") };
}

function emit(job: string, payload: string, options: EmitOptions = {}): EmitResult {
  const { outputDir, script } = writeRunner(job, payload, options);
  const run = spawnSync("bash", [script], { encoding: "utf8" });

  return {
    code: run.status ?? -1,
    ...readNewestMarker(outputDir, job),
    stderr: run.stderr,
    stdout: run.stdout,
  };
}

async function emitAsync(
  job: string,
  payload: string,
  options: EmitOptions = {},
): Promise<EmitResult> {
  const { outputDir, script } = writeRunner(job, payload, options);
  const proc = Bun.spawn(["bash", script], { stderr: "pipe", stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;

  return { code, ...readNewestMarker(outputDir, job), stderr, stdout };
}

const REAL_ERROR_LINE =
  "[entity-bio-sweep] future-signal: the voice gate / length rejected the bio — skipping (stays queued)";
const REAL_BENIGN_LINE = "[embed-sweep] mb_<id>: embedded + written";

describe("emit_cron_output — the marker's shape", () => {
  test("a live rebake still skips an ordinary payload before it can write a marker", () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-cron-rebake-"));
    temporaryDirectories.push(root);
    const payloadMarker = join(root, "payload-started");
    const { outputDir, script } = writeRunner(
      "backup",
      `printf started > ${JSON.stringify(payloadMarker)}`,
      { sharedRoot: root },
    );

    writeFileSync(join(dirname(outputDir), "rebake.lock"), "live rebake\n");
    const run = spawnSync("bash", [script], { encoding: "utf8" });

    expect(run.status).toBe(0);
    expect(existsSync(payloadMarker)).toBe(false);
    expect(existsSync(join(outputDir, "fluncle-backup"))).toBe(false);
  });

  test("captures the sweep's stdout summary, as it always did", () => {
    const { marker } = emit("backup", `echo '{"ok":true,"tableCount":74}'`);

    expect(marker.startsWith("# Cron Job: fluncle-backup\n\n")).toBe(true);
    expect(findJsonSummary(marker)).toEqual({ ok: true, tableCount: 74 });
  });

  test("a silent sweep writes NO delimiter — the old marker shape is unchanged", () => {
    const { marker } = emit("backup", `echo '{"ok":true}'`);

    expect(marker).not.toContain(STDERR_DELIMITER);
    expect(marker).toBe('# Cron Job: fluncle-backup\n\n{"ok":true}\n');
  });

  test("PLUMBING: a real stderr error line reaches the marker AND scores strain", () => {
    const { marker } = emit(
      "artist-bio",
      `echo ${JSON.stringify(REAL_ERROR_LINE)} >&2; echo '{"ok":true,"authored":0,"failed":0,"gateSkipped":1}'`,
    );

    expect(marker).toContain(STDERR_DELIMITER);
    expect(marker).toContain(REAL_ERROR_LINE);

    expect(findJsonSummary(marker)).toEqual({ authored: 0, failed: 0, gateSkipped: 1, ok: true });

    expect(markerStrain(marker)).toBe(1);
  });

  test("PLUMBING: benign chatter reaches the marker and scores NOTHING", () => {
    const { marker } = emit(
      "embed",
      `echo ${JSON.stringify(REAL_BENIGN_LINE)} >&2; echo '{"ok":true,"embedded":3}'`,
    );

    expect(marker).toContain(REAL_BENIGN_LINE);
    expect(markerStrain(marker)).toBe(0);
  });

  test("stderr still streams to journald as well as landing in the marker", () => {
    const { marker, stderr } = emit("crawl", `echo 'boom failed' >&2; echo '{"ok":true}'`);

    expect(stderr).toContain("boom failed");
    expect(marker).toContain("> boom failed");
  });

  test("the tail is blockquoted so a stderr JSON line can never pose as the summary", () => {
    const { marker } = emit(
      "note",
      `echo '{"ok":false,"reason":"this is a log line, not the summary"}' >&2; echo '{"ok":true,"noted":2}'`,
    );

    expect(marker).toContain('> {"ok":false');

    expect(findJsonSummary(marker)).toEqual({ noted: 2, ok: true });
  });

  test("the tail is bounded to the newest CRON_OUTPUT_STDERR_LINES lines", () => {
    const { marker } = emit(
      "enrich",
      `for i in $(seq 1 260); do echo "line $i failed" >&2; done; echo '{"ok":true}'`,
    );

    const quoted = marker.split("\n").filter((line) => line.startsWith("> "));

    expect(quoted).toHaveLength(200);
    expect(quoted.at(-1)).toBe("> line 260 failed");
    expect(marker).not.toContain("line 60 failed");
  });

  test("the payload's exit code survives the tee pipeline", () => {
    const { code, marker } = emit("crawl", `echo 'crawl pass failed' >&2; exit 17`);

    expect(code).toBe(17);

    expect(findJsonSummary(marker)).toBeNull();

    expect(marker).toContain("crawl pass failed");
  });

  test("the delimiter is the same string on both sides of the contract", () => {
    const shell = readFileSync(HELPER, "utf8");

    expect(shell).toContain(`CRON_OUTPUT_STDERR_DELIMITER='${STDERR_DELIMITER}'`);
  });
});

type LedgerCall = { auth: string; body: string; method: string; path: string };
type LedgerRecord = {
  ended_at: string;
  exit_code: number;
  started_at: string;
  summary_raw: string;
  unit: string;
};

type LedgerMode = "accepts" | "hangs" | "notFound" | "rejects";

async function withLedger<T>(
  mode: LedgerMode,
  body: (base: string, calls: LedgerCall[]) => Promise<T>,
): Promise<T> {
  const calls: LedgerCall[] = [];
  const server = Bun.serve({
    async fetch(request) {
      calls.push({
        auth: request.headers.get("authorization") ?? "",
        body: await request.text(),
        method: request.method,
        path: new URL(request.url).pathname,
      });

      if (mode === "hangs") {
        await new Promise(() => {});
      }

      if (mode === "rejects") {
        return Response.json({ error: "nope" }, { status: 500 });
      }

      if (mode === "notFound") {
        return Response.json({ error: "not found" }, { status: 404 });
      }

      return Response.json({ inserted: 1, ok: true });
    },
    port: 0,
  });

  try {
    return await body(`http://127.0.0.1:${server.port}`, calls);
  } finally {
    await server.stop(true);
  }
}

const ledgerEnv = (base: string, extra: Record<string, string> = {}) => ({
  FLUNCLE_API_BASE_URL: base,
  FLUNCLE_API_TOKEN: "fixture-agent-token",
  ...extra,
});

function recordOf(calls: LedgerCall[]): LedgerRecord {
  const call = calls[0];

  if (!call) {
    throw new Error("the ledger received no request at all");
  }

  return JSON.parse(call.body) as LedgerRecord;
}

describe("emit_cron_output — the run-ledger POST", () => {
  test("posts the run record: the agent bearer, the path, and the five fields", async () => {
    const { calls, code } = await withLedger("accepts", async (base, calls) => {
      const run = await emitAsync("backup", `echo '{"ok":true,"tableCount":74}'`, {
        env: ledgerEnv(base),
      });

      return { calls, code: run.code };
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(RUN_EVENT_ENDPOINT);
    expect(calls[0]?.auth).toBe("Bearer fixture-agent-token");

    const record = recordOf(calls);

    expect(record.unit).toBe("fluncle-backup");
    expect(record.exit_code).toBe(0);
    expect(record.summary_raw).toBe('{"ok":true,"tableCount":74}');
    expect(record.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(record.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    expect(Object.keys(record).sort()).toEqual([
      "ended_at",
      "exit_code",
      "started_at",
      "summary_raw",
      "unit",
    ]);
  });

  test("THE BODY CARRIES NO `ok` — the Worker derives it, and cannot be told otherwise", async () => {
    const { calls } = await withLedger("accepts", async (base, calls) => {
      await emitAsync("sentry-triage", `echo '{"ok":true,"errors":2,"triaged":0}'`, {
        env: ledgerEnv(base),
      });

      return { calls };
    });

    const record = recordOf(calls);

    expect(record.summary_raw).toBe('{"ok":true,"errors":2,"triaged":0}');
    expect("ok" in record).toBe(false);
    expect(JSON.parse(record.summary_raw)).toMatchObject({ errors: 2, ok: true });
  });

  test("summary_raw is the LAST NON-EMPTY stdout line, not the first and not a blank", async () => {
    const { calls } = await withLedger("accepts", async (base, calls) => {
      await emitAsync(
        "crawl",
        [
          "echo 'starting the pass'",
          `echo '{"ok":true,"crawled":3}'`,
          "echo ''",
          "echo '   '",
        ].join("\n"),
        { env: ledgerEnv(base) },
      );

      return { calls };
    });

    expect(recordOf(calls).summary_raw).toBe('{"ok":true,"crawled":3}');
  });

  test("a stderr log line can never pose as the summary", async () => {
    const { calls } = await withLedger("accepts", async (base, calls) => {
      await emitAsync(
        "note",
        [
          `echo '{"ok":false,"reason":"a log line, not the summary"}' >&2`,
          `echo '{"ok":true,"noted":2}'`,
        ].join("\n"),
        { env: ledgerEnv(base) },
      );

      return { calls };
    });

    expect(recordOf(calls).summary_raw).toBe('{"ok":true,"noted":2}');
  });

  test("the exit code travels, so a failed run is a row rather than a silence", async () => {
    const { calls, code } = await withLedger("accepts", async (base, calls) => {
      const run = await emitAsync("crawl", `echo 'crawl pass failed' >&2; exit 17`, {
        env: ledgerEnv(base),
      });

      return { calls, code: run.code };
    });

    expect(code).toBe(17);

    const record = recordOf(calls);

    expect(record.exit_code).toBe(17);

    expect(record.summary_raw).toBe("");
  });

  test("a summary carrying quotes, backslashes and a raw tab still arrives as valid JSON", async () => {
    const messy = '{"ok":true,"note":"he said "go"","win":"C:\\tmp","tab":"a\tb"}';
    const { calls } = await withLedger("accepts", async (base, calls) => {
      await emitAsync("enrich", ["cat <<'PAYLOAD_EOF'", messy, "PAYLOAD_EOF"].join("\n"), {
        env: ledgerEnv(base),
      });

      return { calls };
    });

    const record = recordOf(calls);

    expect(record.summary_raw).toBe(messy);
  });

  test("no token ⇒ NO request at all (the box posts nothing it cannot authorize)", async () => {
    const { calls, code } = await withLedger("accepts", async (base, calls) => {
      const run = await emitAsync("backup", `echo '{"ok":true}'`, {
        env: { FLUNCLE_API_BASE_URL: base },
      });

      return { calls, code: run.code };
    });

    expect(calls).toHaveLength(0);
    expect(code).toBe(0);
  });

  function withCurlRecorder(): { bin: string; log: string; urls: () => string[] } {
    const root = mkdtempSync(join(tmpdir(), "fluncle-curl-recorder-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const log = join(root, "urls.txt");

    mkdirSync(bin, { recursive: true });

    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "\${@: -1}" >>${JSON.stringify(log)}\nexit 0\n`,
      "utf8",
    );
    chmodSync(join(bin, "curl"), 0o755);

    return {
      bin,
      log,
      urls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    };
  }

  test("the URL it dials is the base plus the CONTRACT's path, verbatim", async () => {
    const recorder = withCurlRecorder();

    await emitAsync("backup", `echo '{"ok":true}'`, {
      env: {
        FLUNCLE_API_BASE_URL: "https://ledger.invalid",
        FLUNCLE_API_TOKEN: "fixture-agent-token",
        PATH: `${recorder.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });

    expect(recorder.urls()).toEqual([`https://ledger.invalid${RUN_EVENT_ENDPOINT}`]);
  });

  test("an empty base URL ⇒ NO request either — and above all, none at PRODUCTION", async () => {
    const recorder = withCurlRecorder();
    const { calls } = await withLedger("accepts", async (base, calls) => {
      await emitAsync("backup", `echo '{"ok":true}'`, {
        env: {
          FLUNCLE_API_BASE_URL: "",
          FLUNCLE_API_TOKEN: "fixture-agent-token",
          PATH: `${recorder.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        },
      });

      return { base, calls };
    });

    expect(recorder.urls()).toEqual([]);

    expect(recorder.urls().join("\n")).not.toContain("fluncle.com");
    expect(calls).toHaveLength(0);
  });

  test("a rejecting ledger changes NOTHING about the run — exit code, marker, stdout", async () => {
    const { code, marker, stdout } = await withLedger("rejects", async (base) =>
      emitAsync("crawl", `echo '{"ok":true,"crawled":1}'; exit 9`, { env: ledgerEnv(base) }),
    );

    expect(code).toBe(9);
    expect(findJsonSummary(marker)).toEqual({ crawled: 1, ok: true });
    expect(stdout).toContain('{"ok":true,"crawled":1}');
  });

  test("a 404 changes nothing about the run either — which is the whole reason it hid", async () => {
    const { code, marker, stdout } = await withLedger("notFound", async (base) =>
      emitAsync("crawl", `echo '{"ok":true,"crawled":2}'; exit 8`, { env: ledgerEnv(base) }),
    );

    expect(code).toBe(8);
    expect(findJsonSummary(marker)).toEqual({ crawled: 2, ok: true });
    expect(stdout).toContain('{"ok":true,"crawled":2}');
  });

  test("an unreachable ledger changes nothing either", async () => {
    const dead = Bun.serve({ fetch: () => new Response("x"), port: 0 });
    const base = `http://127.0.0.1:${dead.port}`;
    await dead.stop(true);

    const { code, marker } = await emitAsync("crawl", `echo '{"ok":true}'; exit 3`, {
      env: ledgerEnv(base),
    });

    expect(code).toBe(3);
    expect(findJsonSummary(marker)).toEqual({ ok: true });
  });

  test("no curl on PATH ⇒ the sweep runs, the marker lands, the exit code stands", async () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-no-curl-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");

    mkdirSync(bin, { recursive: true });

    for (const tool of [
      "bash",
      "cat",
      "date",
      "dirname",
      "find",
      "grep",
      "ls",
      "mkdir",
      "mktemp",
      "rm",
      "sed",
      "tail",
      "tee",
      "tr",
    ]) {
      const real = Bun.which(tool);

      expect(real).toBeTruthy();
      symlinkSync(real ?? "", join(bin, tool));
    }

    expect(Bun.which("curl", { PATH: bin })).toBeNull();

    const { code, marker, stdout } = await emitAsync("crawl", `echo '{"ok":true}'; exit 4`, {
      env: { FLUNCLE_API_BASE_URL: "https://ledger.invalid", FLUNCLE_API_TOKEN: "t", PATH: bin },
    });

    expect(code).toBe(4);
    expect(findJsonSummary(marker)).toEqual({ ok: true });
    expect(stdout).toContain('{"ok":true}');
  });

  test("a ledger that never answers is cut off by the POST's own timeout", async () => {
    const started = Date.now();
    const { code } = await withLedger("hangs", async (base) =>
      emitAsync("backup", `echo '{"ok":true}'; exit 5`, {
        env: ledgerEnv(base, { RUN_EVENT_TIMEOUT_SECS: "1" }),
      }),
    );
    const elapsed = Date.now() - started;

    expect(code).toBe(5);

    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("end to end: real sweeps → real markers → the sweep-errors row", () => {
  function runTicks(payload: string, ticks: number): string {
    const root = mkdtempSync(join(tmpdir(), "fluncle-cron-chain-"));
    temporaryDirectories.push(root);
    let dir = "";

    for (let index = 0; index < ticks; index += 1) {
      dir = emit("backup", payload, { sharedRoot: root }).dir;
    }

    return dir;
  }

  const STUCK_TICK = [
    `echo ${JSON.stringify(REAL_ERROR_LINE)} >&2`,
    `echo ${JSON.stringify(REAL_ERROR_LINE.replace("future-signal", "invaderz-transmissions"))} >&2`,
    `echo ${JSON.stringify(REAL_BENIGN_LINE)} >&2`,
    `echo '{"ok":true,"authored":0,"checked":2,"gateSkipped":0,"queueRemaining":40}'`,
  ].join("\n");

  const HEALTHY_TICK = [
    `echo ${JSON.stringify(REAL_BENIGN_LINE)} >&2`,
    `echo '{"ok":true,"authored":2,"gateSkipped":0,"queueRemaining":38}'`,
  ].join("\n");

  test("FIRES: the real stuck-queue condition reaches the row and names the sweep", () => {
    const dir = runTicks(STUCK_TICK, 4);
    const result = probeSweepStrain(new Map([["cron.backup", dir]]), {});

    expect(result.strained).toEqual(["cron.backup"]);
    expect(result.newly).toEqual(["cron.backup"]);
    expect(result.check.status).toBe("degraded");
    expect(result.check.message).toBe("1 sweep logging repeat errors: backup");
  });

  test("STAYS QUIET: healthy ticks with the same volume of chatter do not", () => {
    const dir = runTicks(HEALTHY_TICK, 12);
    const result = probeSweepStrain(new Map([["cron.backup", dir]]), {});

    expect(result.strained).toEqual([]);
    expect(result.check).toMatchObject({ message: "no repeat errors", status: "ok" });
  });

  test("the sweep's own /status row stays exactly as green as the sweep reported", () => {
    const dir = runTicks(STUCK_TICK, 4);
    const cron = { cadenceMs: 24 * 60 * 60_000, match: "backup", service: "cron.backup" };

    expect(judgeCron(cron, dir)).toBe("fresh-ok");
    expect(cronCheck(cron, "fresh-ok").status).toBe("ok");
    expect(probeSweepStrain(new Map([["cron.backup", dir]]), {}).strained).toEqual(["cron.backup"]);
  });

  test("a second tick over the same dir does not double-count (the watermark holds)", () => {
    const dir = runTicks(STUCK_TICK, 4);
    const first = probeSweepStrain(new Map([["cron.backup", dir]]), {});
    const second = probeSweepStrain(new Map([["cron.backup", dir]]), first.next);

    const points = (map: typeof first.next) =>
      Object.values(map["cron.backup"]?.buckets ?? {}).reduce((sum, b) => sum + b.points, 0);

    expect(points(first.next)).toBe(4);
    expect(points(second.next)).toBe(4);

    expect(second.newly).toEqual([]);
    expect(second.strained).toEqual(["cron.backup"]);
  });

  test("a cron with no output dir contributes nothing at all", () => {
    expect(probeSweepStrain(new Map(), {}).strained).toEqual([]);
  });
});
