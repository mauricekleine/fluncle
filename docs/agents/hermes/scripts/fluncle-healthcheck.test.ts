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
  buildStrainAlert,
  countDistressLines,
  countSummaryStrain,
  type CronDef,
  cronCheck,
  escalationDue,
  findJsonSummary,
  foldStrain,
  formatStreakDuration,
  isStrained,
  judgeCron,
  markerStrain,
  nextServiceState,
  normalizeState,
  normalizeStrain,
  serializeState,
  type ServiceState,
  STDERR_DELIMITER,
  type StrainState,
  strainTotals,
  sweepStrainCheck,
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

// ---------------------------------------------------------------------------
// THE STRAIN DETECTOR — the second read of the same marker.
//
// The two fixtures below ARE the specification. They are real box output, aggregated over two
// days and sorted by frequency; the split between them is the operator's own judgement about
// which lines are a problem. A detector is only as good as its behaviour on this exact table,
// in BOTH directions — the errors have to fire it, and the 1,200-a-day success chatter must
// not. (The plumbing that carries these lines from a sweep's stderr to the marker on disk is
// proven separately, against the real bash, in cron-output.test.ts.)
// ---------------------------------------------------------------------------

/** Lines the operator classed as REAL PROBLEMS. Every one must score. */
const REAL_PROBLEMS: readonly { count: number; line: string }[] = [
  {
    count: 347,
    line: "[capture-sweep] bot-challenged at search — re-rolling the proxy session for a fresh exit",
  },
  {
    count: 263,
    line: "[capture-sweep] bot-challenged at download — re-rolling the proxy session for a fresh exit",
  },
  {
    count: 92,
    line: "[entity-bio-sweep] future-signal: the voice gate / length rejected the bio — skipping (stays queued)",
  },
  {
    count: 91,
    line: "[entity-bio-sweep] jungle-sound-the-bassline-strikes-back: the voice gate / length rejected the bio — skipping (stays queued)",
  },
  {
    count: 90,
    line: "[entity-bio-sweep] invaderz-transmissions: the voice gate / length rejected the bio — skipping (stays queued)",
  },
  {
    count: 76,
    line: "[crawl-sweep] MusicBrainz throttled the pass — stopped clean; the next tick resumes.",
  },
  { count: 50, line: "[fluncle-live] poll failed, retrying once: The operation was aborted." },
  {
    count: 49,
    line: "[fluncle-healthcheck] record_health POST attempt 1/3 failed (The operation was aborted.); retrying",
  },
];

/** Benign high-volume chatter. NONE of it may score — this is the false-positive gate. */
const BENIGN_CHATTER: readonly { count: number; line: string }[] = [
  { count: 471, line: "[embed-sweep] mb_<id>: embedded + written" },
  { count: 454, line: "[enrich-sweep] mb_<id>: catalogue done (bpm null, key null)" },
  { count: 153, line: "[enrich-sweep] mb_<id>: catalogue done (bpm 174.02, key null)" },
  {
    count: 92,
    line: "[entity-bio-sweep] future-signal: authoring with Worker-gathered Firecrawl facts",
  },
  {
    count: 48,
    line: "[pin-watch] baked paths (derived from the docs/agents/hermes/Dockerfile COPY set): scripts skills Dockerfile",
  },
];

/** A marker carrying a summary plus the given stderr lines, in the wrapper's exact shape. */
function strainMarker(summary: string, stderrLines: readonly string[]): string {
  const tail =
    stderrLines.length === 0
      ? ""
      : `${STDERR_DELIMITER}\n${stderrLines.map((line) => `> ${line}`).join("\n")}\n`;

  return `# Cron Job: fluncle-backup\n\n${summary}\n${tail}`;
}

