// THE INSTALLER-COMPLETENESS GUARD — every unit dir, timer, and host script this repo holds
// must be covered by `docs/agents/hermes/install-host-timers.sh`.
//
// WHY THIS TEST EXISTS. The installer used to name its work in a hardcoded list:
//
//     unit_dirs=("${REPO_DIR}"/*-timer "${REPO_DIR}"/pin-watch "${REPO_DIR}"/sweep-failure)
//
// `secrets/` does not match any of those three, so `fluncle-secrets-sync.{service,timer}` was
// never installed — a rebuilt box enabled all 40-odd sweep timers and fired them on schedule
// with NO credentials. And nothing laid down the host scripts a unit's `ExecStart=` points at,
// so `pin-watch.timer` was enabled against a missing `/opt/fluncle-pin-watch/rebuild-hermes.sh`
// and the box permanently lost self-deploy.
//
// Both failures were SILENT: the script exited 0, printed a success line, and
// `systemctl list-timers` read green over a box where nothing worked. That is the class of bug
// a rebuild discovers months later, so it cannot be left to review — it has to fail the build.
//
// HOW IT CHECKS. The installer grew a `--dry-run` mode that prints its derived plan and exits
// without touching the host. This test runs that REAL selection code and diffs the plan against
// an independent walk of the repo, so the assertion binds three sets together:
//
//   1. every directory holding a `.service`/`.timer` is a unit dir in the plan;
//   2. every non-template `.timer` is enabled by the plan;
//   3. every host path an `ExecStart=` points at is laid down by the plan — and every
//      IN-CONTAINER `/opt/hermes-scripts/*.sh` a sweep unit execs exists under `scripts/`.
//
// Plus the honesty contract: an unresolvable `ExecStart` must abort with a non-zero exit rather
// than install a half-working schedule.
//
// If this test fails, the installer would have skipped something on the next box rebuild.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const HERMES_DIR = join(import.meta.dir, "..");
const INSTALLER = join(HERMES_DIR, "install-host-timers.sh");
const CONTAINER_SCRIPT_PREFIX = "/opt/hermes-scripts/";

/** The distro bindirs a unit may exec straight out of — the installer never lays these down. */
const SYSTEM_BINDIRS = ["/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/"];

type Plan = {
  hostScripts: Map<string, string>; // absolute destination -> repo-relative source
  skippedDirs: Set<string>;
  timers: Set<string>;
  unitDirs: Set<string>;
  units: Set<string>;
};

function runInstaller(cwd: string, script: string) {
  return spawnSync("bash", [script, "--dry-run"], { cwd, encoding: "utf8" });
}

function parsePlan(stdout: string): Plan {
  const plan: Plan = {
    hostScripts: new Map(),
    skippedDirs: new Set(),
    timers: new Set(),
    unitDirs: new Set(),
    units: new Set(),
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();

    if (!line.startsWith("plan: ")) {
      continue;
    }

    const body = line.slice("plan: ".length);
    const [kind, ...rest] = body.split(" ");
    const value = rest.join(" ");

    if (kind === "unit-dir") {
      plan.unitDirs.add(value);
    } else if (kind === "unit") {
      plan.units.add(value);
    } else if (kind === "timer") {
      plan.timers.add(value);
    } else if (kind === "skip-dir") {
      plan.skippedDirs.add(value.split(" ")[0] ?? value);
    } else if (kind === "host-script") {
      const [source, destination] = value.split(" -> ");

      if (source && destination) {
        plan.hostScripts.set(destination, source);
      }
    }
  }

  return plan;
}

