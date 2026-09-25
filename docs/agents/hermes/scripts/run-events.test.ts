import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLedgerWriters } from "@fluncle/registry";

import {
  boxScriptApiPaths,
  emittedGateStates,
  LEDGER_GATE_STATES,
  PENDING_WORKSPACE_PATHS,
  resolveApiPath,
  RUN_EVENT_ENDPOINT,
  runLedgerContractPaths,
  workspaceGateStates,
  workspaceNeverLookedGateStates,
} from "./api-surface";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const CRON_OUTPUT = join(import.meta.dir, "cron-output.sh");
const WATCHDOG = join(REPO, "docs/agents/hermes/timer-watchdog/timer-watchdog.sh");
const WATCHDOG_TIMER = join(REPO, "docs/agents/hermes/timer-watchdog/fluncle-timer-watchdog.timer");
const SECRETS_SYNC = join(REPO, "docs/agents/hermes/secrets/fluncle-secrets-sync.sh");
const SECRETS_SYNC_TIMER = join(REPO, "docs/agents/hermes/secrets/fluncle-secrets-sync.timer");
const SONAR_FRESHEN = join(REPO, "apps/sonar/deploy/fluncle-sonar-freshen.sh");
const SONAR_FRESHEN_TIMER = join(REPO, "apps/sonar/deploy/fluncle-sonar-freshen.timer");
const PIN_WATCH = join(REPO, "docs/agents/hermes/pin-watch/rebuild-hermes.sh");
const PIN_WATCH_TIMER = join(REPO, "docs/agents/hermes/pin-watch/pin-watch.timer");
const temporaryDirectories: string[] = [];
const SCRIPT_CHILD_EXIT_TIMEOUT_MS = 30_000;

const SCRIPT_TEST_TIMEOUT_MS = SCRIPT_CHILD_EXIT_TIMEOUT_MS + 5_000;
const TWO_SCRIPT_TEST_TIMEOUT_MS = SCRIPT_CHILD_EXIT_TIMEOUT_MS * 2 + 5_000;
const activeHostScripts = new Set<Bun.Subprocess>();
const hostScriptCleanups = new Map<Bun.Subprocess, Promise<void>>();

function stopHostScript(proc: Bun.Subprocess): Promise<void> {
  const existing = hostScriptCleanups.get(proc);
  if (existing) {
    return existing;
  }
  const stopGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-proc.pid, signal);
    } catch (cause) {
      if ((cause as { code?: string }).code !== "ESRCH") {
        proc.kill(signal);
      }
    }
  };
  const cleanup = (async () => {
    stopGroup("SIGKILL");
    await proc.exited;
  })();
  hostScriptCleanups.set(proc, cleanup);
  return cleanup;
}

afterEach(async () => {
  await Promise.all([...activeHostScripts].map((proc) => stopHostScript(proc)));
  activeHostScripts.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const BEGIN = ">>> BEGIN MIRRORED BLOCK: record_run_event";
const END = "<<< END MIRRORED BLOCK: record_run_event <<<";

function mirroredBlock(path: string): string {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes(BEGIN));
  const end = lines.findIndex((line) => line.includes(END));

  if (start < 0 || end < 0 || end < start) {
    throw new Error(`no mirrored record_run_event block in ${path}`);
  }

  return lines.slice(start, end + 1).join("\n");
}

describe("record_run_event is mirrored, not re-implemented", () => {
  const canonical = mirroredBlock(CRON_OUTPUT);

  test.each([
    ["timer-watchdog.sh", WATCHDOG],
    ["fluncle-secrets-sync.sh", SECRETS_SYNC],
    ["fluncle-sonar-freshen.sh", SONAR_FRESHEN],
    ["rebuild-hermes.sh", PIN_WATCH],
  ])("%s carries the block byte for byte", (_name, path) => {
    expect(mirroredBlock(path)).toBe(canonical);
  });

  test("the block pins the endpoint and the five body fields", () => {
    expect(canonical).toContain(`RUN_EVENT_PATH='${RUN_EVENT_ENDPOINT}'`);
    expect(canonical).toContain(
      '{"unit":"%s","started_at":"%s","ended_at":"%s","exit_code":%s,"summary_raw":"%s"}',
    );
    expect(canonical).toContain('-H "Authorization: Bearer ${token}"');

    expect(canonical).toContain('--max-time "$RUN_EVENT_TIMEOUT_SECS"');

    expect(canonical).toContain('RUN_EVENT_FAILURE_REASON="post-failed"');
    expect(canonical).toContain("curl -fsS");

    const code = canonical
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(code).not.toContain('"ok"');
  });

  test.each([
    ["timer-watchdog.sh", WATCHDOG],
    ["fluncle-secrets-sync.sh", SECRETS_SYNC],
    ["fluncle-sonar-freshen.sh", SONAR_FRESHEN],
    ["rebuild-hermes.sh", PIN_WATCH],
  ])("%s actually CALLS it — carrying the block is not the same as using it", (_name, path) => {
    const body = readFileSync(path, "utf8");
    const [, afterBlock = ""] = body.split(END);

    expect(afterBlock).toContain('record_run_event "$RUN_EVENT_UNIT"');
  });
});

describe("every path a box script hardcodes is a path the Worker serves", () => {
  const literals = boxScriptApiPaths();

  test("the resolver is not a no-op — real paths really resolve", () => {
    const resolved = literals.filter(({ literal }) => resolveApiPath(literal).kind === "contract");

    expect(resolved.length).toBeGreaterThan(4);

    expect(resolveApiPath("/api/v1/admin/costs/events")).toEqual({
      kind: "contract",
      source: "packages/contracts/src/orpc/admin-costs.ts",
    });

    expect(resolveApiPath("/api/v1/status").kind).toBe("file-route");
  });

  test("no script POSTs at a path nothing in the workspace declares", () => {
    const orphans = literals
      .filter(({ literal }) => resolveApiPath(literal).kind === "unresolved")
      .map(({ file, line, literal }) => `${file}:${line} → ${literal}`);

    expect(orphans).toEqual([]);
  });

  test("every pending path names the PR that closes it", () => {
    expect(PENDING_WORKSPACE_PATHS.size).toBeLessThanOrEqual(1);

    for (const [path, reason] of PENDING_WORKSPACE_PATHS) {
      expect(path.startsWith("/api/v1/")).toBe(true);
      expect(reason).toMatch(/PR #\d+/);
    }
  });

  test("the run-ledger endpoint is the contract's own path, not a guess", () => {
    const declared = runLedgerContractPaths();

    if (declared.size === 0) {
      expect(PENDING_WORKSPACE_PATHS.has(RUN_EVENT_ENDPOINT)).toBe(true);

      return;
    }

    expect([...declared]).toContain(RUN_EVENT_ENDPOINT);
  });
});

const EMITTERS: [string, string][] = [
  ["timer-watchdog.sh", WATCHDOG],
  ["fluncle-secrets-sync.sh", SECRETS_SYNC],
  ["fluncle-sonar-freshen.sh", SONAR_FRESHEN],
  ["rebuild-hermes.sh", PIN_WATCH],
];

function dryRunGateState(path: string): string {
  const body = readFileSync(path, "utf8");
  const branch = /^\s*elif \[ "\$MODE" = "--dry-run" \]; then\n([\s\S]*?)^\s*elif /m.exec(body);

  if (!branch?.[1]) {
    throw new Error(`no --dry-run branch found in ${path}`);
  }

  const gate = /^\s*\w*GATE\w*='"([^"]+)"'/m.exec(branch[1]);

  if (!gate?.[1]) {
    throw new Error(`the --dry-run branch of ${path} assigns no gate state`);
  }

  return gate[1];
}

function summaryFormat(path: string): string {
  const match = /summary="\$\(printf '(\{[^']*})'/.exec(readFileSync(path, "utf8"));

  if (!match?.[1]) {
    throw new Error(`no summary printf format found in ${path}`);
  }

  return match[1];
}

describe("the summary line states facts, never a verdict", () => {
  test.each(EMITTERS)("%s prints no `ok` of its own", (_name, path) => {
    expect(summaryFormat(path)).not.toContain('"ok"');

    for (const field of ["checked", "produced", "errors"]) {
      expect(summaryFormat(path)).toContain(`"${field}"`);
    }
    expect(
      summaryFormat(path).includes('"queueDepth"') || summaryFormat(path).includes('"queue_depth"'),
    ).toBe(true);
  });

  test("every gate value a script can emit is in the ledger's closed vocabulary", () => {
    const emitted = emittedGateStates(EMITTERS.map(([, path]) => path));

    expect(emitted.length).toBeGreaterThan(0);

    for (const state of emitted) {
      expect(LEDGER_GATE_STATES).toContain(state);
    }
  });

  test("a gate a looking tick emits is not one of the Worker's never-looked words", () => {
    const neverLooked = workspaceNeverLookedGateStates();

    if (neverLooked === null) {
      expect(PENDING_WORKSPACE_PATHS.has(RUN_EVENT_ENDPOINT)).toBe(true);

      return;
    }

    expect(neverLooked.length).toBeGreaterThan(0);
    expect(neverLooked).not.toContain("dry-run");

    expect(neverLooked).not.toContain(dryRunGateState(SONAR_FRESHEN));
  });

  test("that vocabulary is the Worker's own, whenever the Worker is here to ask", () => {
    const declared = workspaceGateStates();

    if (declared === null) {
      expect(PENDING_WORKSPACE_PATHS.has(RUN_EVENT_ENDPOINT)).toBe(true);

      return;
    }

    expect(declared).toEqual([...LEDGER_GATE_STATES].sort());
  });
});

function reportingUnits(): string[] {
  return EMITTERS.map(([name, path]) => {
    const match = /^RUN_EVENT_UNIT="([^"]+)"$/m.exec(readFileSync(path, "utf8"));

    if (!match?.[1]) {
      throw new Error(`no RUN_EVENT_UNIT in ${name}`);
    }

    return match[1];
  });
}

