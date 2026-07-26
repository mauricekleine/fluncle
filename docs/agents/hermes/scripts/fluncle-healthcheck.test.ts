// Unit tests for the /status cron verdict (fluncle-healthcheck.ts) — the layer that decides
// whether a cron reads green. Every case is a real marker file in a temp dir, because the bug
// this suite exists for was about a FILE's shape, not a code path:
//
//   `cron-output.sh` WRAPS the sweep rather than exec'ing it, so a SIGKILLed run still leaves
//   a marker — a 28-byte file whose only line is the `# Cron Job: …` header. The prober took
//   the last non-empty line, failed to `JSON.parse` it, and shrugged ("freshness governs").
//   `fluncle-backup` was OOM-killed three nights running (2026-07-24/25/26) and `cron.backup`
//   read GREEN the whole time.
//
//   bun test docs/agents/hermes/scripts/fluncle-healthcheck.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `main()` is guarded behind `import.meta.main` in the prober, so importing it here is
// side-effect free — no probes, no Discord, no POST.
import {
  boxUptimeMs,
  type CronDef,
  cronCheck,
  findJsonSummary,
  judgeCron,
} from "./fluncle-healthcheck";

const CRON: CronDef = { cadenceMs: 24 * 60 * 60_000, match: "backup", service: "cron.backup" };
const STALE_BUDGET_MS = CRON.cadenceMs * 3;

/** A marker dir holding the given run bodies, newest LAST, each aged `ageMs` apart. */
function markerDir(runs: { ageMs: number; body: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-cron-"));

  runs.forEach((run, index) => {
    const path = join(dir, `2026-07-2${index}T000000Z-1.md`);
    writeFileSync(path, run.body);

    const when = (Date.now() - run.ageMs) / 1000;
    utimesSync(path, when, when);
  });

  return dir;
}

/** What `emit_cron_output` writes: the header, a blank line, then the captured stdout. */
function marker(stdout: string): string {
  return `# Cron Job: fluncle-backup\n\n${stdout}`;
}

/** What it writes when the payload is SIGKILLed before printing anything — the incident. */
const KILLED_MARKER = "# Cron Job: fluncle-backup\n\n";

describe("findJsonSummary", () => {
  test("finds the summary on the last line", () => {
    expect(findJsonSummary(marker('{"ok":true,"tableCount":74}\n'))).toEqual({
      ok: true,
      tableCount: 74,
    });
  });

  test("finds a summary buried under trailing log noise", () => {
    const body = marker('{"ok":true}\nuploaded 3 objects\ndone in 41s\n');

    expect(findJsonSummary(body)).toEqual({ ok: true });
  });

  test("a header-only marker carries no summary", () => {
    expect(findJsonSummary(KILLED_MARKER)).toBeNull();
  });

  test("a JSON array or a bare human line is not a summary", () => {
    expect(findJsonSummary(marker("[1,2,3]\n"))).toBeNull();
    expect(findJsonSummary(marker("backed up fine\n"))).toBeNull();
  });
});

describe("judgeCron — the marker's body", () => {
  test("a killed run (header only) is FAILED, never fresh-ok", () => {
    const dir = markerDir([{ ageMs: 60_000, body: KILLED_MARKER }]);

    expect(judgeCron(CRON, dir)).toBe("no-summary");
    expect(cronCheck(CRON, judgeCron(CRON, dir)).status).toBe("down");
  });

  test("a well-formed summary is ok", () => {
    const dir = markerDir([{ ageMs: 60_000, body: marker('{"ok":true,"dailyKey":"x"}\n') }]);

    expect(judgeCron(CRON, dir)).toBe("fresh-ok");
    expect(cronCheck(CRON, judgeCron(CRON, dir)).status).toBe("ok");
  });

  test("a summary followed by trailing log lines is still ok", () => {
    const dir = markerDir([
      { ageMs: 60_000, body: marker('{"ok":true}\npruned 2 keys\nbox-state uploaded\n') },
    ]);

    expect(judgeCron(CRON, dir)).toBe("fresh-ok");
  });

  test("a lone reported failure is degraded, two in a row is down", () => {
    const once = markerDir([
      { ageMs: 120_000, body: marker('{"ok":true}\n') },
      { ageMs: 60_000, body: marker('{"ok":false,"reason":"missing_r2_credentials"}\n') },
    ]);

    expect(judgeCron(CRON, once)).toBe("failed-once");
    expect(cronCheck(CRON, judgeCron(CRON, once)).status).toBe("degraded");

    const twice = markerDir([
      { ageMs: 120_000, body: marker('{"ok":false}\n') },
      { ageMs: 60_000, body: marker('{"ok":false}\n') },
    ]);

    expect(judgeCron(CRON, twice)).toBe("failed");
    expect(cronCheck(CRON, judgeCron(CRON, twice)).status).toBe("down");
  });

  test("a killed run BEHIND a reported failure escalates to down", () => {
    const dir = markerDir([
      { ageMs: 120_000, body: KILLED_MARKER },
      { ageMs: 60_000, body: marker('{"ok":false}\n') },
    ]);

    expect(judgeCron(CRON, dir)).toBe("failed");
  });

  test("a stale marker is lagging whatever it says", () => {
    const dir = markerDir([{ ageMs: STALE_BUDGET_MS + 60_000, body: marker('{"ok":true}\n') }]);

    expect(judgeCron(CRON, dir)).toBe("lagging");
  });
});

describe("judgeCron — no runs at all", () => {
  test("on a freshly-booted box, silence is still 'no runs yet'", () => {
    expect(judgeCron(CRON, undefined, 60_000)).toBe("no-data");
    expect(cronCheck(CRON, "no-data").status).toBe("ok");
  });

  test("with the uptime unknown (no procfs), it stays defensively ok", () => {
    expect(judgeCron(CRON, undefined, null)).toBe("no-data");
  });

  test("past the cron's own stale budget, a never-fired timer is lagging", () => {
    // The second blindness: a timer that never installed used to read "no runs yet / ok"
    // forever. Once the box has been up longer than the cron's whole stale budget, it hasn't
    // "not started yet" — it has never fired.
    expect(judgeCron(CRON, undefined, STALE_BUDGET_MS + 60_000)).toBe("lagging");
    expect(cronCheck(CRON, "lagging").status).toBe("degraded");
  });

  test("an EMPTY marker dir ages the same way", () => {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-cron-empty-"));

    expect(judgeCron(CRON, dir, 60_000)).toBe("no-data");
    expect(judgeCron(CRON, dir, STALE_BUDGET_MS + 60_000)).toBe("lagging");
  });
});

describe("boxUptimeMs", () => {
  test("reads a positive uptime on procfs, and null where there is none", () => {
    const uptime = boxUptimeMs();

    // The box is Linux (procfs); a dev Mac is not. Both answers are valid — what must never
    // happen is a wrong number, since it decides whether silence means "booting" or "dead".
    expect(uptime === null || uptime > 0).toBe(true);
  });
});
