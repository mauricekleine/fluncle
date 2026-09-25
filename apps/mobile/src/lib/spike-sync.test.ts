import {
  describeError,
  describeSyncTarget,
  describeToken,
  diagnoseSpikeError,
  formatSpikeLine,
  formatSpikeLog,
  readSpikeConfig,
  runSpike,
  SPIKE_PASS,
  SPIKE_SYNC_URL_ENV,
  SPIKE_TOKEN_ENV,
  spikeFailVerdict,
  type SpikeStep,
} from "@/lib/spike-sync";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${message}: ${JSON.stringify(haystack)} does not include ${JSON.stringify(needle)}`,
    );
  }
}

function tickingClock(step = 10): () => number {
  let now = 1_000;
  return () => {
    const value = now;
    now += step;
    return value;
  };
}

function step(id: string, behaviour: "fail" | "pass", fatal = false): SpikeStep {
  return {
    fatal,
    id,
    run: async () => {
      if (behaviour === "fail") {
        throw new Error(`${id} blew up`);
      }
      return `${id} detail`;
    },
  };
}

{
  const ran: string[] = [];
  const record = (id: string): SpikeStep => ({
    id,
    run: async () => {
      ran.push(id);
      return undefined;
    },
  });
  const result = await runSpike([record("open"), record("sync-1"), record("close")], {
    clock: tickingClock(),
  });
  assertEqual(ran.join(","), "open,sync-1,close", "steps run in declaration order");
  assertEqual(result.verdict, SPIKE_PASS, "all steps ok → pass");
  assertEqual(result.failedStepId, undefined, "no failed step on a clean run");

  assertEqual(result.lines.length, 4, "one line per step plus the verdict");
  assertEqual(result.lines[3]?.kind, "verdict", "the last line is the verdict");
  assertEqual(result.lines[3]?.text, SPIKE_PASS, "the verdict line carries the verdict");
}

{
  const ran: string[] = [];
  const steps: SpikeStep[] = [
    {
      id: "sync-1",
      run: async () => {
        ran.push("sync-1");
        throw new Error("pull refused");
      },
    },
    {
      id: "read",
      run: async () => {
        ran.push("read");
        return undefined;
      },
    },
    {
      id: "close",
      run: async () => {
        ran.push("close");
        return undefined;
      },
    },
  ];
  const result = await runSpike(steps, { clock: tickingClock() });
  assertEqual(ran.join(","), "sync-1,read,close", "a non-fatal failure does not stop the run");
  assertEqual(result.verdict, spikeFailVerdict("sync-1"), "verdict names the failed step");
  assertEqual(result.failedStepId, "sync-1", "the failed step is reported");
  assertEqual(result.lines[0]?.kind, "error", "the failure is logged as an error line");
  assertIncludes(result.lines[0]?.text ?? "", "pull refused", "the error message reaches the log");
  assertEqual(result.lines.filter((line) => line.kind === "skipped").length, 0, "nothing skipped");
}

{
  const ran: string[] = [];
  const steps: SpikeStep[] = [
    {
      fatal: true,
      id: "open",
      run: async () => {
        ran.push("open");
        throw new Error("no such module");
      },
    },
    {
      id: "sync-1",
      run: async () => {
        ran.push("sync-1");
        return undefined;
      },
    },
    {
      id: "close",
      run: async () => {
        ran.push("close");
        return undefined;
      },
    },
  ];
  const result = await runSpike(steps, { clock: tickingClock() });
  assertEqual(ran.join(","), "open", "a fatal failure stops the run");
  assertEqual(result.verdict, spikeFailVerdict("open"), "verdict names the fatal step");
  const skipped = result.lines.filter((line) => line.kind === "skipped");
  assertEqual(skipped.length, 2, "both later steps are reported as skipped");
  assertEqual(skipped[0]?.text, "sync-1: skipped", "a skipped step is named");
}

{
  const result = await runSpike([step("a", "pass"), step("b", "fail"), step("c", "fail")], {
    clock: tickingClock(),
  });
  assertEqual(result.verdict, spikeFailVerdict("b"), "the first failure owns the verdict");
}

{
  const result = await runSpike([step("open", "pass"), step("sync", "pass")], {
    clock: tickingClock(10),
  });

  assertIncludes(
    result.lines[0]?.text ?? "",
    "open: ok (10 ms)",
    "the step's own duration is logged",
  );
  assertIncludes(result.lines[0]?.text ?? "", "open detail", "the step's detail is appended");
  assertEqual(
    formatSpikeLine({ elapsedMs: 1234, kind: "step", text: "x" }),
    "[+1.234s] x",
    "line format",
  );
}

{
  const streamed: string[] = [];
  const result = await runSpike([step("a", "pass"), step("b", "fail")], {
    clock: tickingClock(),
    onLine: (line) => streamed.push(line.text),
  });
  assertEqual(streamed.length, result.lines.length, "every line is streamed");
  assertEqual(streamed.join("|"), result.lines.map((line) => line.text).join("|"), "same order");
}

{
  const result = await runSpike([], { clock: tickingClock() });
  assertEqual(result.verdict, SPIKE_PASS, "no steps → nothing failed");
  assertEqual(result.lines.length, 1, "just the verdict line");
}

{
  assertIncludes(describeError(new Error("boom")), "boom", "Error message");
  assertIncludes(describeError(new Error("boom")), "[at ", "top stack frame is bracketed");
  assertEqual(describeError("plain string"), "plain string", "a thrown string");
  assertEqual(
    describeError({ message: "native said no" }),
    "native said no",
    "an object with a message",
  );
  assertEqual(describeError(undefined), "undefined", "a thrown undefined never crashes the log");
}

{
  const noBuild = diagnoseSpikeError(
    new Error("syncLibSQL is not supported in the current environment"),
  );
  assertIncludes(
    noBuild ?? "",
    "useLibSQL: true",
    "the missing-native-variant hint names the plugin prop",
  );
  const unsupportedMode = diagnoseSpikeError(
    new Error("enableChangeListener is not supported in libSQL mode"),
  );
  assertIncludes(
    unsupportedMode ?? "",
    "useLibSQL: true",
    "the libSQL-mode message shares that hint",
  );
  const missingOptions = diagnoseSpikeError(new Error("libSQLUrl must be provided"));
  assertIncludes(
    missingOptions ?? "",
    SPIKE_SYNC_URL_ENV,
    "the missing-options hint names the env var",
  );
  const missingTable = diagnoseSpikeError(new Error("no such table: spike_tracks"));
  assertIncludes(missingTable ?? "", "unseeded", "the missing-table hint points at the seed");
  assertEqual(
    diagnoseSpikeError(new Error("disk I/O error")),
    undefined,
    "no guess for an unknown failure",
  );
}

{
  const none = readSpikeConfig({ syncUrl: undefined, token: undefined });
  assertEqual(none.kind, "missing", "no env → missing");
  assertEqual(
    none.kind === "missing" ? none.missing.join(",") : "",
    `${SPIKE_SYNC_URL_ENV},${SPIKE_TOKEN_ENV}`,
    "both missing names are reported",
  );
  const blank = readSpikeConfig({ syncUrl: "   ", token: "tok" });
  assertEqual(blank.kind, "missing", "whitespace-only URL → missing");
  assertEqual(
    blank.kind === "missing" ? blank.missing.join(",") : "",
    SPIKE_SYNC_URL_ENV,
    "only the blank one",
  );
  const ready = readSpikeConfig({ syncUrl: " libsql://example-org.turso.io ", token: " tok " });
  assertEqual(ready.kind, "ready", "both present → ready");
  assertEqual(
    ready.kind === "ready" ? ready.config.syncUrl : "",
    "libsql://example-org.turso.io",
    "trimmed URL",
  );
  assertEqual(ready.kind === "ready" ? ready.config.token : "", "tok", "trimmed token");
}

{
  const masked = describeSyncTarget("libsql://example-org.turso.io");
  assertIncludes(masked, "libsql://", "the scheme survives, so the operator can spot a typo");
  assertEqual(masked.includes("turso.io"), false, "the host never reaches the log");
  assertEqual(masked, "libsql://exa...", "masked to the first three host chars, no length leak");
  assertEqual(
    describeSyncTarget("not-a-url"),
    "set (no scheme)",
    "a schemeless value is still safe",
  );
  assertEqual(describeToken("abcdef"), "set (6 chars)", "the token is described by length only");
  assertEqual(
    describeToken("abcdef").includes("abcdef"),
    false,
    "the token itself never reaches the log",
  );
}

{
  const log = formatSpikeLog([
    { elapsedMs: 0, kind: "info", text: "start" },
    { elapsedMs: 1500, kind: "verdict", text: SPIKE_PASS },
  ]);
  assertEqual(
    log,
    `[+0.000s] start\n[+1.500s] ${SPIKE_PASS}`,
    "the shared log is stamped, one line each",
  );
}

console.log("spike-sync.test.ts: all checks passed");
