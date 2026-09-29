import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const SYSTEM_BINDIRS = ["/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/"];

type Plan = {
  dormantTimers: Set<string>;
  hostScripts: Map<string, string>;
  skippedDirs: Set<string>;
  timers: Set<string>;
  unitDirs: Set<string>;
  units: Set<string>;
};

function runInstaller(cwd: string, script: string) {
  return spawnSync("bash", [script, "--dry-run"], { cwd, encoding: "utf8" });
}

type InstallerFixture = {
  dest: string;
  installLog: string;
  opLog: string;
  root: string;
  script: string;
  systemctlLog: string;
};

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function createInstallerFixture(): InstallerFixture {
  const root = mkdtempSync(join(tmpdir(), "fluncle-install-host-timers-refresh-"));
  fixtureRoots.push(root);
  const script = join(root, "install-host-timers.sh");
  const fakeBin = join(root, "fake-bin");
  const dest = join(root, "systemd");
  const installLog = join(root, "install.log");
  const systemctlLog = join(root, "systemctl.log");
  const opLog = join(root, "op.log");

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(dest, { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(INSTALLER, script);
  writeFileSync(join(root, "scripts", "database-admission-runner.sh"), "#!/usr/bin/env bash\n");

  mkdirSync(join(root, "alpha-timer"), { recursive: true });
  writeFileSync(
    join(root, "alpha-timer", "fluncle-alpha.service"),
    [
      "[Service]",
      "Type=oneshot",
      "ExecStart=/opt/fluncle-database-admission/database-admission-runner.sh alpha -- /opt/fluncle-alpha/run.sh",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "alpha-timer", "run.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(
    join(root, "alpha-timer", "fluncle-alpha.timer"),
    "[Timer]\nOnUnitActiveSec=1h\n\n[Install]\nWantedBy=timers.target\n",
  );

  mkdirSync(join(root, "beta-timer"), { recursive: true });
  writeFileSync(
    join(root, "beta-timer", "fluncle-beta.service"),
    "[Service]\nType=oneshot\nExecStart=/opt/fluncle-beta/run.sh\n",
  );
  writeFileSync(join(root, "beta-timer", "run.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(
    join(root, "beta-timer", "fluncle-beta.timer"),
    "[Timer]\nOnUnitActiveSec=1h\n\n[Install]\nWantedBy=timers.target\n",
  );

  for (const dir of ["ambiguous-one", "ambiguous-two"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, "fluncle-ambiguous.service"),
      "[Service]\nType=oneshot\nExecStart=/usr/bin/true\n",
    );
  }

  writeExecutable(
    join(fakeBin, "id"),
    '#!/usr/bin/env bash\nif [ "${1:-}" = "-u" ]; then printf \'0\\n\'; else /usr/bin/id "$@"; fi\n',
  );
  writeExecutable(
    join(fakeBin, "install"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "operands=()",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      "    -D) shift ;;",
      "    -m) shift 2 ;;",
      '    *) operands+=("$1"); shift ;;',
      "  esac",
      "done",
      'source_path="${operands[0]}"',
      'destination="${operands[1]}"',
      'case "$destination" in',
      '  */) destination="${destination}$(basename "$source_path")" ;;',
      "esac",
      'case "$destination" in',
      '  /opt/* | /usr/local/*) destination="${FAKE_INSTALL_ROOT}${destination}" ;;',
      "esac",
      'mkdir -p "$(dirname "$destination")"',
      'cp "$source_path" "$destination"',
      'printf \'%s\\n\' "$destination" >> "$FAKE_INSTALL_LOG"',
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(fakeBin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      'printf \'%s\\n\' "$*" >> "$FAKE_SYSTEMCTL_LOG"',
      'unit="${*: -1}"',
      "parked() {",
      '  [ "${FAKE_SYSTEMCTL_STILL_ENABLED:-0}" = "1" ] && return 1',
      '  [ "${FAKE_SYSTEMCTL_INITIALLY_PARKED:-0}" = "1" ] && return 0',
      '  grep -qxF "disable --now ${unit}" "$FAKE_SYSTEMCTL_LOG"',
      "}",
      'case "${1:-}" in',
      "  show)",
      '    if [ "${FAKE_SYSTEMCTL_NOT_FOUND:-0}" = "1" ]; then echo not-found; else echo loaded; fi',
      "    ;;",
      "  disable)",
      '    [ "${FAKE_SYSTEMCTL_DISABLE_FAILS:-0}" = "1" ] && exit 1',
      '    [ "${FAKE_SYSTEMCTL_NOT_FOUND:-0}" = "1" ] && exit 1',
      "    ;;",
      "  is-enabled)",
      '    [ "${FAKE_SYSTEMCTL_PROBE_ERROR:-0}" = "1" ] && exit 1',
      "    if parked; then echo disabled; exit 1; fi",
      "    echo enabled",
      "    ;;",
      "  is-active)",
      "    if parked; then echo inactive; exit 3; fi",
      "    echo active",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(fakeBin, "op"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_OP_LOG"\n',
  );

  return { dest, installLog, opLog, root, script, systemctlLog };
}

function runFixture(
  fixture: InstallerFixture,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("bash", [fixture.script, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_INSTALL_LOG: fixture.installLog,
      FAKE_INSTALL_ROOT: join(fixture.root, "host-root"),
      FAKE_OP_LOG: fixture.opLog,
      FAKE_SYSTEMCTL_LOG: fixture.systemctlLog,
      INSTALL_HOST_TIMERS_DEST: fixture.dest,
      PATH: `${join(fixture.root, "fake-bin")}:${process.env.PATH ?? ""}`,
    },
  });
}

function readLog(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

function parsePlan(stdout: string): Plan {
  const plan: Plan = {
    dormantTimers: new Set(),
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
    } else if (kind === "dormant-timer") {
      plan.dormantTimers.add(value.split(" ")[0] ?? value);
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

function walkUnitDirs(): {
  dir: string;
  dormant: boolean;
  services: string[];
  timers: string[];
}[] {
  return readdirSync(HERMES_DIR)
    .filter((entry) => statSync(join(HERMES_DIR, entry)).isDirectory())
    .sort()
    .map((dir) => {
      const files = readdirSync(join(HERMES_DIR, dir));

      return {
        dir,
        dormant: files.includes("DORMANT"),
        services: files.filter((file) => file.endsWith(".service")).sort(),
        timers: files.filter((file) => file.endsWith(".timer")).sort(),
      };
    });
}

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

describe("the installer enables every timer and skips only templates and dormant jobs", () => {
  test("every non-template .timer outside a dormant directory is enabled by the plan", () => {
    const missing: string[] = [];

    for (const entry of unitDirs.filter((candidate) => !candidate.dormant)) {
      for (const timer of entry.timers) {
        if (!timer.includes("@") && !plan.timers.has(timer)) {
          missing.push(`${entry.dir}/${timer}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("a timer in a DORMANT directory is installed but never enabled", () => {
    const dormantTimers = unitDirs
      .filter((entry) => entry.dormant)
      .flatMap((entry) => entry.timers.map((timer) => ({ dir: entry.dir, timer })));

    expect(dormantTimers.map((entry) => entry.timer)).toContain("fluncle-device-mirror.timer");
    for (const { dir, timer } of dormantTimers) {
      expect(plan.timers.has(timer)).toBe(false);
      expect(plan.dormantTimers.has(timer)).toBe(true);
      expect(plan.units.has(`${dir}/${timer}`)).toBe(true);
    }
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

  test("every in-container admission runner receives its required admission environment", () => {
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
        expect(execStart, `${entry.dir}/${service}`).toContain(
          "-e DATABASE_ADMISSION_POLL_SECS=2 ",
        );
      }
    }

    expect(covered).toBeGreaterThan(0);
  });
});

describe("the installer refreshes an authorized unit subset without activation", () => {
  test("installs only selected canonical units and their host ExecStart dependencies", () => {
    const fixture = createInstallerFixture();

    try {
      const refreshed = runFixture(fixture, [
        "--refresh-unit",
        "fluncle-alpha.service",
        "--refresh-unit",
        "fluncle-alpha.timer",
      ]);

      expect(refreshed.status).toBe(0);
      expect(refreshed.stderr).toBe("");
      expect(refreshed.stdout).toContain("no timers or services activated");
      expect(readdirSync(fixture.dest).sort()).toEqual([
        "fluncle-alpha.service",
        "fluncle-alpha.timer",
      ]);
      expect(readLog(fixture.installLog)).toEqual([
        join(fixture.dest, "fluncle-alpha.service"),
        join(fixture.dest, "fluncle-alpha.timer"),
        join(
          fixture.root,
          "host-root",
          "opt/fluncle-database-admission/database-admission-runner.sh",
        ),
        join(fixture.root, "host-root", "opt/fluncle-alpha/run.sh"),
      ]);
      expect(existsSync(join(fixture.root, "host-root", "opt/fluncle-beta/run.sh"))).toBe(false);
      expect(readLog(fixture.systemctlLog)).toEqual(["daemon-reload"]);
      expect(readLog(fixture.opLog)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("accepts a selected service without its timer", () => {
    const fixture = createInstallerFixture();

    try {
      const refreshed = runFixture(fixture, ["--refresh-unit", "fluncle-beta.service"]);

      expect(refreshed.status).toBe(0);
      expect(refreshed.stderr).toBe("");
      expect(readdirSync(fixture.dest)).toEqual(["fluncle-beta.service"]);
      expect(existsSync(join(fixture.root, "host-root", "opt/fluncle-beta/run.sh"))).toBe(true);
      expect(readLog(fixture.systemctlLog)).toEqual(["daemon-reload"]);
      expect(readLog(fixture.opLog)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("dry-run states that refresh performs no activation", () => {
    const fixture = createInstallerFixture();

    try {
      const preview = runFixture(fixture, ["--dry-run", "--refresh-unit", "fluncle-alpha.service"]);

      expect(preview.status).toBe(0);
      expect(preview.stdout).toContain("plan: unit alpha-timer/fluncle-alpha.service");
      expect(preview.stdout).not.toContain("plan: unit alpha-timer/fluncle-alpha.timer");
      expect(preview.stdout).toContain("no timers or services would be activated");
      expect(readdirSync(fixture.dest)).toEqual([]);
      expect(readLog(fixture.systemctlLog)).toEqual([]);
      expect(readLog(fixture.opLog)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects unknown, duplicate, ambiguous, and non-unit selections before writes", () => {
    const cases = [
      { args: ["--refresh-unit", "fluncle-missing.service"], message: "unknown refresh unit" },
      {
        args: ["--refresh-unit", "fluncle-beta.service", "--refresh-unit", "fluncle-beta.service"],
        message: "duplicate --refresh-unit selection",
      },
      {
        args: ["--refresh-unit", "fluncle-ambiguous.service"],
        message: "ambiguous refresh unit basename",
      },
      { args: ["--refresh-unit", "fluncle-beta"], message: "exact .service or .timer basename" },
    ];

    for (const invalid of cases) {
      const fixture = createInstallerFixture();

      try {
        const rejected = runFixture(fixture, invalid.args);

        expect(rejected.status).toBe(2);
        expect(rejected.stderr).toContain(invalid.message);
        expect(readdirSync(fixture.dest)).toEqual([]);
        expect(readLog(fixture.installLog)).toEqual([]);
        expect(readLog(fixture.systemctlLog)).toEqual([]);
        expect(readLog(fixture.opLog)).toEqual([]);
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    }
  });
});

describe("a full install keeps a dormant job parked", () => {
  test("installs the dormant units, enables the rest, and disables the dormant timer", () => {
    const fixture = createInstallerFixture();

    try {
      rmSync(join(fixture.root, "ambiguous-one"), { force: true, recursive: true });
      rmSync(join(fixture.root, "ambiguous-two"), { force: true, recursive: true });
      writeFileSync(join(fixture.root, "beta-timer", "DORMANT"), "parked for a stated reason\n");

      const installed = runFixture(fixture, []);

      expect(installed.status).toBe(0);
      expect(readdirSync(fixture.dest).sort()).toEqual([
        "fluncle-alpha.service",
        "fluncle-alpha.timer",
        "fluncle-beta.service",
        "fluncle-beta.timer",
      ]);
      const systemctl = readLog(fixture.systemctlLog);
      expect(systemctl).toContain("enable --now fluncle-alpha.timer");
      expect(systemctl).not.toContain("enable --now fluncle-beta.timer");
      expect(systemctl).toContain("disable --now fluncle-beta.timer");
      expect(systemctl).toContain("is-enabled fluncle-beta.timer");
      expect(installed.stdout).toContain(
        "dormant (installed, verified disabled): fluncle-beta.timer",
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  function dormantFixture(): InstallerFixture {
    const fixture = createInstallerFixture();
    rmSync(join(fixture.root, "ambiguous-one"), { force: true, recursive: true });
    rmSync(join(fixture.root, "ambiguous-two"), { force: true, recursive: true });
    writeFileSync(join(fixture.root, "beta-timer", "DORMANT"), "parked for a stated reason\n");

    return fixture;
  }

  test("a failed disable of a dormant timer fails the install instead of reporting success", () => {
    const fixture = dormantFixture();

    try {
      const installed = runFixture(fixture, [], { FAKE_SYSTEMCTL_DISABLE_FAILS: "1" });

      expect(installed.status).toBe(1);
      expect(installed.stderr).toContain("could not disable dormant fluncle-beta.timer");
      expect(installed.stdout).not.toContain("Installed ");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("a dormant timer still enabled or active after the disable fails the install", () => {
    const fixture = dormantFixture();

    try {
      const installed = runFixture(fixture, [], { FAKE_SYSTEMCTL_STILL_ENABLED: "1" });

      expect(installed.status).toBe(1);
      expect(installed.stderr).toContain("still enabled or active");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("refreshing a dormant unit disables and verifies its timer, never enables it", () => {
    const fixture = dormantFixture();

    try {
      const refreshed = runFixture(fixture, ["--refresh-unit", "fluncle-beta.service"]);
      const systemctl = readLog(fixture.systemctlLog);

      expect(refreshed.status).toBe(0);
      expect(systemctl).toContain("disable --now fluncle-beta.timer");
      expect(systemctl).toContain("is-active fluncle-beta.timer");
      expect(systemctl.some((call) => call.startsWith("enable"))).toBe(false);
      expect(refreshed.stdout).toContain("dormant (verified disabled): fluncle-beta.timer");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("a service-only refresh of a dormant unit whose timer was never installed succeeds", () => {
    const fixture = dormantFixture();

    try {
      const refreshed = runFixture(fixture, ["--refresh-unit", "fluncle-beta.service"], {
        FAKE_SYSTEMCTL_NOT_FOUND: "1",
      });
      const systemctl = readLog(fixture.systemctlLog);

      expect(refreshed.status, refreshed.stderr).toBe(0);
      expect(systemctl.some((call) => call.startsWith("disable"))).toBe(false);
      expect(refreshed.stdout).toContain("dormant fluncle-beta.timer: not-installed");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("an already-parked dormant timer is left alone", () => {
    const fixture = dormantFixture();

    try {
      const refreshed = runFixture(fixture, ["--refresh-unit", "fluncle-beta.service"], {
        FAKE_SYSTEMCTL_INITIALLY_PARKED: "1",
      });

      expect(refreshed.status, refreshed.stderr).toBe(0);
      expect(readLog(fixture.systemctlLog).some((call) => call.startsWith("disable"))).toBe(false);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("a dormant timer whose state cannot be read is never treated as parked", () => {
    const fixture = dormantFixture();

    try {
      const refreshed = runFixture(fixture, ["--refresh-unit", "fluncle-beta.service"], {
        FAKE_SYSTEMCTL_PROBE_ERROR: "1",
      });

      expect(refreshed.status).toBe(1);
      expect(refreshed.stderr).toContain("could not read the state of dormant fluncle-beta.timer");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("refreshing a dormant unit whose disable fails is fatal", () => {
    const fixture = dormantFixture();

    try {
      const refreshed = runFixture(fixture, ["--refresh-unit", "fluncle-beta.timer"], {
        FAKE_SYSTEMCTL_DISABLE_FAILS: "1",
      });

      expect(refreshed.status).toBe(1);
      expect(refreshed.stdout).not.toContain("Refreshed ");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("the installer refuses to half-install", () => {
  test("an ExecStart with no source aborts the whole run", () => {
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

describe("a baked-capability gate holds a unit on its fallback until the image carries the script", () => {
  const MARKER = "fluncle-gamma-phased-v1";

  function gatedFixture(bakedHasMarker: boolean): InstallerFixture {
    const fixture = createInstallerFixture();
    rmSync(join(fixture.root, "ambiguous-one"), { force: true, recursive: true });
    rmSync(join(fixture.root, "ambiguous-two"), { force: true, recursive: true });
    mkdirSync(join(fixture.root, "gamma-timer"), { recursive: true });
    writeFileSync(
      join(fixture.root, "gamma-timer", "fluncle-gamma.service"),
      [
        "[Unit]",
        `X-Fluncle-Baked-Capability=/opt/hermes-scripts/gamma-sweep.ts ${MARKER}`,
        "X-Fluncle-Capability-Fallback=fluncle-gamma.service.whole-lifetime",
        "",
        "[Service]",
        "Type=oneshot",
        `ExecStartPre=/usr/bin/docker exec hermes grep -qF ${MARKER} /opt/hermes-scripts/gamma-sweep.ts`,
        "ExecStart=/usr/bin/docker exec hermes bash /opt/hermes-scripts/gamma-sweep.sh",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fixture.root, "gamma-timer", "fluncle-gamma.service.whole-lifetime"),
      [
        "[Service]",
        "Type=oneshot",
        "ExecStart=/usr/bin/docker exec hermes bash /opt/hermes-scripts/database-admission-runner.sh fluncle-gamma -- bash /opt/hermes-scripts/gamma-sweep.sh",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fixture.root, "gamma-timer", "fluncle-gamma.timer"),
      "[Timer]\nOnUnitActiveSec=1h\n\n[Install]\nWantedBy=timers.target\n",
    );
    writeExecutable(
      join(fixture.root, "fake-bin", "docker"),
      [
        "#!/usr/bin/env bash",
        'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
        bakedHasMarker ? "exit 0" : "exit 1",
        "",
      ].join("\n"),
    );

    return fixture;
  }

  function installedGamma(fixture: InstallerFixture): string {
    return readFileSync(join(fixture.dest, "fluncle-gamma.service"), "utf8");
  }

  for (const [label, args] of [
    ["a full install", []],
    ["a single-unit refresh", ["--refresh-unit", "fluncle-gamma.service"]],
  ] as const) {
    test(`${label} before the rebake installs the whole-lifetime fallback under the unit's name`, () => {
      const fixture = gatedFixture(false);
      const dockerLog = join(fixture.root, "docker.log");

      try {
        const installed = runFixture(fixture, [...args], { FAKE_DOCKER_LOG: dockerLog });

        expect(installed.status, installed.stderr).toBe(0);
        expect(installedGamma(fixture)).toContain(
          "database-admission-runner.sh fluncle-gamma -- bash /opt/hermes-scripts/gamma-sweep.sh",
        );
        expect(installedGamma(fixture)).not.toContain("X-Fluncle-Baked-Capability");
        expect(existsSync(join(fixture.dest, "fluncle-gamma.service.whole-lifetime"))).toBe(false);
        expect(readLog(dockerLog)).toEqual([
          `exec hermes grep -qF -- ${MARKER} /opt/hermes-scripts/gamma-sweep.ts`,
        ]);
        expect(installed.stdout).toContain("held on fallback");
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    });

    test(`${label} after the rebake installs the phased unit itself`, () => {
      const fixture = gatedFixture(true);
      const dockerLog = join(fixture.root, "docker.log");

      try {
        const installed = runFixture(fixture, [...args], { FAKE_DOCKER_LOG: dockerLog });

        expect(installed.status, installed.stderr).toBe(0);
        expect(installedGamma(fixture)).toContain(`X-Fluncle-Baked-Capability=`);
        expect(installedGamma(fixture)).not.toContain("database-admission-runner.sh");
        expect(installed.stdout).not.toContain("held on fallback");
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    });
  }

  test("a gate that names no existing fallback refuses the whole install", () => {
    const fixture = gatedFixture(true);

    try {
      rmSync(join(fixture.root, "gamma-timer", "fluncle-gamma.service.whole-lifetime"));
      const refused = runFixture(fixture, [], {
        FAKE_DOCKER_LOG: join(fixture.root, "docker.log"),
      });

      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("X-Fluncle-Capability-Fallback");
      expect(readdirSync(fixture.dest)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  test("the backfill unit gates on the marker its baked script exports and falls back to the admission wrap", () => {
    const unit = readFileSync(
      join(HERMES_DIR, "backfill-timer", "fluncle-backfill.service"),
      "utf8",
    );
    const fallback = readFileSync(
      join(HERMES_DIR, "backfill-timer", "fluncle-backfill.service.whole-lifetime"),
      "utf8",
    );
    const script = readFileSync(join(HERMES_DIR, "scripts", "backfill-sweep.ts"), "utf8");
    const marker = /^export const BACKFILL_ADMISSION_CAPABILITY = "([^"]+)";$/m.exec(script)?.[1];

    expect(marker).toBeDefined();
    expect(unit).toContain(
      `X-Fluncle-Baked-Capability=/opt/hermes-scripts/backfill-sweep.ts ${marker}`,
    );
    expect(unit).toContain("X-Fluncle-Capability-Fallback=fluncle-backfill.service.whole-lifetime");
    expect(unit).toContain(
      `ExecStartPre=/usr/bin/docker exec hermes grep -qF ${marker} /opt/hermes-scripts/backfill-sweep.ts`,
    );
    expect(unit).not.toContain("database-admission-runner.sh fluncle-backfill");
    expect(fallback).toContain(
      "hermes bash /opt/hermes-scripts/database-admission-runner.sh fluncle-backfill -- bash /opt/hermes-scripts/backfill-sweep.sh",
    );
    expect(fallback).not.toContain("X-Fluncle-Baked-Capability");
  });
});
