// Tests for cron-output.sh — the wrapper every host-timer sweep runs inside.
//
// THE POINT OF THIS FILE IS THE PLUMBING, NOT THE PARSER. The strain detector in
// fluncle-healthcheck.ts has its own unit tests over hand-written marker strings, and those
// tests would pass just as happily if the wrapper never wrote a stderr tail at all — which is
// exactly the trap this suite exists to close. Before this change the marker held STDOUT ONLY,
// so every error line a sweep logged (they all go through `log()` = `console.error`) was
// absent from disk: a detector wired to the marker body would have been reading a source that
// could not carry the signal, and it would have passed its own tests while doing it.
//
// So these tests run the REAL bash function, with a REAL payload that writes to both streams,
// and then hand the resulting file to the REAL prober functions. Nothing is hand-written.
//
//   bun test docs/agents/hermes/scripts/cron-output.test.ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

type EmitOptions = { env?: Record<string, string>; sharedRoot?: string };
type EmitResult = { code: number; dir: string; marker: string; stderr: string; stdout: string };

/**
 * Write the runner that sources the REAL helper and wraps a REAL payload, and return its
 * path plus where the marker will land.
 *
 * `FLUNCLE_API_TOKEN` and `FLUNCLE_API_BASE_URL` are UNSET first, unconditionally. The
 * wrapper's ledger POST is a `curl` in a child process, which the repo's no-network rail
 * cannot see (it wraps `globalThis.fetch`), so an operator's real token sitting in the
 * environment is the one way this suite could reach production. Every test that wants a POST
 * sets both again, pointed at a loopback fixture.
 */
function writeRunner(
  job: string,
  payload: string,
  options: EmitOptions = {},
): { outputDir: string; script: string } {
  const root = options.sharedRoot ?? mkdtempSync(join(tmpdir(), "fluncle-cron-output-"));
  const outputDir = join(root, "output");
  const script = join(root, "run.sh");
  // The payload gets its own file rather than riding a `bash -c "…"` argument: embedded in the
  // runner's source it would be re-expanded by the outer shell, so a `$(seq …)` in a fixture
  // would run at the wrong level. A file has no quoting hazard at all.
  const payloadPath = join(root, "payload.sh");

  writeFileSync(payloadPath, `#!/usr/bin/env bash\n${payload}\n`, "utf8");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      // `-e` ON PURPOSE: every real sweep wrapper sources this helper under
      // `set -euo pipefail`, and the helper is full of pipelines whose failure is expected
      // and swallowed (`grep` finding no summary line, the marker write, the prune). A
      // harness running without `-e` would never see a missing `|| true`.
      "set -euo pipefail",
      "unset FLUNCLE_API_TOKEN FLUNCLE_API_BASE_URL",
      `export HEALTHCHECK_CRON_OUTPUT_DIR=${JSON.stringify(outputDir)}`,
      // The rebake guard reads dirname($HOME)/rebake.lock; point HOME somewhere empty so the
      // guard is a clean no-op instead of depending on the machine running the tests.
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

/** Run `emit_cron_output <job> -- bash <payload>` for real; return the marker it wrote. */
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

/**
 * The same run, ASYNCHRONOUSLY. `spawnSync` blocks the event loop, so a loopback fixture
 * server could never answer the wrapper's POST — the request would sit unserved until the
 * spawn returned, and every ledger test would "prove" a timeout. Anything that involves the
 * fixture must go through here.
 */
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

// The exact lines the box logged, from two days of real journal output. Sanitised already
// (`mb_<id>` stands in for a real MusicBrainz id); kept verbatim otherwise, because the whole
// question is whether THESE survive the wrapper.
const REAL_ERROR_LINE =
  "[entity-bio-sweep] future-signal: the voice gate / length rejected the bio — skipping (stays queued)";
const REAL_BENIGN_LINE = "[embed-sweep] mb_<id>: embedded + written";

describe("emit_cron_output — the marker's shape", () => {
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

    // The line is on disk (it was NOT, before this change — stderr was never captured).
    expect(marker).toContain(STDERR_DELIMITER);
    expect(marker).toContain(REAL_ERROR_LINE);

    // The sweep's own verdict is untouched and still reads green.
    expect(findJsonSummary(marker)).toEqual({ authored: 0, failed: 0, gateSkipped: 1, ok: true });

    // And the detector, reading the SAME bytes the wrapper wrote, scores the structured
    // `gateSkipped` once; the summary's `failed` field prevents duplicate stderr counting.
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

    expect(stderr).toContain("boom failed"); // the live journald copy
    expect(marker).toContain("> boom failed"); // the captured tail
  });

  test("the tail is blockquoted so a stderr JSON line can never pose as the summary", () => {
    const { marker } = emit(
      "note",
      `echo '{"ok":false,"reason":"this is a log line, not the summary"}' >&2; echo '{"ok":true,"noted":2}'`,
    );

    // Every captured line starts with `> `, so it cannot parse as an object literal …
    expect(marker).toContain('> {"ok":false');
    // … and the summary lookup, which stops at the delimiter, reads the real one.
    expect(findJsonSummary(marker)).toEqual({ noted: 2, ok: true });
  });

  test("the tail is bounded to the newest CRON_OUTPUT_STDERR_LINES lines", () => {
    const { marker } = emit(
      "enrich",
      `for i in $(seq 1 260); do echo "line $i failed" >&2; done; echo '{"ok":true}'`,
    );

    const quoted = marker.split("\n").filter((line) => line.startsWith("> "));

    expect(quoted).toHaveLength(200);
    expect(quoted.at(-1)).toBe("> line 260 failed"); // newest kept
    expect(marker).not.toContain("line 60 failed"); // oldest dropped
  });

  test("the payload's exit code survives the tee pipeline", () => {
    const { code, marker } = emit("crawl", `echo 'crawl pass failed' >&2; exit 17`);

    expect(code).toBe(17);
    // A killed/failed run with no summary still reads as no-summary for judgeCron …
    expect(findJsonSummary(marker)).toBeNull();
    // … while the reason it failed is now on disk instead of only in journald.
    expect(marker).toContain("crawl pass failed");
  });

  test("the delimiter is the same string on both sides of the contract", () => {
    const shell = readFileSync(HELPER, "utf8");

    expect(shell).toContain(`CRON_OUTPUT_STDERR_DELIMITER='${STDERR_DELIMITER}'`);
  });
});

