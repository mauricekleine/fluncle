// Tests for the run ledger's THREE HOST UNITS — timer-watchdog, secrets-sync, and the sonar
// self-deploy freshen — plus the mirrored `record_run_event` block they carry.
//
//   bun test docs/agents/hermes/scripts/run-events.test.ts
//
// WHY THESE THREE HAVE A TEST AT ALL. They are the units that reported NOTHING: no /status
// marker, no ledger row, nothing but a journald line nobody reads. Two of them are exactly
// the shape that hides worst — a detector (the watchdog) and a self-deploy (sonar), both of
// which legitimately produce zero forever, so `produced == 0` says nothing about their health
// and only the DENOMINATOR does. A watchdog that examined ZERO timers while reporting a clean
// pass is not hypothetical: 897 consecutive runs, zero checks, green throughout.
//
// So every test here drives the REAL script — real bash, real exit paths, a real loopback
// ledger — and asserts on the bytes that actually left the box. `systemctl`, `docker`, `op` and
// `flock` are PATH stubs, and so is `curl`: `loopbackCurlRail` passes a loopback URL through to
// the real binary and REFUSES anything else, so "nothing touches the network" is enforced here
// rather than merely asserted. It had to be — that sentence was false until the rail existed.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const BEGIN = ">>> BEGIN MIRRORED BLOCK: record_run_event";
const END = "<<< END MIRRORED BLOCK: record_run_event <<<";

// ---------------------------------------------------------------------------
// THE MIRROR.
//
// The four scripts run on two different boxes with no shared bash library between them, so
// the emitter is carried verbatim in each. That is only safe if a drift FAILS A BUILD — the
// same bargain cost-emit.ts strikes with the cost ledger's id scheme.
// ---------------------------------------------------------------------------

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
  ])("%s carries the block byte for byte", (_name, path) => {
    expect(mirroredBlock(path)).toBe(canonical);
  });

  test("the block pins the endpoint and the five body fields", () => {
    // The contract the parallel `record_run` oRPC op owns. A change on either side has to be
    // made on both, and this is the line that says so out loud. The constant is shared with
    // cron-output.test.ts and CHECKED AGAINST THE WORKSPACE below — on its own, a pin here is
    // the same closed loop that let `/api/v1/admin/runs/events` ship against a Worker serving
    // `/api/v1/admin/telemetry/runs`.
    expect(canonical).toContain(`RUN_EVENT_PATH='${RUN_EVENT_ENDPOINT}'`);
    expect(canonical).toContain(
      '{"unit":"%s","started_at":"%s","ended_at":"%s","exit_code":%s,"summary_raw":"%s"}',
    );
    expect(canonical).toContain('-H "Authorization: Bearer ${token}"');
    // Bounded, always — an unbounded POST would hold a sweep open to its unit's timeout.
    expect(canonical).toContain('--max-time "$RUN_EVENT_TIMEOUT_SECS"');
    // HTTP and transport failures both reach the caller; only the caller may decide that a
    // best-effort receipt failure leaves its primary job successful.
    expect(canonical).toContain('RUN_EVENT_FAILURE_REASON="post-failed"');
    expect(canonical).toContain("curl -fsS");

    // And no `ok` in the CODE at all: the Worker derives it, so there is nowhere for a
    // self-reported one to creep back in. (The prose above the code quotes the bug it exists
    // to prevent, so the comments are excluded rather than the point being weakened.)
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
  ])("%s actually CALLS it — carrying the block is not the same as using it", (_name, path) => {
    const body = readFileSync(path, "utf8");
    const [, afterBlock = ""] = body.split(END);

    expect(afterBlock).toContain('record_run_event "$RUN_EVENT_UNIT"');
  });
});

// ---------------------------------------------------------------------------
// THE OTHER SIDE OF THE WIRE.
//
// The mirror test above is a CLOSED LOOP and this is what it cost: all four copies agreed on
// `/api/v1/admin/runs/events`, the contract declared `/admin/telemetry/runs`, so every POST
// 404'd, the `|| true` swallowed it, the ledger would have stayed permanently empty — and both
// suites were green, because each only ever tested its own half.
//
// Byte-equality between four copies of a constant says nothing about whether the constant is
// RIGHT. So these resolve what the box puts on the wire against what the workspace declares —
// the assertion that crosses the boundary.
// ---------------------------------------------------------------------------

