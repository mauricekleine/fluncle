// cron-roster.ts — DERIVE the expected-writer roster from the committed systemd timer units,
// so the prober's `AUTOMATION_CRONS` stops being a list somebody has to remember to update.
//
// THE PROBLEM THIS EXISTS FOR. `AUTOMATION_CRONS` in fluncle-healthcheck.ts is the set of crons
// the /status prober expects to find markers for, and every entry — the token, the service id,
// the cadence — restates by hand something the repo already states elsewhere: the timer unit.
// Restating drifts. Measured 2026-07-29 against the 45 committed `.timer` units:
//
//   • `fluncle-frontier-refresh` moved from a Friday-07:00 burst to a 15-minute paced drain
//     (see its timer's `OnCalendar=*:0/15`), and the prober kept the old weekly cadence. The
//     stale budget is 3x the cadence, so a DEAD frontier-refresh would have read `fresh` on
//     /status for 21 days instead of 45 minutes.
//   • `fluncle-timer-watchdog` and `fluncle-secrets-sync` had no entry at all — and, unlike
//     `pin-watch` (which self-posts the `self-deploy` row) and `fluncle-healthcheck` (which
//     self-emits its own), they report to NOTHING. Two of the box's timers were invisible.
//
// AGENTS.md names this exact class for the Cloudflare watch-paths mirror: "the two lists live
// in different places with NOTHING testing that they agree". This module is the something.
//
// WHAT IT DERIVES, AND FROM WHAT. For every `<dir>/*.timer` beside docs/agents/hermes/:
//
//   1. the paired `<dir>/<same-name>.service` gives the `ExecStart=` line;
//   2. the cron TOKEN is the argument of the `emit_cron_output <token>` call that ExecStart
//      reaches — either written inline in the unit (the render conductor does this) or in the
//      `/opt/hermes-scripts/<name>.sh` sweep the unit `docker exec`s, whose source of truth is
//      `docs/agents/hermes/scripts/<name>.sh` in this very directory;
//   3. the service id is `cron.<token>` — the same id `cron-output.sh` bakes into the marker's
//      `# Cron Job: fluncle-<token>` header and the prober's `match` claims;
//   4. the CADENCE comes off the timer's own `OnUnitActiveSec=` or `OnCalendar=`.
//
// A timer whose ExecStart reaches no `emit_cron_output` call writes no marker and so cannot be
// probed this way. Those are declared in NON_WRITER_TIMERS with a reason each, and the guard
// checks that list in BOTH directions — an undeclared non-writer fails the build, and so does a
// declaration for a timer that turns out to write after all.
//
// WHY THIS IS A BUILD-TIME GUARD RATHER THAN THE PROBER'S RUNTIME SOURCE. The prober is
// deployed standalone: the Dockerfile bakes `docs/agents/hermes/scripts/` to
// /opt/hermes-scripts/ and NOTHING else, while the timer units are laid down on the HOST
// (/etc/systemd/system, by install-host-timers.sh) and never enter the container. So the box
// cannot read a unit file at tick time. `AUTOMATION_CRONS` therefore stays a literal the
// prober can carry — and cron-roster.test.ts fails the build the moment it disagrees with the
// units. See docs/agents/hermes/scripts/cron-roster.test.ts.

/** One cron the units say SHOULD be writing markers. Shape-compatible with the prober's CronDef. */
export type DerivedCron = {
  /** Stale budget input: how often the timer says this sweep fires. */
  cadenceMs: number;
  /** The bare `emit_cron_output` token — the prober's `match`. */
  match: string;
  /** The registry surface id the prober emits — always `cron.<match>`. */
  service: string;
  /** The unit that fires it, e.g. `fluncle-enrich.timer`. */
  unit: string;
};

/** A timer that deliberately writes no cron-output marker, with the reason it doesn't. */
export type NonWriterTimer = { reason: string; unit: string };

/** Where a timer's cadence was read from — carried so a failure can name the line. */
export type CadenceSource = { directive: string; value: string };

export type Roster = {
  /** Derived expected writers, sorted by unit name. */
  crons: DerivedCron[];
  /** Timers that reach no `emit_cron_output`, sorted by unit name. */
  nonWriters: string[];
  /** Timers whose cadence could not be read — always a build failure, never a guess. */
  unreadableCadence: string[];
};
