import { SURFACES } from "@fluncle/registry";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const HERMES_DIR = join(import.meta.dir, "..");
const ROSTER = deriveTimerRoster(HERMES_DIR);

const SELF_EVIDENT_CRON_SURFACES = new Set(["cron.healthcheck"]);

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
    expect(ROSTER.unreadable).toEqual([]);
    expect(ROSTER.crons.length).toBeGreaterThan(0);
  });

  test("every timer is either an expected writer or a declared non-writer", () => {
    const undeclared = ROSTER.nonWriters.filter((unit) => !(unit in NON_WRITER_TIMERS));

    expect(undeclared).toEqual([]);
  });

  test("no non-writer declaration outlives its reason", () => {
    const derivedNonWriters = new Set(ROSTER.nonWriters);
    const writerUnits = new Set(ROSTER.crons.map((cron) => cron.unit));
    const stale = Object.keys(NON_WRITER_TIMERS).filter((unit) => !derivedNonWriters.has(unit));

    expect(stale.filter((unit) => writerUnits.has(unit))).toEqual([]);
    expect(stale.filter((unit) => !writerUnits.has(unit))).toEqual([]);
  });

  test("every declared non-writer says WHY in a sentence", () => {
    for (const [unit, reason] of Object.entries(NON_WRITER_TIMERS)) {
      expect(reason.length, `${unit} needs a real reason`).toBeGreaterThan(20);
    }
  });
});

describe("AUTOMATION_CRONS agrees with the timer units", () => {
  test("the same set of crons, in both directions", () => {
    const derived = ROSTER.crons.map((cron) => cron.service).sort();
    const handCarried = AUTOMATION_CRONS.map((cron) => cron.service).sort();

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
    for (const cron of AUTOMATION_CRONS) {
      expect(cron.service).toBe(`cron.${cron.match}`);
    }
  });

  test("longest-match-first claiming still resolves every token to one dir", () => {
    const tokens = AUTOMATION_CRONS.map((cron) => cron.match);

    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("the registry agrees with the timer units", () => {
  test("every derived writer has a registry cron surface, and vice versa", () => {
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
    expect(parseOnCalendarMs("Mon,Thu 15:00")).toBeNull();
    expect(parseOnCalendarMs("*:7/20")).toBeNull();
    expect(parseOnCalendarMs("2026-01-01 00:00:00")).toBeNull();
    expect(parseOnCalendarMs("hourly")).toBeNull();
    expect(parseOnCalendarMs("")).toBeNull();
  });
});

describe("reading a timer's cadence", () => {
  test("OnUnitActiveSec is the period", () => {
    expect(parseTimerCadenceMs("[Timer]\nOnBootSec=1min\nOnUnitActiveSec=5min\n")).toBe(5 * 60_000);
  });

  test("OnBootSec is NEVER the period", () => {
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

  test("a retry firing inside the same period keeps the period", () => {
    expect(
      parseTimerCadenceMs(
        "[Timer]\nOnCalendar=*-*-* 23:45:00 UTC\nOnCalendar=*-*-* 23:57:00 UTC\n",
      ),
    ).toBe(24 * 60 * 60_000);
  });

  test("calendar slots of DIFFERENT periods stay ambiguous", () => {
    expect(parseTimerCadenceMs("[Timer]\nOnCalendar=*:0/15\nOnCalendar=*-*-* 23:45:00 UTC\n")).toBe(
      null,
    );
  });
});

describe("finding the emit_cron_output token", () => {
  test("a call is a call; a documented example is not", () => {
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
  function fakeHermes(options: {
    script?: string;
    service: string;
    timer: string;
    unit: string;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "fluncle-roster-"));
    temporaryDirectories.push(root);
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
      script: "bun made-up-sweep.ts\n",
      service: `[Service]\n${EXEC}`,
      timer: "[Timer]\nOnUnitActiveSec=7min\n",
      unit: "fluncle-made-up",
    });
    const roster = deriveTimerRoster(root);

    expect(roster.crons).toEqual([]);
    expect(roster.nonWriters).toEqual(["fluncle-made-up.timer"]);
  });

  test("a timer whose script is missing is unreadable, not a non-writer", () => {
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
    temporaryDirectories.push(root);

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
    const root = mkdtempSync(join(tmpdir(), "fluncle-roster-"));
    temporaryDirectories.push(root);
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
    temporaryDirectories.push(root);

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
    const reading = readTimer(
      join(HERMES_DIR, "studio-clip-timer", "fluncle-studio-clip.timer"),
      join(HERMES_DIR, "scripts"),
    );

    expect(reading).toMatchObject({ kind: "writer", match: "studio-clip" });
  });
});