/** Directories beside the installer, with the unit files each one holds. */
function walkUnitDirs(): { dir: string; services: string[]; timers: string[] }[] {
  return readdirSync(HERMES_DIR)
    .filter((entry) => statSync(join(HERMES_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => {
      const files = readdirSync(join(HERMES_DIR, dir));

      return {
        dir,
        services: files.filter((file) => file.endsWith(".service")).sort(),
        timers: files.filter((file) => file.endsWith(".timer")).sort(),
      };
    });
}

/** The executable of every `ExecStart=` in a unit file, systemd's `-@+!:` prefixes stripped. */
function execStartExecutables(unitPath: string): string[] {
  return readFileSync(unitPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("ExecStart="))
    .map(
      (line) =>
        line
          .slice("ExecStart=".length)
          .replace(/^[\s\-@+!:]+/, "")
          .split(/\s+/)[0] ?? "",
    )
    .filter((executable) => executable.length > 0);
}

/** Every whitespace-separated token of every `ExecStart=` — arguments included. */
function execStartTokens(unitPath: string): string[] {
  return readFileSync(unitPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("ExecStart="))
    .flatMap((line) => line.slice("ExecStart=".length).split(/\s+/))
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function isSystemBinary(path: string): boolean {
  return SYSTEM_BINDIRS.some((bindir) => path.startsWith(bindir));
}

const unitDirs = walkUnitDirs();
const result = runInstaller(HERMES_DIR, INSTALLER);
const plan = parsePlan(result.stdout);

// Two explicit current exceptions to the fleet-wide failure hook:
// - the notifier template must not recurse when notification itself fails;
// - pin-watch is a pre-existing gap outside this slice, kept visible here rather than silently
//   treated as compliant. Removing its exemption is part of fixing that unit, not this one.
const ON_FAILURE_EXEMPTIONS = new Set([
  "pin-watch/pin-watch.service",
  "sweep-failure/fluncle-sweep-failure@.service",
]);

describe("install-host-timers.sh --dry-run", () => {
  test("succeeds and produces a plan", () => {
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(plan.unitDirs.size).toBeGreaterThan(0);
  });
});

describe("the installer covers every unit directory in the repo", () => {
  // THE assertion that catches the original bug on its own: `secrets/` holds a .timer, so it
  // must be a unit dir. The hardcoded `*-timer` + pin-watch + sweep-failure list fails here.
  test("every directory holding a .timer is a unit dir in the plan", () => {
    const dirsWithTimers = unitDirs.filter((entry) => entry.timers.length > 0).map((e) => e.dir);

    expect(dirsWithTimers.length).toBeGreaterThan(0);
    expect(dirsWithTimers.filter((dir) => !plan.unitDirs.has(dir))).toEqual([]);
  });

  test("every directory holding a .service is a unit dir in the plan", () => {
    const dirsWithServices = unitDirs
      .filter((entry) => entry.services.length > 0)
      .map((e) => e.dir);

    expect(dirsWithServices.filter((dir) => !plan.unitDirs.has(dir))).toEqual([]);
  });

  test("every .service and .timer file is installed by the plan", () => {
    const missing: string[] = [];

    for (const entry of unitDirs) {
      for (const file of [...entry.services, ...entry.timers]) {
        if (!plan.units.has(`${entry.dir}/${file}`)) {
          missing.push(`${entry.dir}/${file}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("a directory the plan skips really holds no unit files", () => {
    for (const skipped of plan.skippedDirs) {
      const entry = unitDirs.find((candidate) => candidate.dir === skipped);

      expect(entry?.services ?? []).toEqual([]);
      expect(entry?.timers ?? []).toEqual([]);
    }
  });
});

describe("every installed service has a failure-reporting path", () => {
  test("unit_files_carry_onfailure", () => {
    const missing: string[] = [];

    for (const entry of unitDirs) {
      for (const service of entry.services) {
        const relativePath = `${entry.dir}/${service}`;
        const body = readFileSync(join(HERMES_DIR, relativePath), "utf8");

        if (!body.split("\n").includes("OnFailure=fluncle-sweep-failure@%n.service")) {
          missing.push(relativePath);
        }
      }
    }

    const unexpectedMissing = missing.filter((path) => !ON_FAILURE_EXEMPTIONS.has(path)).sort();
    const staleExemptions = [...ON_FAILURE_EXEMPTIONS]
      .filter((path) => !missing.includes(path))
      .sort();

    expect({ staleExemptions, unexpectedMissing }).toEqual({
      staleExemptions: [],
      unexpectedMissing: [],
    });
  });
});

describe("the installer enables every timer and skips only templates", () => {
  test("every non-template .timer is enabled by the plan", () => {
    const missing: string[] = [];

    for (const entry of unitDirs) {
      for (const timer of entry.timers) {
        if (!timer.includes("@") && !plan.timers.has(timer)) {
          missing.push(`${entry.dir}/${timer}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("template units are never enabled", () => {
    for (const timer of plan.timers) {
      expect(timer).not.toContain("@");
    }
  });

  test("secrets sync is enabled first, before any sweep starts ticking", () => {
    expect([...plan.timers][0]).toBe("fluncle-secrets-sync.timer");
  });
});

describe("the installer lays down every host script a unit ExecStart points at", () => {
  test("every non-system-binary ExecStart executable is installed by the plan", () => {
    const missing: string[] = [];

    for (const entry of unitDirs) {
      for (const service of entry.services) {
        for (const executable of execStartExecutables(join(HERMES_DIR, entry.dir, service))) {
          if (isSystemBinary(executable)) {
            continue;
          }

          if (!plan.hostScripts.has(executable)) {
            missing.push(`${entry.dir}/${service} -> ${executable}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("each planned host script has a real source file in the repo", () => {
    for (const [destination, source] of plan.hostScripts) {
      expect(destination.startsWith("/")).toBe(true);
      expect(existsSync(join(HERMES_DIR, source))).toBe(true);
    }
  });

  // These host scripts have no in-container bake to fall back to. The generic assertions above
  // already cover them; these name them so a regression reads as itself in the failure output.
  test("the secrets sync and pin-watch host scripts are laid down", () => {
    expect(
      plan.hostScripts.has("/opt/fluncle-database-admission/database-admission-runner.sh"),
    ).toBe(false);
    expect(plan.hostScripts.get("/usr/local/sbin/fluncle-secrets-sync.sh")).toBe(
      "secrets/fluncle-secrets-sync.sh",
    );
    expect(plan.hostScripts.get("/opt/fluncle-pin-watch/rebuild-hermes.sh")).toBe(
      "pin-watch/rebuild-hermes.sh",
    );
    expect(plan.timers.has("fluncle-secrets-sync.timer")).toBe(true);
    expect(plan.timers.has("pin-watch.timer")).toBe(true);
  });
});

describe("every in-container script a unit execs is baked from scripts/", () => {
  // The `docker exec … bash /opt/hermes-scripts/<x>.sh` half: those are NOT installed by this
  // script (the image bakes them, pin-watch refreshes them), so what has to hold is that the
  // repo actually ships the file the unit names. A renamed sweep script with a stale unit is
  // a box that fails every tick with "No such file or directory".
  test("every /opt/hermes-scripts/*.sh named by a unit exists under scripts/", () => {
    const missing: string[] = [];

    for (const entry of unitDirs) {
      for (const service of entry.services) {
        for (const token of execStartTokens(join(HERMES_DIR, entry.dir, service))) {
          if (!token.startsWith(CONTAINER_SCRIPT_PREFIX)) {
            continue;
          }

          if (!existsSync(join(import.meta.dir, basename(token)))) {
            missing.push(`${entry.dir}/${service} -> ${token}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("every in-container admission runner receives the local fail-closed gate", () => {
    let covered = 0;

    for (const entry of unitDirs) {
      for (const service of entry.services) {
        const unit = readFileSync(join(HERMES_DIR, entry.dir, service), "utf8");
        const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
        if (!execStart?.includes("/opt/hermes-scripts/database-admission-runner.sh")) {
          continue;
        }

        covered += 1;
        expect(unit.split("\n"), `${entry.dir}/${service}`).toContain(
          "EnvironmentFile=-/etc/fluncle/database-admission.env",
        );
        expect(execStart, `${entry.dir}/${service}`).toContain(
          "/usr/bin/docker exec -e DATABASE_ADMISSION_FAIL_CLOSED ",
        );
      }
    }

    expect(covered).toBeGreaterThan(0);
  });
});

describe("the installer refuses to half-install", () => {
  // The honesty contract: a unit pointing at a host path with no source in the repo must abort
  // with a non-zero exit, not install everything else and print a success line.
  test("an ExecStart with no source aborts the whole run", () => {
    // A throwaway hermes dir: the installer alongside ONE unit dir whose service points at a
    // host script nobody shipped. Built under the OS temp dir so a crashed run can never leave
    // a stray directory inside `scripts/` (the Dockerfile copies that whole dir into the image).
    const fixture = mkdtempSync(join(tmpdir(), "fluncle-install-host-timers-"));

    try {
      mkdirSync(join(fixture, "broken-timer"), { recursive: true });
      copyFileSync(INSTALLER, join(fixture, "install-host-timers.sh"));
      writeFileSync(
        join(fixture, "broken-timer", "fluncle-broken.service"),
        "[Service]\nType=oneshot\nExecStart=/opt/fluncle-broken/nowhere.sh\n",
      );
      writeFileSync(
        join(fixture, "broken-timer", "fluncle-broken.timer"),
        "[Timer]\nOnUnitActiveSec=1h\n\n[Install]\nWantedBy=timers.target\n",
      );

      const broken = runInstaller(fixture, join(fixture, "install-host-timers.sh"));

      expect(broken.status).not.toBe(0);
      expect(broken.stderr).toContain("REFUSING to install");
      expect(broken.stderr).toContain("/opt/fluncle-broken/nowhere.sh");
      expect(broken.stdout).not.toContain("Would install");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });
});
