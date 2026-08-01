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
  backpressureTotal,
  boxUptimeMs,
  buildEscalationAlert,
  buildStrainAlert,
  countDistressLines,
  countSummaryBackpressure,
  countSummaryStrain,
  type CronDef,
  cronCheck,
  escalationDue,
  findJsonSummary,
  foldStrain,
  formatStreakDuration,
  isStrained,
  judgeCron,
  markerBackpressure,
  markerStrain,
  nextServiceState,
  normalizeState,
  normalizeStrain,
  probeSweepStrain,
  serializeState,
  type ServiceState,
  STDERR_DELIMITER,
  STRAIN_ITEM_FAILURE_RATE,
  type StrainState,
  strainMinimumPoints,
  strainTotals,
  strainWindowMs,
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

/** Real observed problem prose on the rate-gated path. Every line must remain recognizable. */
const REAL_PROBLEMS: readonly { count: number; line: string }[] = [
  // The UNCLEARED challenge — the run's one re-roll is already spent, so the track is lost.
  // Its cleared sibling lives in BENIGN_CHATTER below: a challenge that re-rolls to a fresh
  // exit and then succeeds is recovered friction on a healthy tick, and at ~12% of runs it
  // would hold capture at `degraded` forever if it scored (#996).
  {
    count: 43,
    line: "[capture-sweep] bot-challenged at download (rerolled=false) — the run's one re-roll is already spent",
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
  { count: 50, line: "[fluncle-live] poll failed, retrying once: The operation was aborted." },
  {
    count: 49,
    line: "[fluncle-healthcheck] record_health POST attempt 1/3 failed (The operation was aborted.); retrying",
  },
];

/** Designed backpressure. It remains measured, but it is not failed work. */
const DESIGNED_BACKPRESSURE = {
  count: 76,
  line: "[crawl-sweep] MusicBrainz throttled the pass — stopped clean; the next tick resumes.",
};

/** Benign high-volume chatter. NONE of it may score — this is the false-positive gate. */
const BENIGN_CHATTER: readonly { count: number; line: string }[] = [
  // The CLEARED challenge and the per-tick recap (#996). One hyphen separates this from the
  // uncleared line above: "bot challenge" (a space) is not the `bot-challenged` STRAIN_PHRASES
  // entry, so recovered friction stays silent while a lost track still scores.
  {
    count: 567,
    line: "[capture-sweep] bot challenge at search (rerolled=true) — moving to a fresh residential exit",
  },
  {
    count: 425,
    line: "[capture-sweep] bot challenges this tick: 3 (2 cleared by a re-roll, 1 with the re-roll spent)",
  },
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
  test("per-row catch lines at a healthy item-failure rate contribute no strain", () => {
    const lines = [
      "[anchor-sweep] error on mb_1: transient Deezer failure",
      "[anchor-sweep] unexpected error on mb_2: socket closed",
    ];

    expect(markerStrain(strainMarker('{"checked":12,"ok":true}', lines))).toBe(0);
  });

  test("genuine run-level prose still contributes strain directly", () => {
    expect(
      markerStrain(
        strainMarker('{"checked":12,"ok":true}', ["[rank-sweep] fatal: cannot reach the Worker"]),
      ),
    ).toBe(1);
    expect(
      markerStrain(
        strainMarker('{"checked":12,"ok":true}', [
          "[note-sweep] claude auth failed — aborting the batch, the queue is untouched",
        ]),
      ),
    ).toBe(1);
  });

  test("item-level prose with no checked denominator contributes nothing", () => {
    expect(
      markerStrain(
        strainMarker('{"ok":true}', [
          "[anchor-sweep] error on mb_1: transient Deezer failure",
          "[capture-sweep] bot-challenged at download (rerolled=false)",
        ]),
      ),
    ).toBe(0);
  });

  test("a genuinely high prose item-failure rate still contributes one point", () => {
    const lines = Array.from(
      { length: 6 },
      (_, index) => `[anchor-sweep] error on mb_${index}: transient Deezer failure`,
    );

    expect(markerStrain(strainMarker('{"checked":12,"ok":true}', lines))).toBe(1);
  });

  test("EVERY observed problem line survives on the item-rate path", () => {
    const missed = REAL_PROBLEMS.filter(({ line }) => countDistressLines(`> ${line}`, 1) === 0);

    expect(missed.map((entry) => entry.line)).toEqual([]);
  });

  test("EVERY benign chatter line scores zero (the detector STAYS QUIET)", () => {
    const tripped = BENIGN_CHATTER.filter(({ line }) => countDistressLines(`> ${line}`) > 0);

    expect(tripped.map((entry) => entry.line)).toEqual([]);
  });

  test("designed throttling contributes zero strain while a run failure still scores", () => {
    const yielded = strainMarker('{"ok":true,"throttled":true}', [DESIGNED_BACKPRESSURE.line]);
    const failed = strainMarker('{"errors":1,"ok":false}', [
      "[crawl-sweep] fatal: the run aborted",
    ]);

    expect(countDistressLines(`> ${DESIGNED_BACKPRESSURE.line}`)).toBe(0);
    expect(countSummaryBackpressure(findJsonSummary(yielded))).toBe(1);
    expect(markerBackpressure(yielded)).toBe(1);
    expect(markerStrain(yielded)).toBe(0);
    expect(markerBackpressure(failed)).toBe(0);
    expect(markerStrain(failed)).toBe(2);
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
    expect(countDistressLines("> [note-sweep] error on 241.7.3A: Firecrawl 502", 1)).toBe(1);
    expect(countDistressLines("> [capture-sweep] unexpected error on mb_x: socket closed", 1)).toBe(
      1,
    );
    expect(
      countDistressLines(
        "> [logbook-sweep] claude -p returned is_error (max_turns) — leaving day queued",
        1,
      ),
    ).toBe(1);
    expect(countDistressLines("> [rank-sweep] fatal: cannot reach the Worker")).toBe(1);
  });

  test("a mixed tick collapses item prose to one rate-gated point", () => {
    const body = strainMarker('{"checked":12,"ok":true}', [
      ...BENIGN_CHATTER.map((entry) => entry.line),
      ...REAL_PROBLEMS.map((entry) => entry.line),
    ]);

    expect(markerStrain(body)).toBe(1);
  });
});