const SILENCE_CLAIMS = [
  /reports nowhere/i,
  /reports to nothing/i,
  /posts nothing either/i,
  /appears on `\/status` \*\*not at all\*\*/i,
];

describe("no doc calls a reporting unit silent", () => {
  test("the three units really are reporting units", () => {
    expect(reportingUnits().sort()).toEqual([
      "fluncle-pin-watch",
      "fluncle-secrets-sync",
      "fluncle-sonar-freshen",
      "fluncle-timer-watchdog",
    ]);
  });

  test.each([
    ["timer-watchdog/README.md", join(REPO, "docs/agents/hermes/timer-watchdog/README.md")],
    ["cron/README.md", join(REPO, "docs/agents/hermes/cron/README.md")],
    ["apps/sonar/deploy/README.md", join(REPO, "apps/sonar/deploy/README.md")],
  ])("%s does not still say they report nowhere", (_name, path) => {
    const body = readFileSync(path, "utf8");

    for (const claim of SILENCE_CLAIMS) {
      expect(body).not.toMatch(claim);
    }
  });

  test("the expected-writers roster does not call them silent either", () => {
    const roster = join(REPO, "docs/agents/hermes/scripts/cron-roster.ts");

    if (!existsSync(roster)) {
      expect(PENDING_WORKSPACE_PATHS.has(RUN_EVENT_ENDPOINT)).toBe(true);

      return;
    }

    const body = readFileSync(roster, "utf8");
    const declarations = [...body.matchAll(/"(fluncle-[a-z-]+)\.timer":\s*\n?\s*"([^"]+)"/g)];
    const offenders = declarations
      .filter(([, unit, reason]) =>
        reportingUnits().includes(unit ?? "")
          ? SILENCE_CLAIMS.some((claim) => claim.test(reason ?? ""))
          : false,
      )
      .map(([, unit]) => unit);

    expect(offenders).toEqual([]);
  });
});

function timerIntervalMs(path: string): number {
  const body = readFileSync(path, "utf8");
  const calendar = /^OnCalendar=\*:0\/(\d+)$/m.exec(body);

  if (calendar?.[1]) {
    return Number(calendar[1]) * 60_000;
  }

  const active = /^OnUnitActiveSec=(\d+)(min|h)$/m.exec(body);

  if (active?.[1] && active[2]) {
    return Number(active[1]) * (active[2] === "h" ? 3_600_000 : 60_000);
  }

  throw new Error(`could not read a cadence out of ${path}`);
}

function declaredIntervalMs(path: string): number {
  const match = /^RUN_EVENT_INTERVAL_MS=(\d+)$/m.exec(readFileSync(path, "utf8"));

  if (!match?.[1]) {
    throw new Error(`no RUN_EVENT_INTERVAL_MS in ${path}`);
  }

  return Number(match[1]);
}

describe("each unit's declared interval matches its own .timer", () => {
  test.each([
    ["timer-watchdog", WATCHDOG, WATCHDOG_TIMER],
    ["secrets-sync", SECRETS_SYNC, SECRETS_SYNC_TIMER],
    ["sonar-freshen", SONAR_FRESHEN, SONAR_FRESHEN_TIMER],
    ["pin-watch", PIN_WATCH, PIN_WATCH_TIMER],
  ])("%s", (_name, script, timer) => {
    const unitMatch = /^RUN_EVENT_UNIT="([^"]+)"$/m.exec(readFileSync(script, "utf8"));
    const unit = unitMatch?.[1];
    const rosterCadence = runLedgerWriters().find((writer) => writer.unit === unit);

    expect(unit).toBeDefined();
    expect(declaredIntervalMs(script)).toBe(timerIntervalMs(timer));
    expect(rosterCadence?.expectedIntervalMs).toBe(declaredIntervalMs(script));
  });
});

type LedgerCall = { auth: string; body: string; path: string };
type PostedRun = {
  ended_at: string;
  exit_code: number;
  started_at: string;
  summary_raw: string;
  unit: string;
};
type Summary = Record<string, boolean | number | string | null>;

async function withLedger<T>(
  body: (base: string, calls: LedgerCall[], landed: LedgerCall[]) => Promise<T>,
  options: { responseStatus?: number } = {},
): Promise<T> {
  const calls: LedgerCall[] = [];
  const landed: LedgerCall[] = [];
  const server = Bun.serve({
    async fetch(request) {
      const call = {
        auth: request.headers.get("authorization") ?? "",
        body: await request.text(),
        path: new URL(request.url).pathname,
      };
      calls.push(call);

      const responseStatus = options.responseStatus ?? 200;

      if (responseStatus < 200 || responseStatus >= 300) {
        return new Response("ledger unavailable", { status: responseStatus });
      }

      landed.push(call);

      return Response.json({ inserted: 1, ok: true });
    },
    port: 0,
  });

  try {
    return await body(`http://127.0.0.1:${server.port}`, calls, landed);
  } finally {
    await server.stop(true);
  }
}

const runEvents = (calls: LedgerCall[]) => calls.filter((call) => call.path === RUN_EVENT_ENDPOINT);

function received(calls: LedgerCall[]): { posted: PostedRun; summary: Summary } {
  const call = runEvents(calls)[0];

  if (!call) {
    throw new Error("the ledger received no run event at all");
  }

  const posted = JSON.parse(call.body) as PostedRun;

  return { posted, summary: JSON.parse(posted.summary_raw) as Summary };
}

