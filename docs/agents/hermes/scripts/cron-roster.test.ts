// THE EXPECTED-WRITERS GUARD — the prober's `AUTOMATION_CRONS`, `@fluncle/registry`'s cron
// probeConfigs, and the committed systemd timer units must all say the same thing.
//
// WHY THIS TEST EXISTS. Three files state one fact — which sweeps run, and how often:
//
//   1. `docs/agents/hermes/*/*.timer`      — the SCHEDULE, and the only one that is true
//                                            (systemd reads it; the others merely believe it)
//   2. `@fluncle/registry`'s probeConfig   — what /status calls the cron and how often it ticks
//   3. `AUTOMATION_CRONS` (the prober)     — the staleness budget a marker is judged against
//
// Nothing tested that they agreed, and they didn't. Measured 2026-07-29:
//
//   • `fluncle-frontier-refresh` moved from a Friday-07:00 burst to a 15-minute paced drain.
//     The timer said 15 min, the registry said 15 min, and the prober said SEVEN DAYS — a 3x
//     staleness budget of 21 days. A drain that died on the 1st would have read `fresh` until
//     the 22nd. Nobody was careless; the fact simply lived in three places and one was missed.
//   • `fluncle-timer-watchdog` and `fluncle-secrets-sync` appeared in NO list. Unlike the other
//     two non-writers (`pin-watch` self-posts `self-deploy`; `fluncle-healthcheck` self-emits
//     its own row) those two report to nothing at all — including, in the watchdog's case, a
//     detector whose whole job is noticing silence.
//
// AGENTS.md flags this class explicitly for the Cloudflare watch-paths mirror: "the two lists
// live in different places with NOTHING testing that they agree." This is that test, for these
// three, and it fails the build rather than filing a note.
//
// HOW IT CHECKS. cron-roster.ts derives the roster from the units themselves — the paired
// `.service`'s ExecStart, the `emit_cron_output <token>` it reaches, and the timer's own
// `OnUnitActiveSec=`/`OnCalendar=` — and every assertion below diffs a hand-carried list
// against that derivation. Both directions, every time: a missing entry and a phantom entry are
// the same bug wearing different clothes.
//
// NOT A DUPLICATE OF ITS SIBLING, and the difference is the whole point.
// apps/web/src/lib/server/hermes-healthcheck-coverage.test.ts already binds the registry to the
// prober — but only on the SET of ids, and only to each other. Neither of them reads a timer
// unit, so both pass happily while agreeing on a wrong number (the frontier-refresh cadence
// survived that gate untouched) and both pass on a cron whose timer has been deleted. This test
// adds the third corner: the units, plus cadence.
//
// The other sibling over this tree, install-host-timers.test.ts, asks whether the INSTALLER lays
// every unit down. This one asks whether every unit it lays down is actually WATCHED.
//
//   bun test docs/agents/hermes/scripts/cron-roster.test.ts

import { SURFACES } from "@fluncle/registry";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveTimerRoster,
  emitCronOutputTokens,
  NON_WRITER_TIMERS,
  parseOnCalendarMs,
  parseTimerCadenceMs,
  parseTimeSpanMs,
  readTimer,
} from "./cron-roster";
import { AUTOMATION_CRONS } from "./fluncle-healthcheck";

const HERMES_DIR = join(import.meta.dir, "..");
const ROSTER = deriveTimerRoster(HERMES_DIR);

/**
 * Registry cron surfaces that are probed WITHOUT a marker, so they are legitimately absent from
 * the prober's marker roster. `cron.healthcheck` is the prober itself: reaching the end of a
 * tick is the proof it ran, and reading a marker it wrote would be circular.
 */
const SELF_EVIDENT_CRON_SURFACES = new Set(["cron.healthcheck"]);

/**
 * Every registry surface that declares itself a probed cron, keyed by its `cron.<token>` name.
 * `cadenceMs` is OPTIONAL on `ProbeConfig`, so it is carried as possibly-absent and asserted
 * present below rather than coerced — an omitted cadence is its own drift, not a zero.
 */
function registryCrons(): Map<string, number | undefined> {
  const crons = new Map<string, number | undefined>();

  for (const surface of SURFACES) {
    if (surface.probeConfig?.kind === "cron") {
      crons.set(surface.name, surface.probeConfig.cadenceMs);
    }
  }

  return crons;
}