describe("the strain vocabulary against the real box output", () => {
  test("EVERY real problem line scores (the detector FIRES)", () => {
    const missed = REAL_PROBLEMS.filter(({ line }) => countDistressLines(`> ${line}`) === 0);

    expect(missed.map((entry) => entry.line)).toEqual([]);
  });

  test("EVERY benign chatter line scores zero (the detector STAYS QUIET)", () => {
    const tripped = BENIGN_CHATTER.filter(({ line }) => countDistressLines(`> ${line}`) > 0);

    expect(tripped.map((entry) => entry.line)).toEqual([]);
  });

  test("the busiest benign line cannot trip the detector at ANY volume", () => {
    // 471 embed successes in two days is the highest-frequency line on the box. Feed one tick
    // 500 of them: still zero. This is the whole reason the rule is a named-phrase list rather
    // than something like /error/i.
    const flood = Array.from({ length: 500 }, () => BENIGN_CHATTER[0]?.line ?? "");

    expect(markerStrain(strainMarker('{"ok":true,"embedded":500}', flood))).toBe(0);
  });

  test("the per-row catch line every sweep shares is caught", () => {
    // `error on <id>: …` and `unexpected error on <id>: …` are the shared per-item catch in
    // ~10 sweeps — the single most common way a sweep says "this one did not get done". They
    // were MISSED by the first draft of the vocabulary; an audit over all 238 `log()` string
    // literals in this directory is what surfaced them. Same for claude's own error envelope,
    // which is the signature of an authoring tick that left its item queued.
    expect(countDistressLines("> [note-sweep] error on 241.7.3A: Firecrawl 502")).toBe(1);
    expect(countDistressLines("> [capture-sweep] unexpected error on mb_x: socket closed")).toBe(1);
    expect(
      countDistressLines(
        "> [logbook-sweep] claude -p returned is_error (max_turns) — leaving day queued",
      ),
    ).toBe(1);
    expect(countDistressLines("> [rank-sweep] fatal: cannot reach the Worker")).toBe(1);
  });

  test("a mixed tick counts only the problems", () => {
    const body = strainMarker('{"ok":true}', [
      ...BENIGN_CHATTER.map((entry) => entry.line),
      ...REAL_PROBLEMS.map((entry) => entry.line),
    ]);

    expect(markerStrain(body)).toBe(REAL_PROBLEMS.length);
  });
});

describe("the summary half — the sweeps' own counters", () => {
  test("failure counters and distress flags score; success counters do not", () => {
    // entity-bio's real summary shape: the gate skips ARE the stuck loop, in its own numbers.
    expect(countSummaryStrain({ authored: 0, gateSkipped: 3, ok: true, queueRemaining: 40 })).toBe(
      3,
    );
    // crawl's real summary shape: `throttled` is a boolean, worth one point.
    expect(countSummaryStrain({ ok: true, throttled: true, tracksWritten: 120 })).toBe(1);
    // capture's real summary shape: `skipped`/`unmatched` are ordinary outcomes, not failures.
    expect(countSummaryStrain({ done: 4, failed: 2, ok: true, skipped: 6, unmatched: 3 })).toBe(2);
    // A clean tick scores nothing at all, whatever else it reports.
    expect(countSummaryStrain({ done: 10, embedded: 471, ok: true })).toBe(0);
    expect(countSummaryStrain(null)).toBe(0);
  });

  test("a sweep's own `{ ok }` verdict is NEVER touched by any of this", () => {
    // THE FIRST CONSTRAINT: strain must not falsify a sweep's report. A marker with 200 error
    // lines still reads `fresh-ok` to judgeCron, because that is what the sweep actually said.
    const body = strainMarker(
      '{"ok":true,"batch":10,"failed":10}',
      Array.from({ length: 200 }, () => REAL_PROBLEMS[0]?.line ?? ""),
    );
    const dir = markerDir([{ ageMs: 60_000, body }]);

    expect(findJsonSummary(body)).toMatchObject({ ok: true });
    expect(judgeCron(CRON, dir)).toBe("fresh-ok");
    expect(cronCheck(CRON, judgeCron(CRON, dir)).status).toBe("ok");

    // …and yet the strain is fully visible on the separate signal: 200 lines + 10 `failed`.
    expect(markerStrain(body)).toBe(210);
  });
});

describe("splitMarker / findJsonSummary across the delimiter", () => {
  test("a stderr line that looks like a summary cannot become one", () => {
    const body = strainMarker('{"ok":true,"real":1}', ['{"ok":false,"reason":"a log line"}']);

    expect(findJsonSummary(body)).toEqual({ ok: true, real: 1 });
  });

  test("an old-shaped marker (no delimiter) reads exactly as it always did", () => {
    expect(findJsonSummary(marker('{"ok":true}\ntrailing noise\n'))).toEqual({ ok: true });
    expect(markerStrain(marker('{"ok":true}\n'))).toBe(0);
  });

  test("a killed run's header-only marker scores nothing and carries no summary", () => {
    expect(markerStrain(KILLED_MARKER)).toBe(0);
    expect(findJsonSummary(KILLED_MARKER)).toBeNull();
  });
});