function writeStub(dir: string, name: string, body: string): void {
  const path = join(dir, name);

  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

function loopbackCurlRail(): { dir: string; refusals: string } {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-loopback-rail-"));
  temporaryDirectories.push(dir);
  const refusals = join(dir, "refused.log");
  const real = Bun.which("curl");

  if (real === null) {
    throw new Error("no curl on PATH — the loopback rail has nothing to pass through to");
  }

  writeStub(
    dir,
    "curl",
    [
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    http://127.0.0.1|http://127.0.0.1[:/]*|http://localhost|http://localhost[:/]*) ;;",
      "    http://*|https://*)",
      `      printf '%s\\n' "$arg" >>${JSON.stringify(refusals)}`,
      "      exit 7",
      "      ;;",
      "  esac",
      "done",
      `exec ${JSON.stringify(real)} "$@"`,
    ].join("\n"),
  );

  return { dir, refusals };
}

async function runScript(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
  timeoutMs = SCRIPT_CHILD_EXIT_TIMEOUT_MS,
): Promise<{ code: number; stderr: string; stdout: string }> {
  const rail = loopbackCurlRail();
  const merged = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...env };
  const proc = Bun.spawn(["bash", script, ...args], {
    detached: true,
    env: { ...merged, PATH: `${rail.dir}:${merged.PATH}` },
    stderr: "pipe",
    stdout: "pipe",
  });
  activeHostScripts.add(proc);

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutExit = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void stopHostScript(proc);
        reject(new Error(`host script did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const code = await Promise.race([proc.exited, timeoutExit]);
    const pipes = await Promise.race([Promise.all([stdoutPromise, stderrPromise]), timeoutExit]);
    const [stdout, stderr] = pipes;

    if (existsSync(rail.refusals)) {
      throw new Error(
        `a run reached off-loopback — the fixture is missing its ledger base:\n${readFileSync(
          rail.refusals,
          "utf8",
        )}`,
      );
    }

    return { code, stderr, stdout };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    await stopHostScript(proc);
    activeHostScripts.delete(proc);
  }
}

function derivedOk(exitCode: number, errors: Summary[string] | undefined): boolean {
  return exitCode === 0 && (errors ?? 0) === 0;
}

describe("host-script fixture lifecycle", () => {
  test("a timed-out fixture is killed before afterEach removes its tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-host-script-timeout-"));
    temporaryDirectories.push(root);
    const script = join(root, "hang.sh");
    writeFileSync(script, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 30 &\nwait\n", "utf8");
    chmodSync(script, 0o755);

    let failure: unknown;
    try {
      await runScript(script, {}, [], 50);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("did not exit within 50ms");
    expect(activeHostScripts.size).toBe(0);
  });

  test("a grandchild retaining inherited pipes is reaped with its detached group", async () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-host-script-grandchild-"));
    temporaryDirectories.push(root);
    const marker = join(root, "grandchild-survived");
    const childPidPath = join(root, "grandchild.pid");
    const readyPath = join(root, "grandchild.ready");
    const script = join(root, "grandchild.sh");
    writeFileSync(
      script,
      '#!/usr/bin/env bash\n(trap "" TERM; sleep 30; : > "$1") &\necho "$!" > "$2"\n: > "$3"\nexit 0\n',
      "utf8",
    );
    chmodSync(script, 0o755);
    const proc = Bun.spawn(["bash", script, marker, childPidPath, readyPath], {
      detached: true,
      stderr: "pipe",
      stdout: "pipe",
    });
    activeHostScripts.add(proc);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (result: "ready" | "timeout"): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(deadline);
        if (result === "ready") {
          resolve();
        } else {
          reject(new Error("grandchild never became ready"));
        }
      };
      const deadline = setTimeout(() => finish("timeout"), 1_000);
      const observe = (): void => {
        if (finished) {
          return;
        }
        if (existsSync(readyPath)) {
          finish("ready");
          return;
        }
        setTimeout(observe, 5);
      };
      observe();
    });
    await proc.exited;
    await stopHostScript(proc);
    activeHostScripts.delete(proc);
    expect(existsSync(marker)).toBe(false);
    const childPid = Number(readFileSync(childPidPath, "utf8").trim());
    const childState = new TextDecoder()
      .decode(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(childPid)]).stdout)
      .trim();

    expect(childState === "" || childState.startsWith("Z")).toBe(true);
    expect(activeHostScripts.size).toBe(0);
  });
});

function lastJsonLine(stdout: string): Summary {
  const line = stdout
    .split("\n")
    .filter((entry) => entry.trim().length > 0)
    .at(-1);

  return JSON.parse(line ?? "{}") as Summary;
}

type WatchdogFixture = {
  busy?: string[];

  infinity?: string[];

  startFails?: string[];

  timers: string[];

  containerEnv?: Record<string, string>;
};

function watchdogStubs(root: string, fixture: WatchdogFixture): string {
  const bin = join(root, "bin");

  mkdirSync(bin, { recursive: true });

  writeStub(
    bin,
    "systemctl",
    [
      'in_list() { local n=$1 l=$2 i; for i in $l; do [ "$i" = "$n" ] && return 0; done; return 1; }',
      'cmd="$1"; shift',
      'case "$cmd" in',
      "  list-units)",
      '    pattern=""',
      '    for a in "$@"; do case "$a" in -*) ;; *) pattern="$a" ;; esac; done',
      "    for t in ${WD_TIMERS:-}; do",
      "      # shellcheck disable=SC2254",
      '      case "$t" in',
      "        $pattern) printf '%s loaded active waiting stub\\n' \"$t\" ;;",
      "      esac",
      "    done",
      "    ;;",
      "  show)",
      '    unit="$1"; prop=""',
      '    while [ "$#" -gt 0 ]; do case "$1" in -p) shift; prop="$1" ;; esac; shift; done',
      '    case "$prop" in',
      "      NextElapseUSecMonotonic)",
      '        if in_list "$unit" "${WD_INFINITY:-}"; then echo infinity; else echo 4242; fi ;;',
      "      NextElapseUSecRealtime)",
      '        if in_list "$unit" "${WD_INFINITY:-}"; then echo ""; else echo 4242; fi ;;',
      "      ActiveState)",
      '        if in_list "$unit" "${WD_BUSY:-}"; then echo active; else echo inactive; fi ;;',
      '      *) echo "" ;;',
      "    esac",
      "    ;;",
      "  start)",
      '    svc=""; for a in "$@"; do case "$a" in -*) ;; *) svc="$a" ;; esac; done',
      '    if in_list "$svc" "${WD_START_FAIL:-}"; then exit 1; fi',
      "    ;;",
      '  *) echo "unexpected systemctl $cmd" >&2; exit 64 ;;',
      "esac",
    ].join("\n"),
  );

  const envFile = join(root, "container-env");

  writeFileSync(
    envFile,
    Object.entries(fixture.containerEnv ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    "utf8",
  );
  writeStub(bin, "docker", `cat ${JSON.stringify(envFile)}`);

  return bin;
}

async function runWatchdog(
  fixture: WatchdogFixture,
  base?: string,
): Promise<{ code: number; stdout: string; summary: Summary }> {
  const root = mkdtempSync(join(tmpdir(), "fluncle-watchdog-"));
  temporaryDirectories.push(root);
  const bin = watchdogStubs(root, fixture);
  const run = await runScript(WATCHDOG, {
    FLUNCLE_API_BASE_URL: base ?? "",
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,

    TIMER_WATCHDOG_RECHECK_DELAY: "0",
    WD_BUSY: (fixture.busy ?? []).join(" "),
    WD_INFINITY: (fixture.infinity ?? []).join(" "),
    WD_START_FAIL: (fixture.startFails ?? []).join(" "),
    WD_TIMERS: fixture.timers.join(" "),
  });

  return { code: run.code, stdout: run.stdout, summary: lastJsonLine(run.stdout) };
}

describe("timer-watchdog reports a run", () => {
  const HEALTHY = ["fluncle-enrich.timer", "fluncle-crawl.timer", "pin-watch.timer"];

  test(
    "a clean pass counts what it examined",
    async () => {
      const { code, summary } = await runWatchdog({ timers: HEALTHY });

      expect(code).toBe(0);

      expect(summary).toEqual({
        checked: 3,
        errors: 0,
        expectedIntervalMs: 900_000,
        gateState: null,
        produced: 0,
        queue_depth: 0,
      });
      expect(derivedOk(code, summary.errors)).toBe(true);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "checked == 0 exits non-zero",
    async () => {
      const { code, summary } = await runWatchdog({ timers: [] });

      expect(code).toBe(1);
      expect(summary.checked).toBe(0);
      expect(summary.errors).toBe(1);
      expect(summary.produced).toBe(0);
      expect(summary.queue_depth).toBe(0);
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a stranded timer shows up as backlog cleared, not as backlog hidden",
    async () => {
      const { code, summary } = await runWatchdog({
        infinity: ["fluncle-anchor.timer"],
        timers: [...HEALTHY, "fluncle-anchor.timer"],
      });

      expect(code).toBe(0);
      expect(summary).toMatchObject({ checked: 4, errors: 0, produced: 1, queue_depth: 1 });
      expect(derivedOk(code, summary.errors)).toBe(true);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "ALARM SHAPE: found stranded, re-armed none",
    async () => {
      const { code, summary } = await runWatchdog({
        infinity: ["fluncle-anchor.timer", "fluncle-rank.timer"],
        startFails: ["fluncle-anchor.service", "fluncle-rank.service"],
        timers: [...HEALTHY, "fluncle-anchor.timer", "fluncle-rank.timer"],
      });

      expect(code).toBe(1);
      expect(summary).toMatchObject({ checked: 5, errors: 2, produced: 0, queue_depth: 2 });
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test("the alert attempt happens before the failed-rearm exit", () => {
    const body = readFileSync(WATCHDOG, "utf8");
    const alertAttempt = body.indexOf('webhook="$(container_env DISCORD_ALERT_WEBHOOK)"');
    const failedRearmExit = body.indexOf('[ "${#healed[@]}" -gt 0 ] || exit 1');

    expect(alertAttempt).toBeGreaterThan(-1);
    expect(failedRearmExit).toBeGreaterThan(-1);
    expect(alertAttempt).toBeLessThan(failedRearmExit);
  });

  test(
    "a busy oneshot is examined but never counted as stranded",
    async () => {
      const { summary } = await runWatchdog({
        busy: ["fluncle-anchor.service"],
        infinity: ["fluncle-anchor.timer"],
        timers: [...HEALTHY, "fluncle-anchor.timer"],
      });

      expect(summary).toMatchObject({ checked: 4, produced: 0, queue_depth: 0 });
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "posts the run record, with the token read off the live container",
    async () => {
      const { calls } = await withLedger(async (base, calls) => {
        await runWatchdog(
          { containerEnv: { FLUNCLE_API_TOKEN: "container-agent-token" }, timers: HEALTHY },
          base,
        );

        return { calls };
      });

      expect(runEvents(calls)).toHaveLength(1);
      expect(runEvents(calls)[0]?.auth).toBe("Bearer container-agent-token");

      const { posted, summary } = received(calls);

      expect(posted.unit).toBe("fluncle-timer-watchdog");
      expect(posted.exit_code).toBe(0);
      expect(summary.checked).toBe(3);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "no token on the container ⇒ no POST, and the pass is unaffected",
    async () => {
      const { calls, code } = await withLedger(async (base, calls) => {
        const run = await runWatchdog({ timers: HEALTHY }, base);

        return { calls, code: run.code };
      });

      expect(runEvents(calls)).toHaveLength(0);
      expect(code).toBe(0);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a permanently failing ledger POST leaves the sweep unharmed and the row absent",
    async () => {
      const { calls, code, landed } = await withLedger(
        async (base, calls, landed) => {
          const run = await runWatchdog(
            { containerEnv: { FLUNCLE_API_TOKEN: "container-agent-token" }, timers: HEALTHY },
            base,
          );

          return { calls, code: run.code, landed };
        },
        { responseStatus: 502 },
      );

      expect(runEvents(calls)).toHaveLength(1);
      expect(runEvents(landed)).toHaveLength(0);
      expect(code).toBe(0);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );
});

type SecretsFixture = {
  containerToken?: string;

  injectFails?: boolean;

  gsc?: "ok" | "fails";
};

async function runSecretsSync(
  fixture: SecretsFixture,
  base?: string,
): Promise<{ code: number; root: string; stderr: string; stdout: string; summary: Summary }> {
  const root = mkdtempSync(join(tmpdir(), "fluncle-secrets-sync-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const tpl = join(root, "tpl");
  const sweepOut = join(root, "state/home/.fluncle-secrets.env");

  mkdirSync(bin, { recursive: true });
  mkdirSync(tpl, { recursive: true });
  writeFileSync(join(tpl, "hermes.env.tpl"), "FLUNCLE_API_TOKEN={{op}}\n", "utf8");
  writeFileSync(join(tpl, "fluncle-secrets.env.tpl"), "CLAUDE_CODE_OAUTH_TOKEN={{op}}\n", "utf8");

  writeStub(
    bin,
    "op",
    [
      'if [ "$1" = "read" ]; then',
      `  [ "\${OP_GSC:-ok}" = "ok" ] || exit 1`,
      `  printf '{"private_key":"stub"}\\n'`,
      "  exit 0",
      "fi",
      'out=""; in=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in -o) shift; out="$1" ;; -i) shift; in="$1" ;; esac',
      "  shift",
      "done",
      'case "$in" in',
      "  *fluncle-secrets.env.tpl)",
      `    [ "\${OP_INJECT_SWEEP:-ok}" = "ok" ] || exit 1`,
      `    printf 'CLAUDE_CODE_OAUTH_TOKEN=stub\\n' >"$out" ;;`,
      `  *) printf 'FLUNCLE_API_TOKEN=stub\\n' >"$out" ;;`,
      "esac",
    ].join("\n"),
  );

  const containerEnv = join(root, "container-env");

  writeFileSync(
    containerEnv,
    fixture.containerToken === undefined ? "" : `FLUNCLE_API_TOKEN=${fixture.containerToken}\n`,
    "utf8",
  );
  writeStub(bin, "docker", `cat ${JSON.stringify(containerEnv)}`);

  const bootstrap = join(root, "bootstrap.env");

  writeFileSync(
    bootstrap,
    [
      "OP_SERVICE_ACCOUNT_TOKEN=stub",

      ...(fixture.gsc ? ["FLUNCLE_GSC_OP_REF='op://<vault>/<gsc-item>'"] : []),
    ].join("\n") + "\n",
    "utf8",
  );

  const run = await runScript(SECRETS_SYNC, {
    FLUNCLE_API_BASE_URL: base ?? "",
    HOME: root,
    OP_GSC: fixture.gsc === "fails" ? "fails" : "ok",
    OP_INJECT_SWEEP: fixture.injectFails ? "fails" : "ok",
    PATH: `${bin}:/usr/bin:/bin`,
    SECRETS_SYNC_BOOTSTRAP: bootstrap,
    SECRETS_SYNC_GATEWAY_OUT: join(root, "hermes.env"),
    SECRETS_SYNC_GSC_OUT: join(root, "state/home/.fluncle-gsc.json"),
    SECRETS_SYNC_SWEEP_OUT: sweepOut,
    SECRETS_SYNC_TPL_DIR: tpl,
  });

  return {
    code: run.code,
    root,
    stderr: run.stderr,
    stdout: run.stdout,
    summary: lastJsonLine(run.stdout),
  };
}

describe("secrets-sync reports a run", () => {
  test(
    "a clean sync writes both targets and says so",
    async () => {
      const { code, root, summary } = await runSecretsSync({});

      expect(code).toBe(0);
      expect(summary).toEqual({
        checked: 2,
        errors: 0,
        expectedIntervalMs: 900_000,
        gateState: null,
        produced: 2,
        queue_depth: 0,
        runLedgerReceipt: false,
      });
      expect(derivedOk(code, summary.errors)).toBe(true);

      expect(readFileSync(join(root, "hermes.env"), "utf8")).toContain("FLUNCLE_API_TOKEN");
      expect(readFileSync(join(root, "state/home/.fluncle-secrets.env"), "utf8")).toContain(
        "CLAUDE_CODE_OAUTH_TOKEN",
      );
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "posts with the token resolved from the container configuration",
    async () => {
      const { calls } = await withLedger(async (base, calls) => {
        await runSecretsSync({ containerToken: "container-agent-token" }, base);

        return { calls };
      });

      expect(runEvents(calls)).toHaveLength(1);
      expect(runEvents(calls)[0]?.auth).toBe("Bearer container-agent-token");

      const { posted, summary } = received(calls);

      expect(posted.unit).toBe("fluncle-secrets-sync");
      expect(summary).toMatchObject({ errors: 0, produced: 2 });
      expect("ok" in summary).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a failed op inject still reports with the container token",
    async () => {
      const { calls, code } = await withLedger(async (base, calls) => {
        const run = await runSecretsSync(
          { containerToken: "container-agent-token", injectFails: true },
          base,
        );

        return { calls, code: run.code };
      });

      expect(code).not.toBe(0);
      expect(runEvents(calls)[0]?.auth).toBe("Bearer container-agent-token");

      const { posted, summary } = received(calls);

      expect(posted.exit_code).not.toBe(0);

      expect(summary).toMatchObject({ checked: 2, produced: 0, queue_depth: 2 });
      expect(derivedOk(posted.exit_code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a missing container token is visible but does not fail the credential refresh",
    async () => {
      const { calls, code, root, stderr, summary } = await withLedger(async (base, calls) => {
        const run = await runSecretsSync({}, base);

        return { calls, ...run };
      });

      expect(runEvents(calls)).toHaveLength(0);
      expect(code).toBe(0);
      expect(stderr).toContain("run-ledger receipt did not land (missing-token)");
      expect(summary).toMatchObject({ errors: 0, produced: 2, runLedgerReceipt: false });
      expect(readFileSync(join(root, "hermes.env"), "utf8")).toContain("FLUNCLE_API_TOKEN");
      expect(readFileSync(join(root, "state/home/.fluncle-secrets.env"), "utf8")).toContain(
        "CLAUDE_CODE_OAUTH_TOKEN",
      );
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a failed POST is visible but does not fail the credential refresh",
    async () => {
      const { calls, code, landed, root, stderr, summary } = await withLedger(
        async (base, calls, landed) => {
          const run = await runSecretsSync({ containerToken: "container-agent-token" }, base);

          return { calls, landed, ...run };
        },
        { responseStatus: 502 },
      );

      expect(runEvents(calls)).toHaveLength(1);
      expect(runEvents(landed)).toHaveLength(0);
      expect(code).toBe(0);
      expect(stderr).toContain("run-ledger receipt did not land (post-failed)");
      expect(summary).toMatchObject({ errors: 0, produced: 2, runLedgerReceipt: false });
      expect(readFileSync(join(root, "hermes.env"), "utf8")).toContain("FLUNCLE_API_TOKEN");
      expect(readFileSync(join(root, "state/home/.fluncle-secrets.env"), "utf8")).toContain(
        "CLAUDE_CODE_OAUTH_TOKEN",
      );
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a missing bootstrap env reports the failure rather than dying quiet",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "fluncle-secrets-nobootstrap-"));
      temporaryDirectories.push(root);
      const bin = join(root, "bin");
      const dockerCalled = join(root, "docker-called");
      mkdirSync(bin, { recursive: true });

      writeStub(bin, "docker", `: >${JSON.stringify(dockerCalled)}\nexit 1`);
      const run = await runScript(SECRETS_SYNC, {
        FLUNCLE_API_BASE_URL: "",
        HOME: root,
        PATH: `${bin}:/usr/bin:/bin`,
        SECRETS_SYNC_BOOTSTRAP: join(root, "does-not-exist.env"),
        SECRETS_SYNC_SWEEP_OUT: join(root, "state/home/.fluncle-secrets.env"),
      });
      const summary = lastJsonLine(run.stdout);

      expect(run.code).toBe(1);
      expect(existsSync(dockerCalled)).toBe(true);
      expect(run.stderr).toContain("fluncle-secrets-sync: missing");
      expect(run.stderr).toContain("run-ledger receipt did not land (missing-token)");
      expect(summary).toMatchObject({ checked: 0, errors: 1, produced: 0 });
      expect(derivedOk(run.code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "the optional GSC key counts as a target — success and failure both land",
    async () => {
      const clean = await runSecretsSync({ gsc: "ok" });

      expect(clean.code).toBe(0);
      expect(clean.summary).toMatchObject({ checked: 3, errors: 0, produced: 3 });
      expect(derivedOk(clean.code, clean.summary.errors)).toBe(true);

      const degraded = await runSecretsSync({ gsc: "fails" });

      expect(degraded.code).toBe(0);
      expect(degraded.summary).toMatchObject({
        checked: 3,
        errors: 1,
        produced: 2,
        queue_depth: 1,
      });

      expect(derivedOk(degraded.code, degraded.summary.errors)).toBe(false);
    },
    TWO_SCRIPT_TEST_TIMEOUT_MS,
  );
});

type SonarFixture = {
  commit?: string;

  deployed?: string;

  locked?: boolean;

  unreachable?: boolean;

  runtimeContract?: "current" | "legacy";

  stateInitialized?: boolean;

  retryAfterBootstrapFailure?: boolean;

  bootstrapMarked?: boolean;

  stateContents?: string;

  interruptAfterSwap?: boolean;

  crashAfterSwap?: boolean;

  artifactCommit?: string;

  artifactHealthBody?: string;

  presmokeBindCollisions?: number;

  liveCommit?: string;

  priorLiveCommit?: string;

  mutateStateThenFail?: boolean;

  rollbackCleanupFails?: boolean;

  staleRollbackWal?: boolean;

  rollbackStateRemovalFails?: boolean;

  crashAfterAcceptanceIntentRemoval?: boolean;

  acceptanceCleanupFails?: boolean;

  acceptedShaWriteFails?: boolean;

  bootstrapMarkerRemovalFails?: boolean;

  bootstrapMarkerRemovalPersists?: boolean;
};

const SHA_A = "a".repeat(40);

const SHA_B = new Bun.CryptoHasher("sha1").update(`run-events:${process.pid}`).digest("hex");

const BOOT_BUDGET_SECS = 6;
const PORT_WALK_BOOT_BUDGET_SECS = 25;

const SMOKE_PORT_BASE = String(42_480 + (process.pid % 100) * 5);

function bootBudgetSecs(fixture: SonarFixture): string {
  return String(fixture.presmokeBindCollisions ? PORT_WALK_BOOT_BUDGET_SECS : BOOT_BUDGET_SECS);
}

const SONAR_STUB = [
  "#!/usr/bin/env bash",
  'if [ "${SONAR_VALIDATE_ONLY:-}" = "true" ] && grep -q "^partial$" "$SONAR_STATE_PATH" 2>/dev/null; then echo "state has no completed manifest" >&2; exit 2; fi',
  'if [ "${SONAR_VALIDATE_ONLY:-}" = "true" ] && [ "${SONAR_TEST_BIND_COLLISIONS:-0}" -gt 0 ]; then printf "attempt\\n" >>"$SONAR_TEST_BIND_ATTEMPTS"; attempts="$(awk \'END { print NR }\' "$SONAR_TEST_BIND_ATTEMPTS")"; if [ "$attempts" -le "$SONAR_TEST_BIND_COLLISIONS" ]; then echo "Address already in use (os error 98)" >&2; exit 1; fi; fi',
  'exec "$SONAR_TEST_BUN" -e "Bun.serve({fetch: () => new Response(process.env.SONAR_TEST_HEALTH_BODY || JSON.stringify({ok:true,commit:process.env.SONAR_TEST_COMMIT})), port: Number(process.env.SONAR_PORT)}); await new Promise(() => {});"',
  "",
].join("\n");

function readOptionalFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function retriesSonarFixture(fixture: SonarFixture): boolean {
  return Boolean(
    fixture.retryAfterBootstrapFailure ||
    fixture.crashAfterSwap ||
    fixture.crashAfterAcceptanceIntentRemoval ||
    fixture.acceptanceCleanupFails ||
    fixture.acceptedShaWriteFails ||
    fixture.bootstrapMarkerRemovalPersists,
  );
}

function sonarRetryArgs(fixture: SonarFixture, args: string[]): string[] {
  return fixture.crashAfterSwap ? [] : args;
}

function fixtureLiveCommit(fixture: SonarFixture, runningOld: boolean): string {
  if (runningOld) {
    return fixture.priorLiveCommit ?? fixture.deployed ?? SHA_A;
  }
  return fixture.liveCommit ?? fixture.commit ?? SHA_B;
}

function shellFlag(value: boolean | undefined): string {
  return value ? "1" : "0";
}

function numericFixtureValue(value: number | undefined): string {
  return String(value ?? 0);
}

async function runSonar(
  fixture: SonarFixture,
  base: string | undefined,
  args: string[] = [],
): Promise<{
  assetRequests: string[];
  attempts: Array<{ code: number; stderr: string; stdout: string }>;
  appContents: string;
  bootstrapReady: boolean;
  code: number;
  deployedSha: string | null;
  intentExists: boolean;
  previousExists: boolean;
  rollbackStateExists: boolean;
  rollbackWalExists: boolean;
  stateContents: string | null;
  stateWalContents: string | null;
  stderr: string;
  stdout: string;
  summary: Summary;
}> {
  const root = mkdtempSync(join(tmpdir(), "fluncle-sonar-freshen-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const appDir = join(root, "app");
  const statePath = join(root, "sonar-state.db");
  const replicaPath = join(root, "sonar-replica.db");
  const restartFailed = join(root, "restart-failed");
  const restartInterrupted = join(root, "restart-interrupted");
  const stateMutationFailed = join(root, "state-mutation-failed");
  const cleanupFailed = join(root, "cleanup-failed");
  const acceptedShaFailed = join(root, "accepted-sha-failed");
  const bootstrapUnlinkFailed = join(root, "bootstrap-unlink-failed");
  const bindAttempts = join(root, "bind-attempts");
  const stateDir = join(root, "state");
  const rollbackIntent = join(stateDir, "swap-in-progress");
  const rollbackState = join(stateDir, "local-state.rollback");

  mkdirSync(bin, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "sonar"), "#!/usr/bin/env bash\n# old-sonar\nexit 0\n", "utf8");
  chmodSync(join(appDir, "sonar"), 0o755);

  writeStub(bin, "flock", '[ "${SF_LOCKED:-0}" = "1" ] && exit 1\nexit 0');
  writeStub(
    bin,
    "sync",
    [
      '[ "${SF_ACCEPTED_SHA_WRITE_FAILS:-0}" = "1" ] && [ "${2:-}" = "$SF_SHA_FILE" ] && grep -qx "$SF_NEW_SHA" "$SF_SHA_FILE" 2>/dev/null && [ ! -e "$SF_ACCEPTED_SHA_FAILED" ] && { : >"$SF_ACCEPTED_SHA_FAILED"; exit 1; }',
      '[ "${SF_ROLLBACK_CLEANUP_FAILS:-0}" = "1" ] && [ -e "$SF_STATE_MUTATION_FAILED" ] && [ ! -e "$SF_ROLLBACK_INTENT" ] && [ "${2:-}" = "$SF_APP_DIR" ] && exit 1',
      "exit 0",
    ].join("\n"),
  );
  writeStub(
    bin,
    "rm",
    [
      'if [ "${SF_ROLLBACK_STATE_REMOVAL_FAILS:-0}" = "1" ] && [ -e "$SF_STATE_MUTATION_FAILED" ]; then',
      '  for arg in "$@"; do [ "$arg" = "$SF_STATE_PATH-wal" ] && exit 1; done',
      "fi",
      'if [ "${SF_BOOTSTRAP_MARKER_REMOVAL_FAILS:-0}" = "1" ] && [ -e "$SF_ACCEPTED_SHA_FAILED" ] && [ ! -e "$SF_BOOTSTRAP_UNLINK_FAILED" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "$SF_BOOTSTRAP_READY" ]; then : >"$SF_BOOTSTRAP_UNLINK_FAILED"; exit 1; fi',
      "  done",
      "fi",
      'if [ "${SF_BOOTSTRAP_MARKER_REMOVAL_PERSISTS:-0}" = "1" ] && [ -e "$SF_ACCEPTED_SHA_FAILED" ]; then',
      '  for arg in "$@"; do [ "$arg" = "$SF_BOOTSTRAP_READY" ] && exit 1; done',
      "fi",
      'if [ "${SF_CRASH_AFTER_ACCEPTANCE_INTENT_REMOVAL:-0}" = "1" ] && [ -e "$SF_BOOTSTRAP_READY" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "$SF_ROLLBACK_INTENT" ]; then /bin/rm "$@"; kill -KILL "$PPID"; sleep 1; fi',
      "  done",
      "fi",
      'if [ "${SF_ACCEPTANCE_CLEANUP_FAILS:-0}" = "1" ] && [ -e "$SF_BOOTSTRAP_READY" ] && [ ! -e "$SF_ROLLBACK_INTENT" ] && [ ! -e "$SF_CLEANUP_FAILED" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "$SF_STATE_ROLLBACK" ]; then : >"$SF_CLEANUP_FAILED"; exit 1; fi',
      "  done",
      "fi",
      'exec /bin/rm "$@"',
    ].join("\n"),
  );

  writeStub(
    bin,
    "systemctl",
    [
      'if [ "$1" = "restart" ] && [ "${SF_RESTART_FAIL_ONCE:-0}" = "1" ]; then',
      '  if grep -q "old-sonar" "$SF_APP_BIN" 2>/dev/null; then exit 0; fi',
      '  if [ ! -f "$SF_RESTART_FAILED" ]; then',
      '    printf "partial\n" >"$SF_STATE_PATH"',
      '    : >"$SF_RESTART_FAILED"',
      "    exit 1",
      "  fi",
      '  printf "complete\n" >"$SF_STATE_PATH"',
      "fi",
      'if [ "$1" = "restart" ] && [ "${SF_MUTATE_STATE_THEN_FAIL:-0}" = "1" ]; then',
      '  if grep -q "old-sonar" "$SF_APP_BIN" 2>/dev/null; then',
      '    grep -qx "fixture" "$SF_STATE_PATH" 2>/dev/null || exit 1',
      '  elif [ ! -f "$SF_STATE_MUTATION_FAILED" ]; then',
      '    printf "candidate-state\n" >"$SF_STATE_PATH"',
      '    printf "candidate-wal\n" >"$SF_STATE_PATH-wal"',
      '    : >"$SF_STATE_MUTATION_FAILED"',
      "    exit 1",
      "  fi",
      '  [ ! -e "$SF_STATE_PATH-wal" ] || exit 1',
      "fi",
      'if [ "$1" = "restart" ] && [ "${SF_INTERRUPT_AFTER_SWAP:-0}" = "1" ] && ! grep -q "old-sonar" "$SF_APP_BIN" 2>/dev/null && [ ! -f "$SF_RESTART_INTERRUPTED" ]; then',
      '  : >"$SF_RESTART_INTERRUPTED"',
      '  kill -TERM "$PPID"',
      "  sleep 1",
      "fi",
      'if [ "$1" = "restart" ] && [ "${SF_CRASH_AFTER_SWAP:-0}" = "1" ] && ! grep -q "old-sonar" "$SF_APP_BIN" 2>/dev/null && [ ! -f "$SF_RESTART_INTERRUPTED" ]; then',
      '  printf "candidate-state\n" >"$SF_STATE_PATH"',
      '  : >"$SF_RESTART_INTERRUPTED"',
      '  kill -KILL "$PPID"',
      "  sleep 1",
      "fi",
      'if [ "$1" = "restart" ] && [ "${SF_CRASH_AFTER_SWAP:-0}" = "1" ] && grep -q "old-sonar" "$SF_APP_BIN" 2>/dev/null; then',
      '  grep -qx "fixture" "$SF_STATE_PATH" 2>/dev/null || exit 1',
      "fi",
      "exit 0",
    ].join("\n"),
  );

  const digest = new Bun.CryptoHasher("sha256").update(SONAR_STUB).digest("hex");
  const assetRequests: string[] = [];
  const server = Bun.serve({
    fetch(request) {
      const { pathname } = new URL(request.url);
      assetRequests.push(pathname);

      if (pathname.endsWith("/sonar.commit")) {
        return fixture.commit === undefined
          ? new Response("nope", { status: 404 })
          : new Response(`${fixture.commit}\n`);
      }

      if (pathname.endsWith("/sonar.sha256")) {
        return new Response(`${digest}  sonar\n`);
      }

      if (pathname.endsWith("/sonar")) {
        return new Response(SONAR_STUB);
      }

      return new Response("no", { status: 404 });
    },
    port: 0,
  });

  const live = Bun.serve({
    fetch: () => {
      const runningOld = readFileSync(join(appDir, "sonar"), "utf8").includes("old-sonar");
      return new Response(
        JSON.stringify({ commit: fixtureLiveCommit(fixture, runningOld), ok: true }),
      );
    },
    port: 0,
  });
  const serviceEnv = join(root, "sonar.env");

  const legacyContract = fixture.runtimeContract === "legacy";
  const serviceEnvironment = [
    "TURSO_DATABASE_URL=libsql://stub",
    "TURSO_AUTH_TOKEN=stub",
    "SONAR_SECRET=stub",
    `SONAR_PORT=${live.port}`,
    ...(legacyContract
      ? ["SONAR_REFRESH_SECS=300"]
      : [
          "FLUNCLE_API_BASE_URL=http://127.0.0.1:1",
          "FLUNCLE_API_TOKEN=stub",
          "SONAR_CONSUMER_ID=sonar.test",
          `SONAR_REPLICA_PATH=${replicaPath}`,
          `SONAR_STATE_PATH=${statePath}`,
        ]),
  ];
  writeFileSync(serviceEnv, serviceEnvironment.join("\n"), "utf8");
  if (!legacyContract && fixture.stateInitialized !== false) {
    writeFileSync(statePath, fixture.stateContents ?? "fixture", "utf8");
  }

  if (fixture.deployed) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "deployed-sha"), `${fixture.deployed}\n`, "utf8");
  }
  if (fixture.bootstrapMarked) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "local-state-ready"), `${fixture.deployed ?? SHA_A}\n`, "utf8");
  }
  if (fixture.staleRollbackWal) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${rollbackState}-wal`, "stale-rollback-wal", "utf8");
  }

  const assetBase = fixture.unreachable
    ? "http://127.0.0.1:1"
    : `http://127.0.0.1:${server.port}/download`;

  try {
    const scriptEnvironment = {
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      SF_ACCEPTANCE_CLEANUP_FAILS: fixture.acceptanceCleanupFails ? "1" : "0",
      SF_ACCEPTED_SHA_FAILED: acceptedShaFailed,
      SF_ACCEPTED_SHA_WRITE_FAILS: shellFlag(fixture.acceptedShaWriteFails),
      SF_APP_BIN: join(appDir, "sonar"),
      SF_APP_DIR: appDir,
      SF_BOOTSTRAP_MARKER_REMOVAL_FAILS: shellFlag(fixture.bootstrapMarkerRemovalFails),
      SF_BOOTSTRAP_MARKER_REMOVAL_PERSISTS: shellFlag(fixture.bootstrapMarkerRemovalPersists),
      SF_BOOTSTRAP_READY: join(stateDir, "local-state-ready"),
      SF_BOOTSTRAP_UNLINK_FAILED: bootstrapUnlinkFailed,
      SF_CLEANUP_FAILED: cleanupFailed,
      SF_CRASH_AFTER_ACCEPTANCE_INTENT_REMOVAL: fixture.crashAfterAcceptanceIntentRemoval
        ? "1"
        : "0",
      SF_CRASH_AFTER_SWAP: fixture.crashAfterSwap ? "1" : "0",
      SF_INTERRUPT_AFTER_SWAP: fixture.interruptAfterSwap ? "1" : "0",
      SF_LOCKED: fixture.locked ? "1" : "0",
      SF_MUTATE_STATE_THEN_FAIL: fixture.mutateStateThenFail ? "1" : "0",
      SF_NEW_SHA: fixture.commit ?? SHA_B,
      SF_RESTART_FAILED: restartFailed,
      SF_RESTART_FAIL_ONCE: fixture.retryAfterBootstrapFailure ? "1" : "0",
      SF_RESTART_INTERRUPTED: restartInterrupted,
      SF_ROLLBACK_CLEANUP_FAILS: fixture.rollbackCleanupFails ? "1" : "0",
      SF_ROLLBACK_INTENT: rollbackIntent,
      SF_ROLLBACK_STATE_REMOVAL_FAILS: fixture.rollbackStateRemovalFails ? "1" : "0",
      SF_SHA_FILE: join(stateDir, "deployed-sha"),
      SF_STATE_MUTATION_FAILED: stateMutationFailed,
      SF_STATE_PATH: statePath,
      SF_STATE_ROLLBACK: rollbackState,
      SONARFRESHEN_APP_DIR: appDir,
      SONARFRESHEN_ASSET_BASE: assetBase,
      SONARFRESHEN_BOOT_TIMEOUT_SECS: bootBudgetSecs(fixture),
      SONARFRESHEN_LOCK: join(root, "lock"),
      SONARFRESHEN_SERVICE_ENV: serviceEnv,
      SONARFRESHEN_SMOKE_PORT_BASE: SMOKE_PORT_BASE,
      SONARFRESHEN_STATE_DIR: stateDir,
      SONARFRESHEN_WORKER_URL: base ?? "http://127.0.0.1:1",
      SONAR_TEST_BIND_ATTEMPTS: bindAttempts,
      SONAR_TEST_BIND_COLLISIONS: numericFixtureValue(fixture.presmokeBindCollisions),
      SONAR_TEST_BUN: process.execPath,
      SONAR_TEST_COMMIT: fixture.artifactCommit ?? fixture.commit ?? SHA_B,
      SONAR_TEST_HEALTH_BODY: fixture.artifactHealthBody ?? "",
      ...(base === undefined ? {} : { FLUNCLE_API_TOKEN: "sonar-agent-token" }),
    };
    const attempts = [await runScript(SONAR_FRESHEN, scriptEnvironment, args)];
    if (retriesSonarFixture(fixture)) {
      attempts.push(
        await runScript(SONAR_FRESHEN, scriptEnvironment, sonarRetryArgs(fixture, args)),
      );
    }
    const run = attempts.at(-1);
    if (!run) {
      throw new Error("sonar freshen fixture produced no attempts");
    }

    return {
      appContents: readFileSync(join(appDir, "sonar"), "utf8"),
      assetRequests,
      attempts,
      bootstrapReady: existsSync(join(root, "state/local-state-ready")),
      code: run.code,
      deployedSha: readOptionalFile(join(stateDir, "deployed-sha"))?.trim() ?? null,
      intentExists: existsSync(rollbackIntent),
      previousExists: existsSync(join(appDir, "sonar.prev")),
      rollbackStateExists: existsSync(rollbackState),
      rollbackWalExists: existsSync(`${rollbackState}-wal`),
      stateContents: readOptionalFile(statePath),
      stateWalContents: readOptionalFile(`${statePath}-wal`),
      stderr: run.stderr,
      stdout: run.stdout,
      summary: lastJsonLine(run.stdout),
    };
  } finally {
    await server.stop(true);
    await live.stop(true);
  }
}

