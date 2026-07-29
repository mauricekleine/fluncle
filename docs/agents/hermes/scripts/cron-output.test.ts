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
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cronCheck,
  findJsonSummary,
  judgeCron,
  markerStrain,
  probeSweepStrain,
  STDERR_DELIMITER,
} from "./fluncle-healthcheck";

const HELPER = join(import.meta.dir, "cron-output.sh");

/** Run `emit_cron_output <job> -- bash <payload>` for real; return the marker it wrote. */
function emit(
  job: string,
  payload: string,
  sharedRoot?: string,
): { code: number; dir: string; marker: string; stderr: string; stdout: string } {
  const root = sharedRoot ?? mkdtempSync(join(tmpdir(), "fluncle-cron-output-"));
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
      "set -uo pipefail",
      `export HEALTHCHECK_CRON_OUTPUT_DIR=${JSON.stringify(outputDir)}`,
      // The rebake guard reads dirname($HOME)/rebake.lock; point HOME somewhere empty so the
      // guard is a clean no-op instead of depending on the machine running the tests.
      `export HOME=${JSON.stringify(join(root, "home"))}`,
      `. ${JSON.stringify(HELPER)}`,
      `emit_cron_output ${job} -- bash ${JSON.stringify(payloadPath)}`,
    ].join("\n"),
    "utf8",
  );

  const run = spawnSync("bash", [script], { encoding: "utf8" });
  const dir = join(outputDir, `fluncle-${job}`);
  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort();
  const newest = files.at(-1) ?? "";

  return {
    code: run.status ?? -1,
    dir,
    marker: readFileSync(join(dir, newest), "utf8"),
    stderr: run.stderr,
    stdout: run.stdout,
  };
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
      `echo ${JSON.stringify(REAL_ERROR_LINE)} >&2; echo '{"ok":true,"authored":0,"gateSkipped":1}'`,
    );

    // The line is on disk (it was NOT, before this change — stderr was never captured).
    expect(marker).toContain(STDERR_DELIMITER);
    expect(marker).toContain(REAL_ERROR_LINE);

    // The sweep's own verdict is untouched and still reads green.
    expect(findJsonSummary(marker)).toEqual({ authored: 0, gateSkipped: 1, ok: true });

    // And the detector, reading the SAME bytes the wrapper wrote, scores it:
    // one distress line + one `gateSkipped`.
    expect(markerStrain(marker)).toBe(2);
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
      dir = emit("backup", payload, root).dir;
    }

    return dir;
  }

  const STUCK_TICK = [
    `echo ${JSON.stringify(REAL_ERROR_LINE)} >&2`,
    `echo ${JSON.stringify(REAL_ERROR_LINE.replace("future-signal", "invaderz-transmissions"))} >&2`,
    `echo ${JSON.stringify(REAL_BENIGN_LINE)} >&2`,
    `echo '{"ok":true,"authored":0,"gateSkipped":2,"queueRemaining":40}'`,
  ].join("\n");

  const HEALTHY_TICK = [
    `echo ${JSON.stringify(REAL_BENIGN_LINE)} >&2`,
    `echo '{"ok":true,"authored":2,"gateSkipped":0,"queueRemaining":38}'`,
  ].join("\n");

  test("FIRES: the real stuck-queue condition reaches the row and names the sweep", () => {
    // Four ticks, each scoring 2 log lines + 2 gateSkipped = 4 → 16 points over 4 ticks,
    // past both gates (12 points, 3 ticks).
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

    expect(points(first.next)).toBe(16);
    expect(points(second.next)).toBe(16); // unchanged — nothing new on disk

    // Already reported, so it is not announced a second time; the row stays degraded.
    expect(second.newly).toEqual([]);
    expect(second.strained).toEqual(["cron.backup"]);
  });

  test("a cron with no output dir contributes nothing at all", () => {
    expect(probeSweepStrain(new Map(), {}).strained).toEqual([]);
  });
});
