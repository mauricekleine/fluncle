// Unit tests for the /status prober (fluncle-healthcheck.ts): the layer that decides whether a
// cron reads green, and the layer that decides whether the operator ever hears about it twice.
//
// The cron-verdict cases are each a real marker file in a temp dir, because the bug that suite
// exists for was about a FILE's shape, not a code path:
//
//   `cron-output.sh` WRAPS the sweep rather than exec'ing it, so a SIGKILLed run still leaves
//   a marker — a 28-byte file whose only line is the `# Cron Job: …` header. The prober took
//   the last non-empty line, failed to `JSON.parse` it, and shrugged ("freshness governs").
//   `fluncle-backup` was OOM-killed three nights running (2026-07-24/25/26) and `cron.backup`
//   read GREEN the whole time.
//
// The escalation cases guard the second half of that lesson: the prober can be RIGHT and still
// say nothing. Alerting was edge-triggered, so `cron.render` failing hourly for ~20 hours pinged
// once and then held its peace for the other nineteen. These tests pin the streak ladder that
// turns duration into a signal — and, just as importantly, pin that it stays a LADDER (6, 12,
// 24 …) rather than becoming a per-tick siren.
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
  buildEscalationAlert,
  type CronDef,
  cronCheck,
  escalationDue,
  findJsonSummary,
  formatStreakDuration,
  judgeCron,
  nextServiceState,
  normalizeState,
  serializeState,
  type ServiceState,
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

// ---------------------------------------------------------------------------
// Escalation on persistence — the streak ladder.
// ---------------------------------------------------------------------------

type ProbeStatus = "degraded" | "down" | "ok";

/** The prober's default ESCALATE_AFTER_TICKS (≈1h at the timer's ~10m cadence). */
const THRESHOLD = 6;

/**
 * Replay a run of ticks exactly as `main()` does — advance the state, escalate when due,
 * stamp the streak we escalated at — and report the streaks that fired an escalation.
 */
function replay(statuses: readonly ProbeStatus[]): { escalatedAt: number[]; state: ServiceState } {
  let state: ServiceState | undefined;
  const escalatedAt: number[] = [];

  for (const status of statuses) {
    const advanced = nextServiceState(state, status);

    if (escalationDue(advanced, THRESHOLD)) {
      escalatedAt.push(advanced.downStreak);
      state = { ...advanced, escalatedStreak: advanced.downStreak };

      continue;
    }

    state = advanced;
  }

  return { escalatedAt, state: state ?? { downStreak: 0, escalatedStreak: 0, status: "ok" } };
}

const downs = (count: number): ProbeStatus[] => Array.from({ length: count }, () => "down");

describe("nextServiceState — the consecutive-down streak", () => {
  test("increments once per consecutive down tick", () => {
    expect(replay(downs(1)).state.downStreak).toBe(1);
    expect(replay(downs(3)).state.downStreak).toBe(3);
    expect(replay(downs(20)).state.downStreak).toBe(20);
  });

  test("a recovery resets the streak AND re-arms the ladder", () => {
    const { escalatedAt, state } = replay([...downs(9), "ok", "down", "down"]);

    expect(state.downStreak).toBe(2);
    expect(state.escalatedStreak).toBe(0);
    // The pre-recovery run escalated once; the new run has to earn its own.
    expect(escalatedAt).toEqual([THRESHOLD]);
  });

  test("degraded resets it too — only `down` is an outage", () => {
    expect(replay([...downs(5), "degraded", "down"]).state.downStreak).toBe(1);
  });

  test("a flapping service never accumulates its way to an escalation", () => {
    const flap: ProbeStatus[] = [];

    for (let index = 0; index < 10; index += 1) {
      flap.push("down", "down", "ok");
    }

    expect(replay(flap).escalatedAt).toEqual([]);
  });
});

describe("escalationDue — the doubling ladder", () => {
  test("fires exactly AT the threshold, never before", () => {
    expect(replay(downs(THRESHOLD - 1)).escalatedAt).toEqual([]);
    expect(replay(downs(THRESHOLD)).escalatedAt).toEqual([THRESHOLD]);
  });

  test("re-escalates on 6/12/24, not on every tick after 6", () => {
    // The whole point: 20 hours of hourly failure should read as a handful of louder
    // lines, not 120 identical ones.
    expect(replay(downs(30)).escalatedAt).toEqual([6, 12, 24]);
    expect(replay(downs(100)).escalatedAt).toEqual([6, 12, 24, 48, 96]);
  });

  test("a non-down state is never due, whatever the counters say", () => {
    expect(escalationDue({ downStreak: 99, escalatedStreak: 0, status: "ok" }, THRESHOLD)).toBe(
      false,
    );
    expect(
      escalationDue({ downStreak: 99, escalatedStreak: 0, status: "degraded" }, THRESHOLD),
    ).toBe(false);
  });

  test("a streak that jumps a rung (a skipped tick) still escalates once, then doubles", () => {
    // downStreak 20 with the last escalation at 6 is past the 12 rung — it escalates now and
    // the next rung becomes 40, never a burst of catch-up alerts for 12 and 24.
    const jumped: ServiceState = { downStreak: 20, escalatedStreak: 6, status: "down" };

    expect(escalationDue(jumped, THRESHOLD)).toBe(true);
    expect(escalationDue({ ...jumped, escalatedStreak: 20 }, THRESHOLD)).toBe(false);
    expect(escalationDue({ downStreak: 40, escalatedStreak: 20, status: "down" }, THRESHOLD)).toBe(
      true,
    );
  });
});