describe("every path a box script hardcodes is a path the Worker serves", () => {
  const literals = boxScriptApiPaths();

  // The mechanism's own tripwire. A resolver that silently stopped finding anything would make
  // every assertion below pass vacuously, which is the failure mode of this whole file's
  // subject matter. Ten-odd real literals resolve today; this fails the moment none do.
  test("the resolver is not a no-op — real paths really resolve", () => {
    const resolved = literals.filter(({ literal }) => resolveApiPath(literal).kind === "contract");

    expect(resolved.length).toBeGreaterThan(4);
    // The cost ledger's emitter — the same mirror-a-constant pattern this one copied, and proof
    // the resolver reaches oRPC contract ops rather than only file routes.
    expect(resolveApiPath("/api/v1/admin/costs/events")).toEqual({
      kind: "contract",
      source: "packages/contracts/src/orpc/admin-costs.ts",
    });
    // And a file-route carve-out, so the second half of the resolver is proven too.
    expect(resolveApiPath("/api/v1/status").kind).toBe("file-route");
  });

  test("no script POSTs at a path nothing in the workspace declares", () => {
    const orphans = literals
      .filter(({ literal }) => resolveApiPath(literal).kind === "unresolved")
      .map(({ file, line, literal }) => `${file}:${line} → ${literal}`);

    expect(orphans).toEqual([]);
  });

  // The one hand-kept list in api-surface.ts, held to its own rule: an entry is a DATED absence
  // (a sibling PR's contract), never a standing exemption, so it names the PR that closes it.
  test("every pending path names the PR that closes it", () => {
    expect(PENDING_WORKSPACE_PATHS.size).toBeLessThanOrEqual(1);

    for (const [path, reason] of PENDING_WORKSPACE_PATHS) {
      expect(path.startsWith("/api/v1/")).toBe(true);
      expect(reason).toMatch(/PR #\d+/);
    }
  });

  // THE ASSERTION THAT WOULD HAVE CAUGHT IT. The run-ledger contract module is found BY FILENAME
  // — never by the path under test, which would prove nothing — and the four bash copies must
  // POST at one of the paths it declares. Until that module is on this branch there is nothing to
  // compare against, and the pending entry is the visible record of why.
  test("the run-ledger endpoint is the contract's own path, not a guess", () => {
    const declared = runLedgerContractPaths();

    if (declared.size === 0) {
      expect(PENDING_WORKSPACE_PATHS.has(RUN_EVENT_ENDPOINT)).toBe(true);

      return;
    }

    expect([...declared]).toContain(RUN_EVENT_ENDPOINT);
  });
});

// ---------------------------------------------------------------------------
// THE SUMMARY LINE STATES FACTS, NOT A VERDICT.
//
// Same failure class as the endpoint, one field in: the summary is bash's half of a contract the
// Worker owns, and a value only bash knows about is REJECTED at the edge — leaving no row, which
// reads as a missed run. Two vocabularies are pinned here: `ok` (which the emitter must not
// state at all) and `gateState` (which must be one of the ledger's six words).
// ---------------------------------------------------------------------------

const EMITTERS: [string, string][] = [
  ["timer-watchdog.sh", WATCHDOG],
  ["fluncle-secrets-sync.sh", SECRETS_SYNC],
  ["fluncle-sonar-freshen.sh", SONAR_FRESHEN],
];

/**
 * The gate word a script assigns inside its `--dry-run` branch, read out of the branch itself
 * rather than named here — the point being to catch the script reaching for the wrong word, which
 * a constant repeated in this file could not see.
 */
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

/** The literal JSON format string a script builds its summary line from. */
function summaryFormat(path: string): string {
  const match = /summary="\$\(printf '(\{[^']*})'/.exec(readFileSync(path, "utf8"));

  if (!match?.[1]) {
    throw new Error(`no summary printf format found in ${path}`);
  }

  return match[1];
}

describe("the summary line states facts, never a verdict", () => {
  test.each(EMITTERS)("%s prints no `ok` of its own", (_name, path) => {
    // Asserted on the FORMAT STRING rather than on a run's output, so it holds for every exit
    // path at once — including the ones no fixture reaches — and cannot be loosened by a test
    // that swaps an exact `toEqual` for a forgiving `toMatchObject`.
    expect(summaryFormat(path)).not.toContain('"ok"');
    // The counters it does print are the ledger's mandatory set, so `missing_fields` comes back
    // empty for these three and the upgrade queue names only sweeps that really owe something.
    for (const field of ["checked", "produced", "errors"]) {
      expect(summaryFormat(path)).toContain(`"${field}"`);
    }
    expect(
      summaryFormat(path).includes('"queueDepth"') || summaryFormat(path).includes('"queue_depth"'),
    ).toBe(true);
  });

  test("every gate value a script can emit is one of the ledger's six words", () => {
    const emitted = emittedGateStates(EMITTERS.map(([, path]) => path));

    // Non-empty, or this proves nothing: the extractor has to be finding the assignments.
    expect(emitted.length).toBeGreaterThan(0);

    for (const state of emitted) {
      expect(LEDGER_GATE_STATES).toContain(state);
    }
  });

  // MEMBERSHIP IS NOT ENOUGH, and this is the failure the six-word vocabulary actually cost.
  // `paused` and `dry-run` are both legal words, so the assertion above is green either way —
  // but the Worker nulls a `paused` run's work counters and keeps a `dry-run`'s, so a script
  // that reaches for the wrong legal word silently destroys its own `checked`. The rule is the
  // Worker's, read from the Worker: a gate a script uses for a tick that LOOKED must not be one
  // of the never-looked words.
  test("a gate a looking tick emits is not one of the Worker's never-looked words", () => {
    const neverLooked = workspaceNeverLookedGateStates();

    if (neverLooked === null) {
      expect(PENDING_WORKSPACE_PATHS.has(RUN_EVENT_ENDPOINT)).toBe(true);

      return;
    }

    // The premise: the Worker really does suppress for some words and not others.
    expect(neverLooked.length).toBeGreaterThan(0);
    expect(neverLooked).not.toContain("dry-run");

    // The sonar freshen is the one emitter with a gate, and its `--dry-run` tick reads the
    // release feed before declining to deploy — so its word has to be a keeping one.
    expect(neverLooked).not.toContain(dryRunGateState(SONAR_FRESHEN));
  });

  // And the vocabulary itself is checked against the Worker, the same way the endpoint is —
  // otherwise `LEDGER_GATE_STATES` is one more constant agreeing only with itself.
  test("that vocabulary is the Worker's own, whenever the Worker is here to ask", () => {
    const declared = workspaceGateStates();

    if (declared === null) {
      expect(PENDING_WORKSPACE_PATHS.has(RUN_EVENT_ENDPOINT)).toBe(true);

      return;
    }

    expect(declared).toEqual([...LEDGER_GATE_STATES].sort());
  });
});

// ---------------------------------------------------------------------------
// AND NOBODY GETS TO CALL THEM SILENT.
//
// Third face of the same failure: two committed statements that contradict each other. These
// three units used to report nothing, several docs said so, and the sentence outlives the fact
// the moment they start reporting — a reader (or an agent) trusting the prose then "knows" the
// watchdog is invisible on /status while it is posting every 15 minutes.
//
// So the claim is derived from the SCRIPTS: a unit that carries the emitter and calls it is a
// reporting unit, and no doc beside it may say otherwise. Prose cannot go stale against a build.
// ---------------------------------------------------------------------------

/** The systemd unit each host emitter reports as — read from the script, never listed here. */
function reportingUnits(): string[] {
  return EMITTERS.map(([name, path]) => {
    const match = /^RUN_EVENT_UNIT="([^"]+)"$/m.exec(readFileSync(path, "utf8"));

    if (!match?.[1]) {
      throw new Error(`no RUN_EVENT_UNIT in ${name}`);
    }

    return match[1];
  });
}