describe("the summary half — the sweeps' own counters", () => {
  test("direct failure counters score; designed backpressure and success counters do not", () => {
    // entity-bio's real summary shape: the gate skips ARE the stuck loop, in its own numbers.
    expect(countSummaryStrain({ authored: 0, gateSkipped: 3, ok: true, queueRemaining: 40 })).toBe(
      3,
    );
    // crawl's real summary shape: designed backpressure is visible on its separate axis.
    expect(countSummaryStrain({ ok: true, throttled: true, tracksWritten: 120 })).toBe(0);
    expect(countSummaryBackpressure({ ok: true, throttled: true, tracksWritten: 120 })).toBe(1);
    // A clean tick scores nothing at all, whatever else it reports.
    expect(countSummaryStrain({ done: 10, embedded: 471, ok: true })).toBe(0);
    expect(countSummaryStrain(null)).toBe(0);
  });

  test("HEADLINE: an exit-0 capture-shaped 4/12 partial batch contributes no strain", () => {
    const summary = { checked: 12, errors: 0, failed: 4, ok: true };
    const stderr = Array.from(
      { length: 4 },
      (_, index) => `[capture-sweep] capture failed for catalogue (mb_${index}): bot challenge`,
    );

    expect(countSummaryStrain(summary)).toBe(0);
    // Structured `failed` owns this marker, so duplicate prose cannot restore occurrence counting.
    expect(markerStrain(strainMarker(JSON.stringify(summary), stderr))).toBe(0);
  });

  test("a genuine run failure still contributes strain", () => {
    expect(countSummaryStrain({ checked: 12, errors: 1, failed: 4, ok: false })).toBe(1);
  });

  test("a genuinely high item-failure rate still contributes one point", () => {
    expect(STRAIN_ITEM_FAILURE_RATE).toBe(0.5);
    expect(countSummaryStrain({ checked: 12, failed: 5, ok: true })).toBe(0);
    expect(countSummaryStrain({ checked: 12, failed: 6, ok: true })).toBe(1);
    expect(
      countSummaryStrain({
        checked: 6,
        failed: ["youtube", "telegram", "bluesky"],
        ok: true,
      }),
    ).toBe(1);
  });

  test("failed with no usable checked denominator contributes nothing", () => {
    expect(countSummaryStrain({ failed: 400, ok: true })).toBe(0);
    expect(countSummaryStrain({ checked: 0, failed: 400, ok: true })).toBe(0);
    expect(countSummaryStrain({ failed: ["youtube", "telegram", "bluesky"], ok: true })).toBe(0);
    expect(
      markerStrain(
        strainMarker('{"failed":1,"ok":true}', [
          "[capture-sweep] capture failed for catalogue (mb_x): bot challenge",
        ]),
      ),
    ).toBe(0);
    expect(markerStrain(strainMarker('{"ok":true}', ["[legacy-sweep] 400 items failed"]))).toBe(0);
  });

  test("nullable error strings preserve their real value shape", () => {
    expect(countSummaryStrain({ error: "Apify returned 502", ok: true })).toBeGreaterThanOrEqual(1);
    expect(countSummaryStrain({ error: null, failed: [], ok: true })).toBe(0);
  });

  test("a sweep's own `{ ok }` verdict is NEVER touched by any of this", () => {
    // THE FIRST CONSTRAINT: strain must not falsify a sweep's report. A marker with 200 error
    // lines still reads `fresh-ok` to judgeCron, because that is what the sweep actually said.
    const body = strainMarker(
      '{"ok":true,"checked":10,"failed":10}',
      Array.from({ length: 200 }, () => REAL_PROBLEMS[0]?.line ?? ""),
    );
    const dir = markerDir([{ ageMs: 60_000, body }]);

    expect(findJsonSummary(body)).toMatchObject({ ok: true });
    expect(judgeCron(CRON, dir)).toBe("fresh-ok");
    expect(cronCheck(CRON, judgeCron(CRON, dir)).status).toBe("ok");

    // …and yet the high item-failure rate is visible as ONE tick, without 210× double-counting.
    expect(markerStrain(body)).toBe(1);
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

  test("designed backpressure accrues on its own axis without a strain tick", () => {
    const now = 3 * HOUR;
    const state = foldStrain(undefined, [{ atMs: now - 100, backpressure: 1, points: 0 }], now);

    expect(backpressureTotal(state, now)).toBe(1);
    expect(strainTotals(state, now)).toEqual({ points: 0, ticks: 0 });
  });

  test("a daily cron can be judged across three scheduled ticks", () => {
    const failedTick = strainMarker('{"checked":2,"failed":1,"ok":true}', []);
    const dir = markerDir([
      { ageMs: 48 * HOUR, body: failedTick },
      { ageMs: 24 * HOUR, body: failedTick },
      { ageMs: HOUR, body: failedTick },
    ]);
    const result = probeSweepStrain(new Map([[CRON.service, dir]]), {});
    const windowMs = strainWindowMs(CRON.cadenceMs);

    expect(windowMs).toBe(72 * HOUR);
    expect(strainTotals(result.next[CRON.service], Date.now(), windowMs)).toEqual({
      points: 3,
      ticks: 3,
    });
    expect(result.strained).toEqual([CRON.service]);
  });
});

describe("the two gates — enough evidence AND enough spread", () => {
  test("one catastrophic tick does NOT strain (that case belongs to judgeCron)", () => {
    expect(isStrained({ points: 400, ticks: 1 }, 12)).toBe(false);
    expect(isStrained({ points: 40, ticks: 2 }, 12)).toBe(false);
  });

  test("a trickle across many ticks does not strain until the evidence adds up", () => {
    expect(isStrained({ points: 11, ticks: 11 }, 12)).toBe(false);
    expect(isStrained({ points: 12, ticks: 3 }, 12)).toBe(true);
  });

  test("the point bar follows cadence instead of a global absolute", () => {
    const minute = 60_000;
    const fastWindow = strainWindowMs(minute);
    const captureWindow = strainWindowMs(5 * minute);
    const weeklyWindow = strainWindowMs(7 * 24 * 60 * minute);

    expect(fastWindow).toBe(6 * 60 * minute);
    expect(strainMinimumPoints(minute, fastWindow)).toBe(90);
    expect(strainMinimumPoints(5 * minute, captureWindow)).toBe(18);
    expect(strainMinimumPoints(7 * 24 * 60 * minute, weeklyWindow)).toBe(1);
    expect(isStrained({ points: 17, ticks: 17 }, 18)).toBe(false);
    expect(isStrained({ points: 18, ticks: 3 }, 18)).toBe(true);
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

  test("clean backpressure stays visible without degrading the row", () => {
    expect(sweepStrainCheck([], ["cron.crawl", "cron.label-images"])).toMatchObject({
      message: "no repeat errors; 2 sweeps yielded cleanly: crawl, label-images",
      status: "ok",
    });
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

describe("normalizeStrain — the v5 state section", () => {
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
            buckets: {
              "3600000": { backpressure: -2, points: -5, ticks: "x" },
              "7200000": { backpressure: 3, points: 0, ticks: 0 },
              bad: null,
            },
            strained: "yes",
            watermarkMs: -1,
          },
        },
        version: 5,
      }),
    ).toEqual({
      "cron.capture": {
        buckets: {
          "3600000": { points: 0, ticks: 0 },
          "7200000": { backpressure: 3, points: 0, ticks: 0 },
        },
        strained: false,
        watermarkMs: 0,
      },
    });
  });

  test("v4 points are discarded while the prior strained flag survives for a clear alert", () => {
    expect(
      normalizeStrain({
        strain: {
          "cron.capture": {
            buckets: { "7200000": { points: 400, ticks: 12 } },
            strained: true,
            watermarkMs: 7_260_000,
          },
        },
        version: 4,
      }),
    ).toEqual({
      "cron.capture": {
        buckets: {},
        strained: true,
        watermarkMs: 0,
      },
    });
  });

  test("a real v5 file round-trips through serialize → parse → normalize", () => {
    const strain: Record<string, StrainState> = {
      "cron.capture": {
        buckets: { "7200000": { backpressure: 2, points: 40, ticks: 12 } },
        strained: true,
        watermarkMs: 7_260_000,
      },
    };
    const parsed: unknown = JSON.parse(serializeState({}, strain));

    expect(normalizeStrain(parsed)).toEqual(strain);
    expect(normalizeState(parsed)).toEqual({});
  });
});