describe("the derivation itself", () => {
  test("reads every committed timer — nothing is left uninterpreted", () => {
    // An unreadable unit is never rounded to something plausible: it lands here by name, and
    // that is a build failure. A new `OnCalendar` shape, a `.timer` with no `.service`, or a
    // sweep reaching two cron tokens all surface here rather than producing a wrong number.
    expect(ROSTER.unreadable).toEqual([]);
    expect(ROSTER.crons.length).toBeGreaterThan(0);
  });

  test("every timer is either an expected writer or a declared non-writer", () => {
    // The one that catches a NEW timer: land a sweep whose script forgets `emit_cron_output`
    // and it is silent on /status forever. Here it fails the build until someone rules on it —
    // either wire the marker, or declare (with a reason) that this timer reports another way.
    const undeclared = ROSTER.nonWriters.filter((unit) => !(unit in NON_WRITER_TIMERS));

    expect(undeclared).toEqual([]);
  });

  test("no non-writer declaration outlives its reason", () => {
    // The exemption list is itself hand-kept, so it gets its own tripwire in both directions:
    // a declaration for a timer that has since gained a marker (it should be probed now), and
    // a declaration for a timer that no longer exists (dead weight that hides the next one).
    const derivedNonWriters = new Set(ROSTER.nonWriters);
    const writerUnits = new Set(ROSTER.crons.map((cron) => cron.unit));
    const stale = Object.keys(NON_WRITER_TIMERS).filter((unit) => !derivedNonWriters.has(unit));

    expect(stale.filter((unit) => writerUnits.has(unit))).toEqual([]); // now writes a marker
    expect(stale.filter((unit) => !writerUnits.has(unit))).toEqual([]); // no such timer
  });

  test("every declared non-writer says WHY in a sentence", () => {
    // "It's fine" is not a reason. The list is the record of four deliberate silences, and two
    // of them (secrets-sync, timer-watchdog) are recorded GAPS rather than settled decisions —
    // that distinction only survives if the reason is written down.
    for (const [unit, reason] of Object.entries(NON_WRITER_TIMERS)) {
      expect(reason.length, `${unit} needs a real reason`).toBeGreaterThan(20);
    }
  });
});