/** The claims that were TRUE before the ledger and are false for a reporting unit now. */
const SILENCE_CLAIMS = [
  /reports nowhere/i,
  /reports to nothing/i,
  /posts nothing either/i,
  /appears on `\/status` \*\*not at all\*\*/i,
];

describe("no doc calls a reporting unit silent", () => {
  test("the three units really are reporting units", () => {
    // The premise, checked first: without this the assertions below are about nothing.
    expect(reportingUnits().sort()).toEqual([
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

  // The expected-writers roster (PR #1005) declares the units it does NOT expect a /status
  // marker from, with a reason each. A missing MARKER is still true for these three — they run
  // outside the container. "And reports nowhere" is not: they POST to the run ledger. When that
  // file arrives, its reasons are held to the same rule as the prose above.
  test("the expected-writers roster does not call them silent either", () => {
    const roster = join(REPO, "docs/agents/hermes/scripts/cron-roster.ts");

    if (!existsSync(roster)) {
      // Nothing to contradict yet. Recorded rather than skipped silently: the file lands with
      // PR #1005, the same slice as this one, and the check arms itself the moment it does.
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

// ---------------------------------------------------------------------------
// THE DECLARED CADENCE.
//
// `expected_interval_ms` exists so freshness is judged against what actually runs. A constant
// in a script beside a period in a .timer file is a drift waiting to happen, so the pair is
// pinned: change the schedule without changing the constant and this goes red.
// ---------------------------------------------------------------------------

/** The cadence a systemd .timer really fires at, in ms, for the three forms this repo uses. */
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
  ])("%s", (_name, script, timer) => {
    const unitMatch = /^RUN_EVENT_UNIT="([^"]+)"$/m.exec(readFileSync(script, "utf8"));
    const unit = unitMatch?.[1];
    const rosterCadence = runLedgerWriters().find((writer) => writer.unit === unit);

    expect(unit).toBeDefined();
    expect(declaredIntervalMs(script)).toBe(timerIntervalMs(timer));
    expect(rosterCadence?.expectedIntervalMs).toBe(declaredIntervalMs(script));
  });
});

// ---------------------------------------------------------------------------
// THE LOOPBACK LEDGER + the PATH stubs.
// ---------------------------------------------------------------------------

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

/**
 * Just the ledger POSTs. The fixture stands in for the whole Worker, and sonar-freshen also
 * posts its /status row there, so filtering by path is what keeps the two apart.
 *
 * It filters on the SHARED endpoint constant, so a wrong path is not merely mismatched here —
 * every assertion below stops seeing any call at all, which is exactly what a 404 in production
 * would have looked like if anything had been watching.
 */
const runEvents = (calls: LedgerCall[]) => calls.filter((call) => call.path === RUN_EVENT_ENDPOINT);

/** The one run record the ledger received, plus its `summary_raw` parsed back into an object. */
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

/**
 * THE LOOPBACK RAIL — `curl` is a PATH stub, exactly like `systemctl`, `docker` and `flock`.
 *
 * The header of this file says nothing here touches the network. Until this existed that was a
 * CLAIM, not a mechanism, and it was false: an unset `FLUNCLE_API_BASE_URL` is documented to
 * fall back to the emitter's box default — production — and a script can resolve its own token
 * independently of the test runner's environment. That once sent no-ledger fixtures off-box.
 *
 * So the rail: a loopback URL passes through to the real binary, anything else is REFUSED and
 * recorded, and `runScript` throws on a recorded refusal. Refusing is not enough on its own:
 * three callers still deliberately discard the emitter's best-effort return, so the recording
 * turns a leak into a named test failure instead of a silent one.
 */
function loopbackCurlRail(): { dir: string; refusals: string } {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-loopback-rail-"));
  const refusals = join(dir, "refused.log");
  const real = Bun.which("curl");

  if (real === null) {
    throw new Error("no curl on PATH — the loopback rail has nothing to pass through to");
  }

  // Only args that START with a scheme are inspected: a `--data-binary '{…}'` body is not a URL
  // and must never be read as one.
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

/**
 * Run a host script with an EXPLICIT env — never the ambient one. Two reasons, both
 * load-bearing: the ledger POST is a `curl` in a child process, so the repo's no-network rail
 * (which wraps `globalThis.fetch`) cannot see it, and an operator's real FLUNCLE_API_TOKEN
 * sitting in the environment is the one way this suite could reach production. The caller's PATH
 * is prefixed with the loopback rail above, which closes the other way in: a token the SCRIPT
 * itself materializes, which no amount of env hygiene here can withhold.
 */
async function runScript(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number; stderr: string; stdout: string }> {
  const rail = loopbackCurlRail();
  const merged = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...env };
  const proc = Bun.spawn(["bash", script, ...args], {
    // The rail goes on LAST and FIRST: after the spread so a fixture's own PATH cannot displace
    // it, and at the head of the list so its `curl` is the one every run finds.
    env: { ...merged, PATH: `${rail.dir}:${merged.PATH}` },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;

  if (existsSync(rail.refusals)) {
    throw new Error(
      `a run reached off-loopback — the fixture is missing its ledger base:\n${readFileSync(
        rail.refusals,
        "utf8",
      )}`,
    );
  }

  return { code, stderr, stdout };
}

/**
 * THE VERDICT, DERIVED — never read off the line.
 *
 * None of these three units prints `ok`, and that is the point: the rule is the WORKER's
 * (`exit_code === 0 && (errors ?? 0) === 0`) and a summary that grades itself is rejected at the
 * edge. So a test that wants to assert a run's health asserts it from the two facts the run
 * actually reports, which is exactly what the ledger will do with them.
 */
function derivedOk(exitCode: number, errors: Summary[string] | undefined): boolean {
  return exitCode === 0 && (errors ?? 0) === 0;
}

/** The LAST non-empty stdout line, parsed — the same line the wrapper sends as summary_raw. */
function lastJsonLine(stdout: string): Summary {
  const line = stdout
    .split("\n")
    .filter((entry) => entry.trim().length > 0)
    .at(-1);

  return JSON.parse(line ?? "{}") as Summary;
}

// ---------------------------------------------------------------------------
// timer-watchdog — the detector whose only honest health signal is `checked`.
// ---------------------------------------------------------------------------

type WatchdogFixture = {
  /** Services whose ActiveState is `active` (a oneshot mid-tick — never a suspect). */
  busy?: string[];
  /** Timers reporting NO next elapse — the stranded shape. */
  infinity?: string[];
  /** Services whose `systemctl start` fails. */
  startFails?: string[];
  /** Every active timer `systemctl list-units` reports. */
  timers: string[];
  /** Env pairs the live container exposes (the credential-free token read). */
  containerEnv?: Record<string, string>;
};

function watchdogStubs(root: string, fixture: WatchdogFixture): string {
  const bin = join(root, "bin");

  mkdirSync(bin, { recursive: true });
  // A systemctl that answers exactly the four questions the watchdog asks, from a fixture in
  // the environment. Anything else is a hard failure rather than a quiet zero.
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
  // `docker inspect --format '{{range .Config.Env}}…'` — the watchdog reads the agent token
  // and the Discord webhook off the LIVE container, so it holds no config file of its own.
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
  const bin = watchdogStubs(root, fixture);
  const run = await runScript(WATCHDOG, {
    // Empty, not absent, with no ledger fixture — see runSecretsSync below for what an absent
    // base costs. This unit is token-gated as well, so it is belt and braces here.
    FLUNCLE_API_BASE_URL: base ?? "",
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    // No re-check pause: the confirming sample is behavioural, not temporal.
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

  test("a clean pass counts what it examined", async () => {
    const { code, summary } = await runWatchdog({ timers: HEALTHY });

    expect(code).toBe(0);
    // An EXACT shape, so a stray key cannot creep in: the ledger rejects a summary carrying
    // `ok`, and `toMatchObject` would have let one ride along unnoticed.
    expect(summary).toEqual({
      checked: 3,
      errors: 0,
      expectedIntervalMs: 900_000,
      gateState: null,
      produced: 0,
      queue_depth: 0,
    });
    expect(derivedOk(code, summary.errors)).toBe(true);
  });

  // THE ONE THIS UNIT EXISTS FOR. A watchdog that enumerates nothing must fail locally rather
  // than rely on a future reader to notice the denominator. `produced:0` and `queue_depth:0`
  // otherwise look identical to the healthy run above.
  test("checked == 0 exits non-zero", async () => {
    const { code, summary } = await runWatchdog({ timers: [] });

    expect(code).toBe(1);
    expect(summary.checked).toBe(0);
    expect(summary.errors).toBe(1);
    expect(summary.produced).toBe(0);
    expect(summary.queue_depth).toBe(0);
    expect(derivedOk(code, summary.errors)).toBe(false);
  });

  test("a stranded timer shows up as backlog cleared, not as backlog hidden", async () => {
    const { code, summary } = await runWatchdog({
      infinity: ["fluncle-anchor.timer"],
      timers: [...HEALTHY, "fluncle-anchor.timer"],
    });

    expect(code).toBe(0);
    expect(summary).toMatchObject({ checked: 4, errors: 0, produced: 1, queue_depth: 1 });
    expect(derivedOk(code, summary.errors)).toBe(true);
  });

  // The ledger's alarm conjunction, from the real script: stranded timers found, none
  // re-armed. `produced == 0 AND queue_depth > 0` — and the derived verdict is false because
  // the errors are COUNTED.
  test("ALARM SHAPE: found stranded, re-armed none", async () => {
    const { code, summary } = await runWatchdog({
      infinity: ["fluncle-anchor.timer", "fluncle-rank.timer"],
      startFails: ["fluncle-anchor.service", "fluncle-rank.service"],
      timers: [...HEALTHY, "fluncle-anchor.timer", "fluncle-rank.timer"],
    });

    expect(code).toBe(1);
    expect(summary).toMatchObject({ checked: 5, errors: 2, produced: 0, queue_depth: 2 });
    expect(derivedOk(code, summary.errors)).toBe(false);
  });

  test("the alert attempt happens before the failed-rearm exit", () => {
    const body = readFileSync(WATCHDOG, "utf8");
    const alertAttempt = body.indexOf('webhook="$(container_env DISCORD_ALERT_WEBHOOK)"');
    const failedRearmExit = body.indexOf('[ "${#healed[@]}" -gt 0 ] || exit 1');

    // Assert both markers first so two missing lines cannot satisfy the ordering by accident.
    expect(alertAttempt).toBeGreaterThan(-1);
    expect(failedRearmExit).toBeGreaterThan(-1);
    expect(alertAttempt).toBeLessThan(failedRearmExit);
  });

  test("a busy oneshot is examined but never counted as stranded", async () => {
    const { summary } = await runWatchdog({
      busy: ["fluncle-anchor.service"],
      infinity: ["fluncle-anchor.timer"],
      timers: [...HEALTHY, "fluncle-anchor.timer"],
    });

    expect(summary).toMatchObject({ checked: 4, produced: 0, queue_depth: 0 });
  });

  test("posts the run record, with the token read off the live container", async () => {
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
  });

  test("no token on the container ⇒ no POST, and the pass is unaffected", async () => {
    const { calls, code } = await withLedger(async (base, calls) => {
      const run = await runWatchdog({ timers: HEALTHY }, base);

      return { calls, code: run.code };
    });

    expect(runEvents(calls)).toHaveLength(0);
    expect(code).toBe(0);
  });

  test("a permanently failing ledger POST leaves the sweep unharmed and the row absent", async () => {
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
  });
});

// ---------------------------------------------------------------------------
// secrets-sync — the unit every other sweep depends on, which reported nothing.
// ---------------------------------------------------------------------------

type SecretsFixture = {
  /** Agent token exposed by the container configuration this host unit inspects. */
  containerToken?: string;
  /** Fail the `op inject` of the sweep secrets (the real-world op outage). */
  injectFails?: boolean;
  /** Configure the optional GSC key, and whether `op read` for it succeeds. */
  gsc?: "ok" | "fails";
};

async function runSecretsSync(
  fixture: SecretsFixture,
  base?: string,
): Promise<{ code: number; root: string; stderr: string; stdout: string; summary: Summary }> {
  const root = mkdtempSync(join(tmpdir(), "fluncle-secrets-sync-"));
  const bin = join(root, "bin");
  const tpl = join(root, "tpl");
  const sweepOut = join(root, "state/home/.fluncle-secrets.env");

  mkdirSync(bin, { recursive: true });
  mkdirSync(tpl, { recursive: true });
  writeFileSync(join(tpl, "hermes.env.tpl"), "OPENROUTER_API_KEY={{op}}\n", "utf8");
  writeFileSync(join(tpl, "fluncle-secrets.env.tpl"), "CLAUDE_CODE_OAUTH_TOKEN={{op}}\n", "utf8");

  // An `op` that materializes exactly what the real one does: the gateway env, the sweep env
  // (which deliberately does NOT carry FLUNCLE_API_TOKEN), and the GSC service-account json.
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
      `  *) printf 'OPENROUTER_API_KEY=stub\\n' >"$out" ;;`,
      "esac",
    ].join("\n"),
  );

  // The host unit's credential-free source: `docker inspect` of the container configuration.
  // The stub ignores inspect's formatting arguments and emits the same KEY=value lines.
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
      // A PLACEHOLDER ref, never a concrete one (the CI working-tree grep rejects any
      // `op://` path starting with an alphanumeric — AGENTS.md "Public Repo"), and SINGLE
      // QUOTED because the script sources this file: an unquoted `<vault>` would be read as
      // a redirection. The stub `op` ignores the argument anyway.
      ...(fixture.gsc ? ["FLUNCLE_GSC_OP_REF='op://<vault>/<gsc-item>'"] : []),
    ].join("\n") + "\n",
    "utf8",
  );

  const run = await runScript(SECRETS_SYNC, {
    // EXPLICITLY EMPTY, never absent, when there is no ledger fixture. An ABSENT base is
    // documented to fall back to the box's production default; an empty one means THERE IS NO
    // LEDGER HERE and reaches the emitter's own guard, which is the line that says so.
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
  test("a clean sync writes both targets and says so", async () => {
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
    // The real work still happened — the summary is a report, not a replacement.
    expect(readFileSync(join(root, "hermes.env"), "utf8")).toContain("OPENROUTER_API_KEY");
    expect(readFileSync(join(root, "state/home/.fluncle-secrets.env"), "utf8")).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });

  test("posts with the token resolved from the container configuration", async () => {
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
  });

  // The container source is independent of the files this script rewrites, so an op outage is
  // still reportable even though no fresh sweep-secrets file exists.
  test("a failed op inject still reports with the container token", async () => {
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
    // Two targets promised, none written: the shortfall is the backlog, and the exit code the
    // posted carries is what the ledger derives a false verdict from.
    expect(summary).toMatchObject({ checked: 2, produced: 0, queue_depth: 2 });
    expect(derivedOk(posted.exit_code, summary.errors)).toBe(false);
  });

  test("a missing container token is visible but does not fail the credential refresh", async () => {
    const { calls, code, root, stderr, summary } = await withLedger(async (base, calls) => {
      const run = await runSecretsSync({}, base);

      return { calls, ...run };
    });

    expect(runEvents(calls)).toHaveLength(0);
    expect(code).toBe(0);
    expect(stderr).toContain("run-ledger receipt did not land (missing-token)");
    expect(summary).toMatchObject({ errors: 0, produced: 2, runLedgerReceipt: false });
    expect(readFileSync(join(root, "hermes.env"), "utf8")).toContain("OPENROUTER_API_KEY");
    expect(readFileSync(join(root, "state/home/.fluncle-secrets.env"), "utf8")).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });

  test("a failed POST is visible but does not fail the credential refresh", async () => {
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
    expect(readFileSync(join(root, "hermes.env"), "utf8")).toContain("OPENROUTER_API_KEY");
    expect(readFileSync(join(root, "state/home/.fluncle-secrets.env"), "utf8")).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });

  test("a missing bootstrap env reports the failure rather than dying quiet", async () => {
    const root = mkdtempSync(join(tmpdir(), "fluncle-secrets-nobootstrap-"));
    const run = await runScript(SECRETS_SYNC, {
      FLUNCLE_API_BASE_URL: "",
      HOME: root,
      PATH: "/usr/bin:/bin",
      SECRETS_SYNC_BOOTSTRAP: join(root, "does-not-exist.env"),
      SECRETS_SYNC_SWEEP_OUT: join(root, "state/home/.fluncle-secrets.env"),
    });
    const summary = lastJsonLine(run.stdout);

    expect(run.code).toBe(1);
    expect(summary).toMatchObject({ checked: 0, errors: 1, produced: 0 });
    expect(derivedOk(run.code, summary.errors)).toBe(false);
  });

  test("the optional GSC key counts as a target — success and failure both land", async () => {
    const clean = await runSecretsSync({ gsc: "ok" });

    expect(clean.code).toBe(0);
    expect(clean.summary).toMatchObject({ checked: 3, errors: 0, produced: 3 });
    expect(derivedOk(clean.code, clean.summary.errors)).toBe(true);

    // Exits 0 on purpose (the audit degrades), which is exactly why the error is COUNTED:
    // a green exit code beside a nonzero error count must not read green.
    const degraded = await runSecretsSync({ gsc: "fails" });

    expect(degraded.code).toBe(0);
    expect(degraded.summary).toMatchObject({
      checked: 3,
      errors: 1,
      produced: 2,
      queue_depth: 1,
    });
    // Exit code 0, one counted error — so the DERIVED verdict is false where a self-reported one
    // would have been true. This single line is the whole argument for deriving it.
    expect(derivedOk(degraded.code, degraded.summary.errors)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sonar-freshen — the self-deploy on the other box. Same problem as the watchdog: it
// legitimately deploys nothing for weeks, so only `checked` says whether it LOOKED.
// ---------------------------------------------------------------------------

type SonarFixture = {
  /** What the rolling release's `sonar.commit` asset answers, if anything. */
  commit?: string;
  /** The SHA already recorded on the box. */
  deployed?: string;
  /** Pretend another run holds the single-flight lock. */
  locked?: boolean;
  /** Point the asset base at a dead port. */
  unreachable?: boolean;
};

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** A stand-in `sonar` binary: boots on SONAR_PORT and serves the one thing the smoke reads. */
const SONAR_STUB = [
  "#!/usr/bin/env bash",
  'exec "$SONAR_TEST_BUN" -e "Bun.serve({fetch: () => new Response(String.raw\\`{\\"ok\\":true}\\`), port: Number(process.env.SONAR_PORT)}); await new Promise(() => {});"',
  "",
].join("\n");

async function runSonar(
  fixture: SonarFixture,
  base: string | undefined,
  args: string[] = [],
): Promise<{ code: number; stdout: string; summary: Summary }> {
  const root = mkdtempSync(join(tmpdir(), "fluncle-sonar-freshen-"));
  const bin = join(root, "bin");
  const appDir = join(root, "app");

  mkdirSync(bin, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  // `flock` is util-linux — it does not exist on macOS at all, so without this stub EVERY run
  // here would take the lock-held branch and quietly test nothing.
  writeStub(bin, "flock", '[ "${SF_LOCKED:-0}" = "1" ] && exit 1\nexit 0');
  // A systemctl that restarts nothing and reports the service up, so the swap path is real
  // right up to the boundary of the box.
  writeStub(bin, "systemctl", "exit 0");

  const digest = new Bun.CryptoHasher("sha256").update(SONAR_STUB).digest("hex");
  const server = Bun.serve({
    fetch(request) {
      const { pathname } = new URL(request.url);

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
  // The "already restarted" live service the post-swap smoke curls.
  const live = Bun.serve({ fetch: () => new Response('{"ok":true}'), port: 0 });
  const serviceEnv = join(root, "sonar.env");

  writeFileSync(
    serviceEnv,
    [
      "TURSO_DATABASE_URL=libsql://stub",
      "TURSO_AUTH_TOKEN=stub",
      "SONAR_SECRET=stub",
      `SONAR_PORT=${live.port}`,
    ].join("\n"),
    "utf8",
  );

  if (fixture.deployed) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state/deployed-sha"), `${fixture.deployed}\n`, "utf8");
  }

  const assetBase = fixture.unreachable
    ? "http://127.0.0.1:1"
    : `http://127.0.0.1:${server.port}/download`;

  try {
    const run = await runScript(
      SONAR_FRESHEN,
      {
        HOME: root,
        PATH: `${bin}:/usr/bin:/bin`,
        SF_LOCKED: fixture.locked ? "1" : "0",
        SONARFRESHEN_APP_DIR: appDir,
        SONARFRESHEN_ASSET_BASE: assetBase,
        SONARFRESHEN_BOOT_TIMEOUT_SECS: "25",
        SONARFRESHEN_LOCK: join(root, "lock"),
        SONARFRESHEN_SERVICE_ENV: serviceEnv,
        SONARFRESHEN_STATE_DIR: join(root, "state"),
        SONARFRESHEN_WORKER_URL: base ?? "http://127.0.0.1:1",
        SONAR_TEST_BUN: process.execPath,
        ...(base === undefined ? {} : { FLUNCLE_API_TOKEN: "sonar-agent-token" }),
      },
      args,
    );

    return { code: run.code, stdout: run.stdout, summary: lastJsonLine(run.stdout) };
  } finally {
    await server.stop(true);
    await live.stop(true);
  }
}

describe("sonar-freshen reports a run", () => {
  test("the common tick: checked, nothing to do, nothing done", async () => {
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
  });

  // A dead release feed exits 0 BY DESIGN (leave the box alone). Before this, that was
  // indistinguishable from a healthy no-op — which is the seven-days-invisible failure shape
  // in miniature. `checked:0` is what makes it legible, and the counted error is what stops
  // the row reading green.
  test("BLINDNESS: an unreachable release feed is `checked:0`, never a quiet success", async () => {
    const { code, summary } = await runSonar({ unreachable: true }, undefined);

    expect(code).toBe(0);
    expect(summary).toMatchObject({ checked: 0, errors: 1, queueDepth: 0 });
    expect(derivedOk(code, summary.errors)).toBe(false);
  });

  test("a malformed sonar.commit is the same shape — it resolved nothing", async () => {
    const { code, summary } = await runSonar({ commit: "<html>not a sha</html>" }, undefined);

    expect(code).toBe(0);
    expect(summary).toMatchObject({ checked: 0, errors: 1 });
    expect(derivedOk(code, summary.errors)).toBe(false);
  });

  // The third state. A lock-skipped tick measured NOTHING, so its counters are `null` rather
  // than `0` — `0` is reserved for "I tried and found nothing", and conflating the two would
  // make a wedged predecessor look like a healthy idle box forever.
  //
  // `locked` is the ledger's OWN word for precisely this tick, and it is one of the Worker's
  // never-looked gates — which is what makes the `null` counters correct rather than laundered.
  // A gate value of this script's invention is rejected by the Worker, and a rejected POST leaves
  // NO ROW: the same silent-empty-ledger failure as a wrong endpoint, one field further in.
  test("GATED: a lock-held tick reports null counters, not zeros", async () => {
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
  });

  test("a real deploy: downloaded, verified, pre-smoked, swapped, and COUNTED", async () => {
    const { calls, code, summary } = await withLedger(async (base, calls) => {
      const run = await runSonar({ commit: SHA_B, deployed: SHA_A }, base);

      return { calls, code: run.code, summary: run.summary };
    });

    expect(code).toBe(0);
    // NO gate on a real deploy, forced or not: the ledger nulls a gated run's work counters, so
    // gating this would erase the `produced:1` that proves the swap happened.
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

  // The ledger's alarm conjunction on this unit: a build is published, the box did not take
  // it. `--dry-run` produces the same counters on purpose, and carries a `gateState` so an
  // operator preview is never mistaken for a stalled deploy.
  //
  // AND THE WORD IS `dry-run`, NOT `paused` — the two are both legal and they are not
  // interchangeable. `paused` is one of the Worker's never-looked gates, so it would null the
  // `checked: 1` asserted here: the reading that proves this tick really read the release feed
  // before declining to deploy. That is the whole reason the ledger's vocabulary is six words.
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