describe("sonar-freshen reports a run", () => {
  test("state rollback preserves the service user's file metadata", () => {
    const freshener = readFileSync(SONAR_FRESHEN, "utf8");

    expect(freshener).toContain('cp -pf "$source_file" "$backup_file"');
    expect(freshener).toContain('cp -pf "$source_file" "$target_file"');
  });

  test("candidate acceptance persists identity before disarming and cleaning intent", () => {
    const freshener = readFileSync(SONAR_FRESHEN, "utf8");
    const acceptance = freshener.indexOf('if service_healthy "$NEW_SHA" && mark_bootstrap_ready');
    const persistIdentity = freshener.indexOf('write_deployed_sha "$NEW_SHA"', acceptance);
    const disarm = freshener.indexOf("ROLLBACK_ARMED=0", acceptance);
    const cleanup = freshener.indexOf("cleanup_accepted_swap", acceptance);

    expect(acceptance).toBeGreaterThan(-1);
    expect(persistIdentity).toBeGreaterThan(acceptance);
    expect(disarm).toBeGreaterThan(persistIdentity);
    expect(cleanup).toBeGreaterThan(disarm);
  });

  test(
    "the common tick: checked, nothing to do, nothing done",
    async () => {
      const { code, summary } = await runSonar({ commit: SHA_A, deployed: SHA_A }, undefined);

      expect(code).toBe(0);
      expect(summary).toEqual({
        checked: 1,
        errors: 0,
        expectedIntervalMs: 3_600_000,
        gateState: null,
        produced: 0,
        queueDepth: 0,
      });
      expect(derivedOk(code, summary.errors)).toBe(true);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "BLINDNESS: an unreachable release feed is `checked:0`, never a quiet success",
    async () => {
      const { code, summary } = await runSonar({ unreachable: true }, undefined);

      expect(code).toBe(0);
      expect(summary).toMatchObject({ checked: 0, errors: 1, queueDepth: 0 });
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a malformed sonar.commit is the same shape — it resolved nothing",
    async () => {
      const { code, summary } = await runSonar({ commit: "<html>not a sha</html>" }, undefined);

      expect(code).toBe(0);
      expect(summary).toMatchObject({ checked: 0, errors: 1 });
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "GATED: a lock-held tick reports null counters, not zeros",
    async () => {
      const { code, summary } = await runSonar({ commit: SHA_A, locked: true }, undefined);

      expect(code).toBe(0);
      expect(summary).toEqual({
        checked: null,
        errors: 0,
        expectedIntervalMs: 3_600_000,
        gateState: "locked",
        produced: null,
        queueDepth: null,
      });
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test("a real deploy: downloaded, verified, pre-smoked, swapped, and COUNTED", async () => {
    const { calls, code, summary } = await withLedger(async (base, calls) => {
      const run = await runSonar({ commit: SHA_B, deployed: SHA_A }, base);

      return { calls, code: run.code, summary: run.summary };
    });

    expect(code).toBe(0);

    expect(summary).toMatchObject({
      checked: 1,
      errors: 0,
      gateState: null,
      produced: 1,
      queueDepth: 0,
    });
    expect(derivedOk(code, summary.errors)).toBe(true);

    expect(runEvents(calls)[0]?.auth).toBe("Bearer sonar-agent-token");

    const { posted } = received(calls);

    expect(posted.unit).toBe("fluncle-sonar-freshen");
    expect(posted.exit_code).toBe(0);
  }, 60_000);

  test("an interrupted candidate restart restores the previous binary through the EXIT trap", async () => {
    const { appContents, code, previousExists, stderr, summary } = await runSonar(
      { commit: SHA_B, deployed: SHA_A, interruptAfterSwap: true },
      undefined,
    );

    expect(code).not.toBe(0);
    expect(appContents).toContain("old-sonar");
    expect(previousExists).toBe(false);
    expect(stderr).toContain("rollback restored the previous healthy sonar binary");
    expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queueDepth: 1 });
  }, 60_000);

  test("rollback restores durable state before the previous binary may report healthy", async () => {
    const { appContents, code, previousExists, stateContents, stderr, summary } = await runSonar(
      { commit: SHA_B, deployed: SHA_A, mutateStateThenFail: true },
      undefined,
    );

    expect(code).toBe(1);
    expect(appContents).toContain("old-sonar");
    expect(stateContents).toBe("fixture");
    expect(previousExists).toBe(false);
    expect(stderr).toContain("rollback restored the previous healthy sonar binary");
    expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queueDepth: 1 });
  }, 60_000);

  test("rollback removes candidate WAL instead of restoring a stale backup sidecar", async () => {
    const { code, rollbackWalExists, stateContents, stateWalContents, stderr } = await runSonar(
      {
        commit: SHA_B,
        deployed: SHA_A,
        mutateStateThenFail: true,
        staleRollbackWal: true,
      },
      undefined,
    );

    expect(code).toBe(1);
    expect(stateContents).toBe("fixture");
    expect(stateWalContents).toBeNull();
    expect(rollbackWalExists).toBe(false);
    expect(stderr).toContain("rollback restored the previous healthy sonar binary");
  }, 60_000);

  test("a failed state removal aborts rollback before claiming the old generation healthy", async () => {
    const { appContents, code, intentExists, previousExists, stateWalContents, stderr } =
      await runSonar(
        {
          commit: SHA_B,
          deployed: SHA_A,
          mutateStateThenFail: true,
          rollbackStateRemovalFails: true,
        },
        undefined,
      );

    expect(code).toBe(1);
    expect(appContents).not.toContain("old-sonar");
    expect(stateWalContents).toBe("candidate-wal\n");
    expect(intentExists).toBe(true);
    expect(previousExists).toBe(true);
    expect(stderr).toContain("FATAL: rollback failed — sonar is down");
    expect(stderr).not.toContain("rollback restored the previous healthy sonar binary");
  }, 60_000);

  test("post-health rollback cleanup debt never reports the healthy service down", async () => {
    const { appContents, code, stateContents, stderr } = await runSonar(
      {
        commit: SHA_B,
        deployed: SHA_A,
        mutateStateThenFail: true,
        rollbackCleanupFails: true,
      },
      undefined,
    );

    expect(code).toBe(1);
    expect(appContents).toContain("old-sonar");
    expect(stateContents).toBe("fixture");
    expect(stderr).toContain("rollback is healthy and durable, but stale rollback files");
    expect(stderr).toContain("rollback restored the previous healthy sonar binary");
    expect(stderr).not.toContain("ROLLBACK ALSO FAILED");
  }, 60_000);

  test(
    "a hard-killed swap is recovered from disk before an already-current no-op",
    async () => {
      const { appContents, attempts, code, previousExists, stateContents, stderr, summary } =
        await runSonar({ commit: SHA_B, crashAfterSwap: true, deployed: SHA_B }, undefined, [
          "--force",
        ]);

      expect(attempts[0]?.code).not.toBe(0);
      expect(code).toBe(0);
      expect(stderr).toContain(
        "interrupted-swap recovery restored the previous healthy sonar binary",
      );
      expect(stderr).toContain("already current — no-op");
      expect(appContents).toContain("old-sonar");
      expect(stateContents).toBe("fixture");
      expect(previousExists).toBe(false);
      expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queueDepth: 0 });
    },
    TWO_SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a hard kill after intent removal keeps accepted identity crash-consistent",
    async () => {
      const {
        appContents,
        attempts,
        code,
        deployedSha,
        intentExists,
        previousExists,
        rollbackStateExists,
        stderr,
        summary,
      } = await runSonar(
        {
          commit: SHA_B,
          crashAfterAcceptanceIntentRemoval: true,
          deployed: SHA_A,
          priorLiveCommit: SHA_B,
        },
        undefined,
      );

      expect(attempts[0]?.code).not.toBe(0);
      expect(code).toBe(0);
      expect(appContents).not.toContain("old-sonar");
      expect(deployedSha).toBe(SHA_B);
      expect(intentExists).toBe(false);
      expect(previousExists).toBe(false);
      expect(rollbackStateExists).toBe(false);
      expect(stderr).toContain("already current — no-op");
      expect(stderr).not.toContain("interrupted-swap recovery restored");
      expect(summary).toMatchObject({ checked: 1, errors: 0, produced: 0, queueDepth: 0 });
    },
    TWO_SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "accepted cleanup debt preserves success and is removed by the next no-op",
    async () => {
      const {
        attempts,
        code,
        deployedSha,
        previousExists,
        rollbackStateExists,
        rollbackWalExists,
        stderr,
        summary,
      } = await runSonar(
        { acceptanceCleanupFails: true, commit: SHA_B, deployed: SHA_A },
        undefined,
      );
      const accepted = attempts.at(0);
      if (!accepted) {
        throw new Error("accepted cleanup fixture produced no first attempt");
      }

      expect(accepted.code).toBe(0);
      expect(lastJsonLine(accepted.stdout)).toMatchObject({
        errors: 0,
        produced: 1,
        queueDepth: 0,
      });
      expect(accepted.stderr).toContain("accepted sonar is healthy, but stale rollback files");
      expect(code).toBe(0);
      expect(deployedSha).toBe(SHA_B);
      expect(previousExists).toBe(false);
      expect(rollbackStateExists).toBe(false);
      expect(rollbackWalExists).toBe(false);
      expect(stderr).toContain("already current — no-op");
      expect(summary).toMatchObject({ checked: 1, errors: 0, produced: 0, queueDepth: 0 });
    },
    TWO_SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "bootstrap-marker unlink failure leaves durable recovery intent and still restores",
    async () => {
      const { attempts, bootstrapReady, code, deployedSha, intentExists, stderr, summary } =
        await runSonar(
          {
            acceptedShaWriteFails: true,
            bootstrapMarkerRemovalFails: true,
            commit: SHA_B,
            deployed: SHA_A,
          },
          undefined,
        );
      const failed = attempts.at(0);
      if (!failed) {
        throw new Error("bootstrap-marker cleanup fixture produced no first attempt");
      }

      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain(
        "rollback is healthy and durable, but bootstrap-marker cleanup is pending",
      );
      expect(failed.stderr).toContain("rollback restored the previous healthy sonar binary");
      expect(failed.stderr).not.toContain("rollback failed — sonar is down");
      expect(code).toBe(0);
      expect(deployedSha).toBe(SHA_B);
      expect(intentExists).toBe(false);
      expect(bootstrapReady).toBe(true);
      expect(stderr).toContain(
        "interrupted-swap recovery restored the previous healthy sonar binary",
      );
      expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 1, queueDepth: 0 });
    },
    TWO_SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "persistent marker cleanup debt retains intent and every rollback artifact",
    async () => {
      const {
        appContents,
        bootstrapReady,
        code,
        deployedSha,
        intentExists,
        previousExists,
        rollbackStateExists,
        stderr,
        summary,
      } = await runSonar(
        {
          acceptedShaWriteFails: true,
          bootstrapMarkerRemovalPersists: true,
          commit: SHA_B,
          deployed: SHA_A,
        },
        undefined,
      );

      expect(code).toBe(1);
      expect(appContents).toContain("old-sonar");
      expect(deployedSha).toBe(SHA_A);
      expect(intentExists).toBe(true);
      expect(previousExists).toBe(true);
      expect(rollbackStateExists).toBe(true);
      expect(bootstrapReady).toBe(true);
      expect(stderr).toContain("rollback cleanup remains pending; deferring the release check");
      expect(stderr).not.toContain("a newer sonar build is published");
      expect(summary).toMatchObject({ checked: 0, errors: 1, produced: 0, queueDepth: 0 });
    },
    TWO_SCRIPT_TEST_TIMEOUT_MS,
  );

  test("pre-smoke rejects a self-consistent artifact built from a different commit", async () => {
    const { appContents, code, previousExists, stderr, summary } = await runSonar(
      {
        artifactHealthBody: JSON.stringify({
          commit: SHA_A,
          detail: `"commit":"${SHA_B}"`,
          ok: true,
        }),
        commit: SHA_B,
        deployed: SHA_A,
      },
      undefined,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("pre-smoke failed");
    expect(appContents).toContain("old-sonar");
    expect(previousExists).toBe(false);
    expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queueDepth: 1 });
  }, 60_000);

  test("pre-smoke retries a confirmed bind collision on the next bounded candidate", async () => {
    const { code, stderr, summary } = await runSonar(
      { commit: SHA_B, deployed: SHA_A, presmokeBindCollisions: 1 },
      undefined,
      ["--dry-run"],
    );

    expect(code, stderr).toBe(0);
    expect(stderr).toContain("was claimed during boot; trying the next candidate");
    expect(stderr).toContain("pre-smoke passed");
    expect(summary).toMatchObject({ checked: 1, errors: 0, produced: 0, queueDepth: 1 });
  }, 60_000);

  test("pre-smoke fails after every bounded candidate reports a bind collision", async () => {
    const { appContents, code, previousExists, stderr, summary } = await runSonar(
      { commit: SHA_B, deployed: SHA_A, presmokeBindCollisions: 5 },
      undefined,
    );

    expect(code).toBe(1);
    expect(stderr).toContain(
      "pre-smoke failed: every available isolated smoke port was claimed during boot",
    );
    expect(appContents).toContain("old-sonar");
    expect(previousExists).toBe(false);
    expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queueDepth: 1 });
  }, 60_000);

  test("a bind retry cannot soften the candidate's wrong baked commit", async () => {
    const { appContents, code, stderr } = await runSonar(
      { artifactCommit: SHA_A, commit: SHA_B, deployed: SHA_A, presmokeBindCollisions: 1 },
      undefined,
      ["--dry-run"],
    );

    expect(code, stderr).toBe(1);
    expect(stderr).toContain("reports a different baked commit than sonar.commit");
    expect(appContents).toContain("old-sonar");
  }, 60_000);

  test("post-smoke rolls back when the live listener reports a different commit", async () => {
    const { appContents, code, previousExists, stderr, summary } = await runSonar(
      { commit: SHA_B, deployed: SHA_A, liveCommit: SHA_A },
      undefined,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("rollback restored the previous healthy sonar binary");
    expect(appContents).toContain("old-sonar");
    expect(previousExists).toBe(false);
    expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queueDepth: 1 });
  }, 60_000);

  test(
    "a legacy runtime contract refuses before downloading or touching the live service",
    async () => {
      const { assetRequests, code, stderr, summary } = await runSonar(
        { commit: SHA_B, deployed: SHA_A, runtimeContract: "legacy" },
        undefined,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("legacy remote-query runtime contract");
      expect(assetRequests).toEqual(["/download/sonar.commit"]);
      expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queueDepth: 1 });
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a complete current contract may bootstrap once through the guarded swap",
    async () => {
      const { assetRequests, code, stderr, summary } = await runSonar(
        { commit: SHA_B, deployed: SHA_A, stateInitialized: false },
        undefined,
      );

      expect(code).toBe(0);
      expect(stderr).toContain("deferring the one-time bootstrap to the guarded service swap");
      expect(stderr).toContain("post-swap smoke passed");
      expect(assetRequests).toEqual([
        "/download/sonar.commit",
        "/download/sonar",
        "/download/sonar.sha256",
      ]);
      expect(summary).toMatchObject({ checked: 1, errors: 0, produced: 1, queueDepth: 0 });
      expect(derivedOk(code, summary.errors)).toBe(true);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a failed bootstrap retries after rollback removes its partial state",
    async () => {
      const { attempts, bootstrapReady, code, stateContents, stderr, summary } = await runSonar(
        {
          commit: SHA_B,
          deployed: SHA_A,
          retryAfterBootstrapFailure: true,
          stateInitialized: false,
        },
        undefined,
      );
      const first = attempts.at(0);
      if (!first) {
        throw new Error("bootstrap retry fixture produced no first attempt");
      }

      expect(first.code).toBe(1);
      expect(lastJsonLine(first.stdout)).toMatchObject({ errors: 1, produced: 0, queueDepth: 1 });
      expect(code).toBe(0);
      expect(attempts.at(0)?.stderr).toContain(
        "rollback restored the previous healthy sonar binary",
      );
      expect(stderr).toContain(
        "durable state is not initialized; deferring the one-time bootstrap to the guarded service swap",
      );
      expect(summary).toMatchObject({ checked: 1, errors: 0, produced: 1, queueDepth: 0 });
      expect(stateContents).toBe("complete\n");
      expect(bootstrapReady).toBe(true);
    },
    TWO_SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a marked bootstrap never downgrades a validation failure into a retry",
    async () => {
      const { bootstrapReady, code, stderr, summary } = await runSonar(
        {
          bootstrapMarked: true,
          commit: SHA_B,
          deployed: SHA_A,
          stateContents: "partial\n",
        },
        undefined,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("pre-smoke failed: the new binary exited during boot");
      expect(stderr).not.toContain("retrying the incomplete bootstrap");
      expect(summary).toMatchObject({ errors: 1, produced: 0, queueDepth: 1 });
      expect(bootstrapReady).toBe(true);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a dry run never bootstraps missing durable state",
    async () => {
      const { assetRequests, code, stderr, summary } = await runSonar(
        { commit: SHA_B, deployed: SHA_A, stateInitialized: false },
        undefined,
        ["--dry-run"],
      );

      expect(code).toBe(1);
      expect(stderr).toContain("dry-run cannot perform the first guarded bootstrap");
      expect(assetRequests).toEqual(["/download/sonar.commit"]);
      expect(summary).toMatchObject({
        checked: 1,
        errors: 1,
        gateState: "dry-run",
        produced: 0,
        queueDepth: 1,
      });
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test("GATED: a dry run leaves the backlog standing but flags itself", async () => {
    const { code, summary } = await runSonar({ commit: SHA_B, deployed: SHA_A }, undefined, [
      "--dry-run",
    ]);

    expect(code).toBe(0);
    expect(summary).toMatchObject({
      checked: 1,
      errors: 0,
      gateState: "dry-run",
      produced: 0,
      queueDepth: 1,
    });
    expect(derivedOk(code, summary.errors)).toBe(true);
  }, 60_000);
});

type PinWatchFixture = {
  buildExit?: number;

  containerRunning?: boolean;

  fingerprintCurrent?: boolean;
};

const PIN_WATCH_LS_TREE = [
  "100644 blob aaaa\tdocs/agents/hermes/scripts/capture-sweep.ts",
  "100644 blob bbbb\tpackages/skills/fluncle-ledger/SKILL.md",
].join("\n");

async function runPinWatch(
  fixture: PinWatchFixture,
  responseStatus?: number,
): Promise<{ calls: LedgerCall[]; code: number; stderr: string; summary: Summary }> {
  const root = mkdtempSync(join(tmpdir(), "fluncle-pin-watch-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const repoDir = join(root, "build");
  const mountSource = join(root, "mount");
  const envTmp = join(root, "env-capture");

  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(join(repoDir, "docs/agents/hermes"), { recursive: true });
  mkdirSync(mountSource, { recursive: true });
  writeFileSync(
    join(repoDir, "docs/agents/hermes/Dockerfile"),
    [
      "FROM example/base:1",
      "RUN curl -fsSL https://example.test/releases/download/v9.9.9/fluncle-linux -o /usr/local/bin/fluncle",
      "RUN bun install -g @anthropic-ai/claude-code@8.8.8",
      "COPY docs/agents/hermes/scripts/ /opt/hermes-scripts/",
      "COPY packages/skills /opt/skills",
      "",
    ].join("\n"),
    "utf8",
  );

  writeStub(bin, "flock", "exit 0");

  writeStub(bin, "mktemp", 'printf "%s\\n" "$PW_ENVTMP"\n: >"$PW_ENVTMP"');

  writeStub(bin, "sha256sum", 'exec shasum -a 256 "$@"');

  writeStub(bin, "systemctl", "exit 0");
  writeStub(
    bin,
    "git",
    [
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    ls-tree) printf "%s\\n" "$PW_LS_TREE"; exit 0 ;;',
      '    rev-parse) printf "abc1234\\n"; exit 0 ;;',
      "  esac",
      "done",
      "exit 0",
    ].join("\n"),
  );
  writeStub(
    bin,
    "docker",
    [
      'case "$1" in',
      "  inspect)",
      '    case "${4:-}" in',
      '      *Mounts*) printf "%s\\n" "$PW_MOUNT_SRC"; exit 0 ;;',
      '      *Config.Image*) printf "%s\\n" "$PW_OLD_IMAGE"; exit 0 ;;',
      "      *Config.Env*)",
      '        if [ "$2" = "$PW_CONTAINER" ]; then',
      '          printf "FLUNCLE_API_TOKEN=%s\\nPW_RUNTIME=1\\n" "$PW_TOKEN"',
      "        else",
      '          printf "PW_BAKED=1\\n"',
      "        fi",
      "        exit 0",
      "        ;;",
      "    esac",
      '    [ "${PW_CONTAINER_RUNNING:-1}" = "1" ] || exit 1',
      "    exit 0",
      "    ;;",
      "  exec)",
      '    case "$3" in',
      '      fluncle) printf "fluncle 9.9.9\\n"; exit 0 ;;',
      '      claude) printf "8.8.8 (Claude Code)\\n"; exit 0 ;;',
      "      cat)",
      '        if [ "${PW_FINGERPRINT_CURRENT:-1}" = "1" ]; then',
      '          printf "%s\\n" "$PW_LS_TREE" | LC_ALL=C sort | shasum -a 256 | cut -d" " -f1',
      "        else",
      '          printf "stale-fingerprint\\n"',
      "        fi",
      "        exit 0",
      "        ;;",
      "    esac",
      "    exit 0",
      "    ;;",
      '  build) exit "${PW_BUILD_EXIT:-0}" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );

  return withLedger(
    async (base, calls) => {
      const run = await runScript(PIN_WATCH, {
        FLUNCLE_API_BASE_URL: base,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        PINWATCH_CONTAINER: "hermes-fixture",
        PINWATCH_LOCK: join(root, "lock"),
        PINWATCH_REPO_DIR: repoDir,
        PINWATCH_WORKER_URL: base,
        PW_BUILD_EXIT: String(fixture.buildExit ?? 0),
        PW_CONTAINER: "hermes-fixture",
        PW_CONTAINER_RUNNING: fixture.containerRunning === false ? "0" : "1",
        PW_ENVTMP: envTmp,
        PW_FINGERPRINT_CURRENT: fixture.fingerprintCurrent === false ? "0" : "1",
        PW_LS_TREE: PIN_WATCH_LS_TREE,
        PW_MOUNT_SRC: mountSource,
        PW_OLD_IMAGE: "fluncle-hermes:v2026.01.01-old",
        PW_TOKEN: "pin-watch-fixture-token",
      });

      return { calls, code: run.code, stderr: run.stderr, summary: lastJsonLine(run.stdout) };
    },
    responseStatus === undefined ? {} : { responseStatus },
  );
}

describe("pin-watch reports a run", () => {
  test(
    "QUIET: a tick with nothing to deploy posts a clean row",
    async () => {
      const { calls, code, summary } = await runPinWatch({});
      const { posted } = received(calls);

      expect(code).toBe(0);
      expect(posted.unit).toBe("fluncle-pin-watch");
      expect(posted.exit_code).toBe(0);

      expect(summary).toMatchObject({
        checked: 1,
        errors: 0,
        expectedIntervalMs: 3_600_000,
        produced: 0,
        queue_depth: 0,
      });
      expect(derivedOk(code, summary.errors)).toBe(true);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "FIRES: a failed build is a failed run, with the undeployed drift still on the worklist",
    async () => {
      const { calls, code, stderr, summary } = await runPinWatch({
        buildExit: 1,
        fingerprintCurrent: false,
      });
      const { posted } = received(calls);

      expect(stderr).toContain("FATAL: build failed");
      expect(code).toBe(1);
      expect(posted.exit_code).toBe(1);

      expect(summary).toMatchObject({ checked: 1, errors: 1, produced: 0, queue_depth: 1 });
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "FIRES: a tick that died before comparing anything reports no look at all",
    async () => {
      const { calls, code, summary } = await runPinWatch({ containerRunning: false });
      const { posted } = received(calls);

      expect(code).toBe(1);
      expect(posted.exit_code).toBe(1);

      expect(summary).toMatchObject({ checked: 0, errors: 1, produced: 0, queue_depth: 0 });
      expect(derivedOk(code, summary.errors)).toBe(false);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "a ledger the box cannot reach never changes the run's own verdict",
    async () => {
      const { code, summary } = await runPinWatch({}, 503);

      expect(code).toBe(0);
      expect(derivedOk(code, summary.errors)).toBe(true);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );
});