describe("AUTOMATION_CRONS agrees with the timer units", () => {
  test("the same set of crons, in both directions", () => {
    const derived = ROSTER.crons.map((cron) => cron.service).sort();
    const handCarried = AUTOMATION_CRONS.map((cron) => cron.service).sort();

    // A missing entry means a running sweep nobody watches; a phantom entry means a permanent
    // "no runs yet" row for a job that does not exist (the `cron.clip-drip` shape that earned
    // its place in RETIRED_SERVICE_IDS). Same assertion catches both.
    expect(handCarried).toEqual(derived);
  });

  test("the same cadence for every cron — the staleness budget is 3x this number", () => {
    const derived = new Map(ROSTER.crons.map((cron) => [cron.service, cron.cadenceMs]));
    const drifted = AUTOMATION_CRONS.filter(
      (cron) => derived.get(cron.service) !== cron.cadenceMs,
    ).map(
      (cron) =>
        `${cron.service}: prober ${cron.cadenceMs}ms vs unit ${derived.get(cron.service)}ms`,
    );

    expect(drifted).toEqual([]);
  });

  test("the match token is exactly the tail of the service id", () => {
    // `service` is mechanically `cron.<match>` — the token cron-output.sh bakes into the
    // marker header. A hand-written pair that breaks that shape would claim the wrong dir.
    for (const cron of AUTOMATION_CRONS) {
      expect(cron.service).toBe(`cron.${cron.match}`);
    }
  });

  test("longest-match-first claiming still resolves every token to one dir", () => {
    // `claimCronDirs` walks the crons longest-`match`-first and lets each claim one output
    // dir, which is what keeps `social-capture` from losing its dir to a bare `capture`. That
    // only works while every SHORTER token that is a substring of a longer one is preceded by
    // it in the sorted order — which sorting guarantees. What sorting does NOT guarantee is
    // that two crons share a token, so pin the uniqueness the whole scheme rests on.
    const tokens = AUTOMATION_CRONS.map((cron) => cron.match);

    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("the registry agrees with the timer units", () => {
  test("every derived writer has a registry cron surface, and vice versa", () => {
    // A registered cron with no timer is the `cron.clip-drip` failure verbatim: it reported
    // "no runs yet" on the public board for days while the box had neither script nor timer.
    // A timer with no registry surface is the `fluncle-live` failure: it ran for months with
    // no /status row at all. Both directions, one assertion.
    const derived = ROSTER.crons.map((cron) => cron.service).sort();
    const registered = [...registryCrons().keys()]
      .filter((name) => !SELF_EVIDENT_CRON_SURFACES.has(name))
      .sort();

    expect(registered).toEqual(derived);
  });

  test("the registry's cadence matches the timer's", () => {
    const registry = registryCrons();
    const drifted = ROSTER.crons
      .filter((cron) => registry.get(cron.service) !== cron.cadenceMs)
      .map(
        (cron) =>
          `${cron.service}: registry ${registry.get(cron.service)}ms vs unit ${cron.cadenceMs}ms`,
      );

    expect(drifted).toEqual([]);
  });

  test("every cron surface declares a cadence at all", () => {
    // `ProbeConfig.cadenceMs` is optional, and an absent one is not a zero — it is a /status
    // row with no freshness budget. Catch it here rather than letting the cadence diff below
    // read `undefined` as "nothing to compare".
    const cadenceless = [...registryCrons()]
      .filter(([, cadenceMs]) => cadenceMs === undefined)
      .map(([name]) => name);

    expect(cadenceless).toEqual([]);
  });

  test("a self-evident probe is a real registry surface, not a typo", () => {
    const registry = registryCrons();

    for (const name of SELF_EVIDENT_CRON_SURFACES) {
      expect(registry.has(name)).toBe(true);
    }
  });
});

describe("systemd time spans", () => {
  test("the suffixes the units actually use", () => {
    expect(parseTimeSpanMs("30s")).toBe(30_000);
    expect(parseTimeSpanMs("1min")).toBe(60_000);
    expect(parseTimeSpanMs("5min")).toBe(5 * 60_000);
    expect(parseTimeSpanMs("60min")).toBe(60 * 60_000);
    expect(parseTimeSpanMs("1h")).toBe(60 * 60_000);
    expect(parseTimeSpanMs("24h")).toBe(24 * 60 * 60_000);
  });

  test("a bare number is seconds, as systemd reads it", () => {
    expect(parseTimeSpanMs("90")).toBe(90_000);
  });

  test("compound spans add up", () => {
    expect(parseTimeSpanMs("1h 30min")).toBe(90 * 60_000);
    expect(parseTimeSpanMs("1h30min")).toBe(90 * 60_000);
  });

  test("an unknown or ambiguous unit is refused, never guessed", () => {
    // `month`/`year` are the ones that matter: systemd accepts them and their length varies,
    // so a silent approximation would put a wrong number straight into a staleness budget.
    expect(parseTimeSpanMs("1month")).toBeNull();
    expect(parseTimeSpanMs("2 years")).toBeNull();
    expect(parseTimeSpanMs("soon")).toBeNull();
    expect(parseTimeSpanMs("")).toBeNull();
  });
});

describe("OnCalendar periods", () => {
  test("the three shapes this repo uses", () => {
    expect(parseOnCalendarMs("*:0/15")).toBe(15 * 60_000);
    expect(parseOnCalendarMs("*-*-* 03:00:00 Europe/Amsterdam")).toBe(24 * 60 * 60_000);
    expect(parseOnCalendarMs("*-*-* 23:45:00 UTC")).toBe(24 * 60 * 60_000);
    expect(parseOnCalendarMs("Fri 15:00 Europe/Amsterdam")).toBe(7 * 24 * 60 * 60_000);
  });

  test("anything else is refused rather than approximated", () => {
    // Each of these HAS a period; none of them has the period the nearest understood shape
    // would give it. Refusing is the honest answer — the guard then names the unit.
    expect(parseOnCalendarMs("Mon,Thu 15:00")).toBeNull(); // twice a week, not weekly
    expect(parseOnCalendarMs("*:7/20")).toBeNull(); // does not divide the hour evenly
    expect(parseOnCalendarMs("2026-01-01 00:00:00")).toBeNull(); // a single date, not a period
    expect(parseOnCalendarMs("hourly")).toBeNull(); // a systemd alias this module has not learnt
    expect(parseOnCalendarMs("")).toBeNull();
  });
});

describe("reading a timer's cadence", () => {
  test("OnUnitActiveSec is the period", () => {
    expect(parseTimerCadenceMs("[Timer]\nOnBootSec=1min\nOnUnitActiveSec=5min\n")).toBe(5 * 60_000);
  });

  test("OnBootSec is NEVER the period", () => {
    // The trap this rules out: fluncle-live boots at 30s and then runs every minute. Reading
    // the boot offset would hand the prober a 30-second cadence — a 90-second staleness budget
    // on a sweep that legitimately answers every 60 seconds, i.e. permanent false alarms.
    expect(parseTimerCadenceMs("[Timer]\nOnBootSec=30s\n")).toBeNull();
  });

  test("OnCalendar is read only when there is no OnUnitActiveSec", () => {
    expect(parseTimerCadenceMs("[Timer]\nOnCalendar=*:0/15\n")).toBe(15 * 60_000);
  });

  test("commented-out directives do not count", () => {
    expect(parseTimerCadenceMs("[Timer]\n# OnUnitActiveSec=5min\nOnCalendar=*:0/15\n")).toBe(
      15 * 60_000,
    );
  });

  test("two periods are ambiguous, so neither wins", () => {
    expect(parseTimerCadenceMs("[Timer]\nOnUnitActiveSec=5min\nOnUnitActiveSec=1h\n")).toBeNull();
  });
});

describe("finding the emit_cron_output token", () => {
  test("a call is a call; a documented example is not", () => {
    // cron-output.sh's own header carries `emit_cron_output enrich -- …` inside a comment
    // block. Counting that as a call would give the helper a token and mis-resolve any unit
    // that mentions it — which the render conductor's unit does, on the same ExecStart line.
    const body = [
      "# usage:",
      "#     emit_cron_output enrich -- bun enrich-sweep.ts",
      "emit_cron_output backup -- bun backup-sweep.ts",
    ].join("\n");

    expect(emitCronOutputTokens(body)).toEqual(["backup"]);
  });

  test("the definition is not a call", () => {
    expect(emitCronOutputTokens('emit_cron_output() {\n  local job="$1"\n}')).toEqual([]);
  });
});

describe("the guard fires — a synthetic drift", () => {
  /** A throwaway hermes dir holding one timer + service pair and one sweep script. */
  function fakeHermes(options: {
    script?: string;
    service: string;
    timer: string;
    unit: string;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "fluncle-roster-"));
    const unitDir = join(root, "some-timer");

    mkdirSync(unitDir, { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(unitDir, `${options.unit}.timer`), options.timer);
    writeFileSync(join(unitDir, `${options.unit}.service`), options.service);

    if (options.script !== undefined) {
      writeFileSync(join(root, "scripts", "made-up-sweep.sh"), options.script);
    }

    return root;
  }

  const EXEC = "ExecStart=/usr/bin/docker exec hermes bash /opt/hermes-scripts/made-up-sweep.sh\n";

  test("a sweep behind a timer is derived with its unit's cadence", () => {
    const root = fakeHermes({
      script: "emit_cron_output made-up -- bun made-up-sweep.ts\n",
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnUnitActiveSec=7min\n",
      unit: "fluncle-made-up",
    });

    expect(deriveTimerRoster(root).crons).toEqual([
      {
        cadenceMs: 7 * 60_000,
        match: "made-up",
        service: "cron.made-up",
        unit: "fluncle-made-up.timer",
      },
    ]);
  });

  test("a cadence change in the unit alone moves the derived number", () => {
    // THE REGRESSION THAT STARTED THIS. Edit only the timer — exactly what happened when the
    // Frontier drain went from a weekly burst to a 15-minute drain — and the derivation follows
    // it. A prober literal left on the old number then fails the set/cadence assertions above.
    const weekly = fakeHermes({
      script: "emit_cron_output made-up -- bun made-up-sweep.ts\n",
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnCalendar=Fri 07:00 Europe/Amsterdam\n",
      unit: "fluncle-made-up",
    });
    const paced = fakeHermes({
      script: "emit_cron_output made-up -- bun made-up-sweep.ts\n",
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnCalendar=*:0/15\n",
      unit: "fluncle-made-up",
    });

    expect(deriveTimerRoster(weekly).crons[0]?.cadenceMs).toBe(7 * 24 * 60 * 60_000);
    expect(deriveTimerRoster(paced).crons[0]?.cadenceMs).toBe(15 * 60_000);
  });

  test("a sweep that writes no marker is a non-writer, not a silent pass", () => {
    const root = fakeHermes({
      script: "bun made-up-sweep.ts\n", // no emit_cron_output anywhere
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnUnitActiveSec=7min\n",
      unit: "fluncle-made-up",
    });
    const roster = deriveTimerRoster(root);

    expect(roster.crons).toEqual([]);
    expect(roster.nonWriters).toEqual(["fluncle-made-up.timer"]);
  });

  test("a timer whose script is missing is unreadable, not a non-writer", () => {
    // The difference matters: "writes no marker" is a ruling someone can make, while "I could
    // not find the script" is a broken repo. Collapsing the two would let a deleted sweep pass
    // as a deliberate silence.
    const root = fakeHermes({
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnUnitActiveSec=7min\n",
      unit: "fluncle-made-up",
    });
    const roster = deriveTimerRoster(root);

    expect(roster.nonWriters).toEqual([]);
    expect(roster.unreadable).toHaveLength(1);
    expect(roster.unreadable[0]?.problem).toContain("no source under scripts/");
  });

  test("a timer with no service beside it is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-roster-"));

    mkdirSync(join(root, "orphan-timer"), { recursive: true });
    writeFileSync(
      join(root, "orphan-timer", "fluncle-orphan.timer"),
      "[Timer]\nOnCalendar=*:0/15\n",
    );

    expect(deriveTimerRoster(root).unreadable[0]?.problem).toContain(
      "nothing says what this timer runs",
    );
  });

  test("an unreadable cadence fails the unit rather than defaulting", () => {
    const root = fakeHermes({
      script: "emit_cron_output made-up -- bun made-up-sweep.ts\n",
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnCalendar=quarterly\n",
      unit: "fluncle-made-up",
    });
    const roster = deriveTimerRoster(root);

    expect(roster.crons).toEqual([]);
    expect(roster.unreadable[0]?.problem).toContain("no cadence");
  });

  test("an ExecStart that reaches two tokens is refused", () => {
    const root = fakeHermes({
      script: "emit_cron_output one -- bun a.ts\nemit_cron_output two -- bun b.ts\n",
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnUnitActiveSec=7min\n",
      unit: "fluncle-made-up",
    });

    expect(deriveTimerRoster(root).unreadable[0]?.problem).toContain("more than one cron token");
  });

  test("an inline emit_cron_output in the unit wins over the scripts it names", () => {
    // The render conductor's shape: the unit sources cron-output.sh and calls the helper
    // itself, on the same line as the script it wraps. Resolving scripts first would have to
    // choose between two candidates when the unit has already answered.
    const root = mkdtempSync(join(tmpdir(), "fluncle-roster-"));
    const unitDir = join(root, "render-timer");

    mkdirSync(unitDir, { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(unitDir, "fluncle-render.timer"), "[Timer]\nOnUnitActiveSec=60min\n");
    writeFileSync(
      join(unitDir, "fluncle-render.service"),
      "[Service]\nExecStart=/usr/bin/docker exec hermes bash -c '. /opt/hermes-scripts/cron-output.sh && emit_cron_output render -- bash /opt/hermes-scripts/render-conductor.sh'\n",
    );

    expect(deriveTimerRoster(root).crons[0]?.match).toBe("render");
  });

  test("a template unit is skipped, exactly as the installer skips it", () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-roster-"));

    mkdirSync(join(root, "sweep-failure"), { recursive: true });
    writeFileSync(join(root, "sweep-failure", "fluncle-sweep-failure@.timer"), "[Timer]\n");

    const roster = deriveTimerRoster(root);

    expect(roster.crons).toEqual([]);
    expect(roster.nonWriters).toEqual([]);
    expect(roster.unreadable).toEqual([]);
  });
});

describe("readTimer on the real units", () => {
  test("the render conductor resolves through its inline wrapper", () => {
    const reading = readTimer(
      join(HERMES_DIR, "render-timer", "fluncle-render.timer"),
      join(HERMES_DIR, "scripts"),
    );

    expect(reading).toEqual({
      cadenceMs: 60 * 60_000,
      kind: "writer",
      match: "render",
      unit: "fluncle-render.timer",
    });
  });

  test("a sweep whose token differs from its script name still resolves", () => {
    // `clip-sweep.sh` emits `studio-clip`, and `observe-sweep.sh` emits `observation`. Deriving
    // the token from the FILENAME would have got both wrong; it comes from the call.
    const reading = readTimer(
      join(HERMES_DIR, "studio-clip-timer", "fluncle-studio-clip.timer"),
      join(HERMES_DIR, "scripts"),
    );

    expect(reading).toMatchObject({ kind: "writer", match: "studio-clip" });
  });
});