// ---------------------------------------------------------------------------
// THE RUN LEDGER.
//
// Same principle as the suite above: drive the REAL bash against a REAL (loopback) server and
// read what actually arrived on the wire. The whole point of the ledger is that a number
// nobody consumes is a number nobody reads, so a test that asserts on a variable inside the
// script rather than on the bytes it sent would repeat the original mistake.
//
// Nothing here touches the network. The runner unsets FLUNCLE_API_TOKEN before anything else,
// and every POST is aimed at a fixture on 127.0.0.1.
// ---------------------------------------------------------------------------

type LedgerCall = { auth: string; body: string; method: string; path: string };
type LedgerEnvelope = {
  ended_at: string;
  exit_code: number;
  started_at: string;
  summary_raw: string;
  unit: string;
};

type LedgerMode = "accepts" | "hangs" | "notFound" | "rejects";

/** Run `body` against a loopback ledger; hand back everything the ledger actually received. */
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
        // Never answers. Proves the POST is bounded by its own timeout rather than by the
        // server's good manners.
        await new Promise(() => {});
      }

      if (mode === "rejects") {
        return Response.json({ error: "nope" }, { status: 500 });
      }

      // What a wrong endpoint really looked like: the Worker answers, and answers 404.
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

function envelopeOf(calls: LedgerCall[]): LedgerEnvelope {
  const call = calls[0];

  if (!call) {
    throw new Error("the ledger received no request at all");
  }

  return JSON.parse(call.body) as LedgerEnvelope;
}