describe("buildEscalationAlert", () => {
  const TICK_MS = 10 * 60_000; // the timer's ~10m cadence

  test("carries the service, the streak, and the wall-clock duration", () => {
    const alert = buildEscalationAlert([{ service: "cron.render", streak: 6 }], TICK_MS);

    expect(alert).toBe(
      "🚨 cron.render STILL DOWN — 6 consecutive checks (~1h). This is not a transient.",
    );
  });

  test("says nothing when nothing escalated", () => {
    expect(buildEscalationAlert([], TICK_MS)).toBeNull();
  });

  test("one line per service when several cross a rung together", () => {
    const alert =
      buildEscalationAlert(
        [
          { service: "cron.render", streak: 12 },
          { service: "web", streak: 6 },
        ],
        TICK_MS,
      ) ?? "";

    expect(alert.split("\n")).toHaveLength(2);
    expect(alert).toContain("cron.render STILL DOWN — 12 consecutive checks (~2h)");
    expect(alert).toContain("web STILL DOWN — 6 consecutive checks (~1h)");
  });

  test("a box-wide outage collapses to ONE line instead of blowing Discord's cap", () => {
    // ~45 services escalating together (the whole cron roster) would exceed the 2,000-char
    // message limit and get the entire post rejected — the loudest alert falling silent.
    const many = Array.from({ length: 45 }, (_, index) => ({
      service: `cron.job-${index}`,
      streak: index === 3 ? 24 : 6,
    }));
    const alert = buildEscalationAlert(many, TICK_MS) ?? "";

    expect(alert.split("\n")).toHaveLength(1);
    expect(alert.length).toBeLessThan(2000);
    expect(alert).toContain("45 services STILL DOWN");
    expect(alert).toContain("longest 24 consecutive checks (~4h)");
    expect(alert).toContain("+37 more");
  });

  test("the duration scales with the streak, and reads in days once it is one", () => {
    expect(formatStreakDuration(3, TICK_MS)).toBe("~30m");
    expect(formatStreakDuration(24, TICK_MS)).toBe("~4h");
    // The incident that motivated all this: ~20h of hourly failure.
    expect(formatStreakDuration(120, TICK_MS)).toBe("~20h");
    expect(formatStreakDuration(192, TICK_MS)).toBe("~1.3d");
  });
});

describe("normalizeState — the state file round-trip", () => {
  /** Read back exactly the bytes `writeState` puts on disk. */
  const reload = (services: Record<string, ServiceState>) =>
    normalizeState(JSON.parse(serializeState(services)) as unknown);

  test("a v2 file round-trips streaks and escalation stamps intact", () => {
    const state: Record<string, ServiceState> = {
      "cron.render": { downStreak: 13, escalatedStreak: 12, status: "down" },
      web: { downStreak: 0, escalatedStreak: 0, status: "ok" },
    };

    expect(reload(state)).toEqual(state);
  });

  test("a streak survives the disk hop, so the ladder keeps counting across ticks", () => {
    // The whole mechanism depends on this: escalate at 6, persist, and the NEXT rung must
    // still be 12 after the state has been through the file.
    let state: ServiceState = { downStreak: 6, escalatedStreak: 6, status: "down" };

    for (let tick = 7; tick <= 12; tick += 1) {
      const previous = reload({ web: state }).web;

      state = nextServiceState(previous, "down");
      expect(state.downStreak).toBe(tick);
      expect(escalationDue(state, THRESHOLD)).toBe(tick === 12);
    }
  });

  test("the LEGACY flat map still parses — it just restarts the counters", () => {
    // The state file sitting on the box right now is this shape. A prober that threw on it
    // would take the dead-man's beacon down with it, so it degrades instead.
    expect(normalizeState({ "cron.render": "down", web: "ok" })).toEqual({
      "cron.render": { downStreak: 0, escalatedStreak: 0, status: "down" },
      web: { downStreak: 0, escalatedStreak: 0, status: "ok" },
    });
  });

  test("a legacy down entry earns its escalation from this tick, never retroactively", () => {
    const migrated = normalizeState({ "cron.render": "down" })["cron.render"];
    const advanced = nextServiceState(migrated, "down");

    expect(advanced.downStreak).toBe(1);
    expect(escalationDue(advanced, THRESHOLD)).toBe(false);
  });

  test("junk degrades to fresh state instead of throwing", () => {
    expect(normalizeState(null)).toEqual({});
    expect(normalizeState("not a map")).toEqual({});
    expect(normalizeState([1, 2, 3])).toEqual({});
    // Unknown statuses, wrong-typed counters, and v2's own scalar keys are all dropped or
    // floored rather than trusted.
    expect(normalizeState({ ghost: "sideways", version: 2 })).toEqual({});
    expect(
      normalizeState({
        services: { web: { downStreak: -4, escalatedStreak: "x", status: "down" } },
      }),
    ).toEqual({ web: { downStreak: 0, escalatedStreak: 0, status: "down" } });
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