describe("the rolling window", () => {
  const HOUR = 60 * 60_000;

  test("samples accrue into hourly buckets and age out of the window", () => {
    const now = 10 * HOUR;
    // Two heavy ticks 7 hours ago (outside the default 6h window) and two light ones just now.
    const state = foldStrain(
      undefined,
      [
        { atMs: now - 7 * HOUR, points: 50 },
        { atMs: now - 7 * HOUR + 60_000, points: 50 },
        { atMs: now - 1000, points: 4 },
        { atMs: now - 500, points: 5 },
      ],
      now,
    );

    expect(strainTotals(state, now)).toEqual({ points: 9, ticks: 2 });
  });

  test("the watermark advances so a marker is never counted twice", () => {
    const now = 5 * HOUR;
    const first = foldStrain(undefined, [{ atMs: now - 1000, points: 6 }], now);

    expect(first.watermarkMs).toBe(now - 1000);

    // The next tick re-reads the dir; readStrainSamples filters by this watermark, so only
    // genuinely new markers fold in.
    const second = foldStrain(first, [{ atMs: now - 500, points: 6 }], now);

    expect(strainTotals(second, now)).toEqual({ points: 12, ticks: 2 });
    expect(second.watermarkMs).toBe(now - 500);
  });

  test("a clean tick advances the watermark and accrues nothing", () => {
    const now = 3 * HOUR;
    const state = foldStrain(undefined, [{ atMs: now - 100, points: 0 }], now);

    expect(state.watermarkMs).toBe(now - 100);
    expect(strainTotals(state, now)).toEqual({ points: 0, ticks: 0 });
  });
});

describe("the two gates — enough evidence AND enough spread", () => {
  test("one catastrophic tick does NOT strain (that case belongs to judgeCron)", () => {
    expect(isStrained({ points: 400, ticks: 1 })).toBe(false);
    expect(isStrained({ points: 40, ticks: 2 })).toBe(false);
  });

  test("a trickle across many ticks does not strain until the evidence adds up", () => {
    expect(isStrained({ points: 11, ticks: 11 })).toBe(false);
    expect(isStrained({ points: 12, ticks: 3 })).toBe(true);
  });

  test("the measured capture condition strains; a quiet morning does not", () => {
    // capture logged ~305 bot-challenges a day → ~76 in a 6h window, spread over many ticks.
    expect(isStrained({ points: 76, ticks: 40 })).toBe(true);
    // A handful of transient retries across a morning is exactly the noise we must not page on.
    expect(isStrained({ points: 5, ticks: 4 })).toBe(false);
  });
});

describe("the sweep-errors row + the strain alert", () => {
  test("clean reads ok; strained reads degraded and NEVER down", () => {
    expect(sweepStrainCheck([])).toMatchObject({ message: "no repeat errors", status: "ok" });

    const check = sweepStrainCheck(["cron.capture", "cron.artist-bio", "cron.crawl"]);

    expect(check.status).toBe("degraded");
    expect(check.message).toBe("3 sweeps logging repeat errors: capture, artist-bio, crawl");
    expect(check.service).toBe("sweep-errors");
  });

  test("one strained sweep reads in the singular", () => {
    expect(sweepStrainCheck(["cron.capture"]).message).toBe(
      "1 sweep logging repeat errors: capture",
    );
  });

  test("the message stays inside the public-safe 120-char cap", () => {
    const many = Array.from({ length: 30 }, (_, index) => `cron.sweep-number-${index}`);

    expect((sweepStrainCheck(many).message ?? "").length).toBeLessThanOrEqual(120);
  });

  test("the Discord line is edge-triggered on entering and on leaving", () => {
    expect(buildStrainAlert([], [])).toBeNull();
    expect(buildStrainAlert(["cron.capture"], [])).toContain("cron.capture");
    expect(buildStrainAlert([], ["cron.crawl"])).toContain("quiet again: cron.crawl");
  });
});

describe("normalizeStrain — the v3 state section", () => {
  test("a v1/v2 file with no strain section loads empty, never throws", () => {
    expect(normalizeStrain({ web: "ok" })).toEqual({});
    expect(normalizeStrain({ services: {}, version: 2 })).toEqual({});
    expect(normalizeStrain(null)).toEqual({});
    expect(normalizeStrain("nonsense")).toEqual({});
  });

  test("junk inside the section is floored rather than trusted", () => {
    expect(
      normalizeStrain({
        strain: {
          "cron.capture": {
            buckets: { "3600000": { points: -5, ticks: "x" }, bad: null },
            strained: "yes",
            watermarkMs: -1,
          },
        },
      }),
    ).toEqual({
      "cron.capture": {
        buckets: { "3600000": { points: 0, ticks: 0 } },
        strained: false,
        watermarkMs: 0,
      },
    });
  });

  test("a real v3 file round-trips through serialize → parse → normalize", () => {
    const strain: Record<string, StrainState> = {
      "cron.capture": {
        buckets: { "7200000": { points: 40, ticks: 12 } },
        strained: true,
        watermarkMs: 7_260_000,
      },
    };
    const parsed: unknown = JSON.parse(serializeState({}, strain));

    expect(normalizeStrain(parsed)).toEqual(strain);
    expect(normalizeState(parsed)).toEqual({});
  });
});