describe("emit_cron_output — the run-ledger POST", () => {
  test("posts the run envelope: the agent bearer, the path, and the five fields", async () => {
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

    const envelope = envelopeOf(calls);

    // `unit` is the systemd unit stem, matching the marker's `# Cron Job:` header — one name
    // for the job across both consumers.
    expect(envelope.unit).toBe("fluncle-backup");
    expect(envelope.exit_code).toBe(0);
    expect(envelope.summary_raw).toBe('{"ok":true,"tableCount":74}');
    expect(envelope.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(envelope.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Box time, and there is exactly one field for it — the Worker stamps its own write time.
    expect(Object.keys(envelope).sort()).toEqual([
      "ended_at",
      "exit_code",
      "started_at",
      "summary_raw",
      "unit",
    ]);
  });

  test("THE BODY CARRIES NO `ok` — the Worker derives it, and cannot be told otherwise", async () => {
    // The sweep prints the exact line the Sentry triage cron printed for eleven nights: a
    // hardcoded `ok:true` sitting beside the error count that contradicts it. It rides along
    // verbatim inside `summary_raw` (that IS the evidence), and reaches the ledger as data —
    // never as a field the row could be built from.
    const { calls } = await withLedger("accepts", async (base, calls) => {
      await emitAsync("sentry-triage", `echo '{"ok":true,"errors":2,"triaged":0}'`, {
        env: ledgerEnv(base),
      });

      return { calls };
    });

    const envelope = envelopeOf(calls);

    expect(envelope.summary_raw).toBe('{"ok":true,"errors":2,"triaged":0}');
    expect("ok" in envelope).toBe(false);
    expect(JSON.parse(envelope.summary_raw)).toMatchObject({ errors: 2, ok: true });
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

    expect(envelopeOf(calls).summary_raw).toBe('{"ok":true,"crawled":3}');
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

    expect(envelopeOf(calls).summary_raw).toBe('{"ok":true,"noted":2}');
  });

  test("the exit code travels, so a failed run is a row rather than a silence", async () => {
    const { calls, code } = await withLedger("accepts", async (base, calls) => {
      const run = await emitAsync("crawl", `echo 'crawl pass failed' >&2; exit 17`, {
        env: ledgerEnv(base),
      });

      return { calls, code: run.code };
    });

    expect(code).toBe(17);

    const envelope = envelopeOf(calls);

    expect(envelope.exit_code).toBe(17);
    // The run printed no summary at all; the ledger records that honestly instead of inventing
    // one — an empty `summary_raw` is what `missing_fields` is built from.
    expect(envelope.summary_raw).toBe("");
  });

  test("a summary carrying quotes, backslashes and a raw tab still arrives as valid JSON", async () => {
    // Every character the escaper has to handle, as RAW BYTES on the sweep's stdout: a bare
    // double quote (which would end the JSON string early), a bare backslash (which would eat
    // the next character), and a raw tab (which JSON forbids inside a string outright). A
    // quoted heredoc puts them on the wire verbatim — `printf '%s'` would not, because bash
    // hands `\t` through as two characters and the fixture would silently be testing nothing.
    const messy = '{"ok":true,"note":"he said "go"","win":"C:\\tmp","tab":"a\tb"}';
    const { calls } = await withLedger("accepts", async (base, calls) => {
      await emitAsync("enrich", ["cat <<'PAYLOAD_EOF'", messy, "PAYLOAD_EOF"].join("\n"), {
        env: ledgerEnv(base),
      });

      return { calls };
    });

    // The envelope parses at all — it would not if any of the three leaked through unescaped,
    // which is the actual assertion; `envelopeOf` does the JSON.parse.
    const envelope = envelopeOf(calls);

    // And the line survives byte for byte, so the ledger holds what the sweep really said.
    expect(envelope.summary_raw).toBe(messy);
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

  // ── WHERE THE POST ACTUALLY WENT ────────────────────────────────────────────
  // A loopback fixture can only report what it RECEIVED, and "received nothing" has two very
  // different causes: the wrapper posted nowhere, or it posted somewhere else. That ambiguity
  // hid a live defect — `${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}` made an EMPTY base
  // fall back to the production URL, so the guard below it was unreachable and every CI run of
  // `bun run test:scripts` fired a real POST at www.fluncle.com while this very test passed.
  //
  // So these two drive the wrapper with `curl` itself replaced by a recorder, and assert on the
  // URL the box would really have dialled.
  function withCurlRecorder(): { bin: string; log: string; urls: () => string[] } {
    const root = mkdtempSync(join(tmpdir(), "fluncle-curl-recorder-"));
    const bin = join(root, "bin");
    const log = join(root, "urls.txt");

    mkdirSync(bin, { recursive: true });
    // The URL is the LAST argument the emitter passes; everything else is headers and flags.
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

    // `curl` was never reached at all — the honest form of "posted nowhere".
    expect(recorder.urls()).toEqual([]);
    // Stated separately because it is the consequence that mattered: the fallback URL is the
    // live archive, and `bun run test:scripts` runs inside the deploy gate.
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

  // The shipped bug's own failure mode, kept as a test: a 404 is swallowed exactly like a 500,
  // which is WHY the wrong endpoint was invisible. The wrapper is right to swallow it (a sweep
  // must not fail over telemetry) — so the guard has to be the path assertion above, not this.
  test("a 404 changes nothing about the run either — which is the whole reason it hid", async () => {
    const { code, marker, stdout } = await withLedger("notFound", async (base) =>
      emitAsync("crawl", `echo '{"ok":true,"crawled":2}'; exit 8`, { env: ledgerEnv(base) }),
    );

    expect(code).toBe(8);
    expect(findJsonSummary(marker)).toEqual({ crawled: 2, ok: true });
    expect(stdout).toContain('{"ok":true,"crawled":2}');
  });

  test("an unreachable ledger changes nothing either", async () => {
    // A port that was open just long enough to learn its number, then closed — so the connect
    // is refused rather than timing out, and the test stays fast.
    const dead = Bun.serve({ fetch: () => new Response("x"), port: 0 });
    const base = `http://127.0.0.1:${dead.port}`;
    await dead.stop(true);

    const { code, marker } = await emitAsync("crawl", `echo '{"ok":true}'; exit 3`, {
      env: ledgerEnv(base),
    });

    expect(code).toBe(3);
    expect(findJsonSummary(marker)).toEqual({ ok: true });
  });

  // The fourth way a POST can fail, and the only one no fixture above reaches: `curl` simply is
  // not there. The emitter guards on `command -v curl`, and a sweep must not care.
  test("no curl on PATH ⇒ the sweep runs, the marker lands, the exit code stands", async () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-no-curl-"));
    const bin = join(root, "bin");

    mkdirSync(bin, { recursive: true });

    // A PATH the wrapper can still work in, with curl deliberately absent: symlink exactly the
    // tools cron-output.sh and the harness reach for, and nothing else. `Bun.which` resolves each
    // from the real PATH, so the set is honest rather than guessed at a fixed prefix.
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
    // Bounded by the 1s budget, not by the sweep hanging until systemd's TimeoutStartSec.
    expect(elapsed).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// THE WHOLE CHAIN, end to end.
//
// The suite above proves the wrapper writes the errors; the detector's own suite proves the
// scoring. Neither proves they are CONNECTED — a detector can pass both halves and still be
// wired to nothing, which is the failure this repo has been bitten by. So this drives the
// REAL bash wrapper for several ticks and then hands the resulting directory to the REAL
// probe, with nothing hand-written in between.
// ---------------------------------------------------------------------------

describe("end to end: real sweeps → real markers → the sweep-errors row", () => {
  /** The real bio-gate line, run through the real wrapper N times into one output dir. */
  function runTicks(payload: string, ticks: number): string {
    const root = mkdtempSync(join(tmpdir(), "fluncle-cron-chain-"));
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
    // Four daily ticks, each with 2/2 item-failure lines collapsing to ONE rate-gated point → 4
    // points over 4 ticks, past the cadence-relative rate gate and the 3-tick spread gate.
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
    // The first constraint, proven through the real files: a strained sweep is still `ok`.
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
    expect(points(second.next)).toBe(4); // unchanged — nothing new on disk

    // Already reported, so it is not announced a second time; the row stays degraded.
    expect(second.newly).toEqual([]);
    expect(second.strained).toEqual(["cron.backup"]);
  });

  test("a cron with no output dir contributes nothing at all", () => {
    expect(probeSweepStrain(new Map(), {}).strained).toEqual([]);
  });
});
