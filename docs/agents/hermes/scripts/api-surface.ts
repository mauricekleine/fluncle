// api-surface.ts — resolve an `/api/v1/…` path a BOX SCRIPT hardcodes against the surfaces the
// WORKSPACE actually declares. A build-time guard only; nothing here runs on a box.
//
// ── WHY THIS EXISTS (a shipped bug, not a hypothetical) ────────────────────────
// The run-ledger emitter is carried verbatim in four bash scripts, and a test compared those
// four copies BYTE FOR BYTE so a drift would fail the build. All four agreed on
// `/api/v1/admin/runs/events`. The contract declared `/admin/telemetry/runs`. Every POST 404'd,
// the `|| true` on the curl swallowed it, the ledger would have stayed permanently EMPTY — and
// both test suites were green, because each side only ever tested its own half.
//
// A byte-identical-mirror test is a CLOSED LOOP: it proves the copies agree with each other,
// which is worth exactly nothing when the thing they agree on is wrong. The assertion that was
// missing had to cross the boundary — resolve the literal the box sends against the surface the
// Worker serves. That is this module.
//
// ── WHY IT READS SOURCE TEXT RATHER THAN IMPORTING THE CONTRACT ────────────────
// This directory bakes into the Hermes image (`/opt/hermes-scripts`) with no workspace packages
// beside it, so nothing here may `import "@fluncle/contracts"`. Reading the committed source is
// also the posture install-host-timers.test.ts already uses over the unit files: the artifact on
// disk is the truth, and a regex over it cannot drift from what ships.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────
// It does not check METHODS, auth tiers, or body shapes. Those already have owners on the
// workspace side (`orpc-coverage`, `orpc-admin-coverage`, `orpc-auth-coverage`). This closes the
// one gap none of them can see: a path that exists only in bash.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Repo root, from this file's location (docs/agents/hermes/scripts). */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Where the Worker's oRPC handler declares the one prefix every op path hangs off. */
const ORPC_MODULE = join(REPO_ROOT, "apps/web/src/lib/server/orpc.ts");
/** The contract package's op modules — the declared path of every oRPC surface. */
const CONTRACT_DIR = join(REPO_ROOT, "packages/contracts/src/orpc");
/** The file-route carve-outs (feeds, OAuth redirects, uploads, non-JSON emitters). */
const FILE_ROUTE_DIR = join(REPO_ROOT, "apps/web/src/routes/api");

/**
 * The mounted API prefix, READ from the Worker rather than repeated here. Repeating it would
 * rebuild the closed loop this module exists to break.
 */
export function apiPrefix(): string {
  const match = /const API_PREFIX = "([^"]+)"/.exec(readFileSync(ORPC_MODULE, "utf8"));

  if (!match?.[1]) {
    throw new Error(`could not read API_PREFIX out of ${ORPC_MODULE}`);
  }

  return match[1];
}

/**
 * THE RUN-LEDGER ENDPOINT, in one place for both suites.
 *
 * It is the full URL path the four mirrored bash copies POST to, and it is asserted against the
 * workspace by `runLedgerContractPaths()` below — so this constant is a convenience for the
 * fixtures, never the authority. cron-output.test.ts and run-events.test.ts both read it, so the
 * two suites cannot pin different paths and each look right on its own.
 */
export const RUN_EVENT_ENDPOINT = "/api/v1/admin/telemetry/runs";

/**
 * Paths a box script sends that the workspace does not declare YET, each because its server half
 * is landing in a sibling pull request. An entry means "the absence is known and dated", never
 * "stop checking": the moment the workspace declares the path, `resolveApiPath` resolves it
 * normally and the entry stops doing anything.
 *
 * KEEP THIS AT ZERO OR ONE ENTRIES. It is the one hand-kept thing in this file, so every entry
 * carries the PR that closes it and gets deleted with that merge.
 */
export const PENDING_WORKSPACE_PATHS = new Map<string, string>([
  // `record_run` — the agent-tier op that writes `run_events` in the `fluncle-telemetry`
  // database. Declared by packages/contracts/src/orpc/admin-telemetry.ts in PR #1006 (the
  // server half of the same run-ledger slice as the four bash emitters). Once that is on main
  // `runLedgerContractPaths()` below asserts the bash constant against it directly, and this
  // entry can go.
  [RUN_EVENT_ENDPOINT, "PR #1006 — the record_run contract (admin-telemetry.ts)"],
]);

/**
 * The ledger's CLOSED gate vocabulary, as the box scripts must speak it.
 *
 * Kept here because a box script cannot import the Worker, and cross-checked against the Worker
 * by `workspaceGateStates()` below — the same bargain as the endpoint path. A gate word of a
 * script's own invention is rejected at the edge, and a rejected POST leaves NO ROW: the
 * silent-empty-ledger failure again, one field further in.
 *
 * SIX WORDS, and the three beyond `active`/`disabled`/`paused` are not decoration — they are
 * the difference between a suppressed counter and a kept one. The Worker nulls a gated run's
 * work counters only for the gates that NEVER LOOKED (`disabled`/`locked`/`paused`); `forced`
 * and `dry-run` both LOOKED, so their `checked` survives. Spelling a `--dry-run` tick `paused`
 * therefore erases the very reading that makes it legible.
 */
export const LEDGER_GATE_STATES = [
  "active",
  "disabled",
  "dry-run",
  "forced",
  "locked",
  "paused",
] as const;

/** The Worker module that owns the ledger's gate vocabulary. */
const RUN_EVENTS_MODULE = join(REPO_ROOT, "apps/web/src/lib/server/run-events.ts");

/** One `new Set<string>([…])` literal out of the Worker, sorted, or `null` when it is not here. */
function workspaceStringSet(name: string): null | string[] {
  if (!existsSync(RUN_EVENTS_MODULE)) {
    return null;
  }

  const match = new RegExp(`const ${name} = new Set<string>\\(\\[([^\\]]*)\\]\\)`).exec(
    readFileSync(RUN_EVENTS_MODULE, "utf8"),
  );

  if (!match?.[1]) {
    throw new Error(`run-events.ts exists but declares no ${name} set — ${RUN_EVENTS_MODULE}`);
  }

  return [...match[1].matchAll(/"([^"]+)"/g)].map(([, state]) => state ?? "").sort();
}

/** The Worker's own `GATE_STATES`, or `null` when the run-ledger server half is not here yet. */
export function workspaceGateStates(): null | string[] {
  return workspaceStringSet("GATE_STATES");
}

/**
 * The Worker's `GATE_STATES_THAT_NEVER_LOOKED` — the subset whose work counters it suppresses to
 * NULL — or `null` when the server half is not here yet.
 *
 * Membership in `GATE_STATES` is not the whole contract. Every one of the six words is accepted,
 * so a script that gates a tick with the WRONG legal word passes every path/vocabulary check and
 * still has its `checked` erased at the edge. This is the half of the Worker's rule that says
 * which word costs a reading, read from the Worker rather than re-derived here.
 */
export function workspaceNeverLookedGateStates(): null | string[] {
  return workspaceStringSet("GATE_STATES_THAT_NEVER_LOOKED");
}

/** Every `gateState` string literal the three host emitters can put on the wire. */
export function emittedGateStates(scripts: string[]): string[] {
  const found = new Set<string>();

  for (const script of scripts) {
    for (const line of readFileSync(script, "utf8").split("\n")) {
      if (/^\s*#/.test(line)) {
        continue;
      }

      for (const match of line.matchAll(/^\s*\w*GATE\w*='"([^"]+)"'/g)) {
        if (match[1]) {
          found.add(match[1]);
        }
      }
    }
  }

  return [...found].sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }

  return out;
}

const isSource = (file: string): boolean => file.endsWith(".ts") && !file.endsWith(".test.ts");

/**
 * Every oRPC op path the contract package declares, mapped to the module that declares it. The
 * `path:` key inside a `.route({ … })` call is the whole surface — one regex over the committed
 * source, no TypeScript evaluation, so a box-side test needs no workspace build.
 */
export function contractOpPaths(): Map<string, string> {
  const paths = new Map<string, string>();

  for (const file of readdirSync(CONTRACT_DIR)) {
    if (!isSource(file)) {
      continue;
    }

    const body = readFileSync(join(CONTRACT_DIR, file), "utf8");

    for (const match of body.matchAll(/^\s*path: "([^"]+)",$/gm)) {
      if (match[1]) {
        paths.set(match[1], file);
      }
    }
  }

  if (paths.size === 0) {
    throw new Error(`no oRPC op paths found under ${CONTRACT_DIR} — the resolver is broken`);
  }

  return paths;
}

/**
 * The declared paths of the ONE contract module that owns the run ledger, or an empty set when
 * that module is not on this branch yet. Located by FILE, not by the path we are checking — a
 * check that looked itself up by the value under test would prove nothing.
 */
export function runLedgerContractPaths(): Set<string> {
  const prefix = apiPrefix();
  const declared = new Set<string>();

  for (const [path, file] of contractOpPaths()) {
    if (file === "admin-telemetry.ts") {
      declared.add(`${prefix}${path}`);
    }
  }

  return declared;
}

/**
 * Every `/api/v1/…` path served by a TanStack file route — the documented carve-outs (auth
 * redirects, uploads, feeds, `/status`). Derived from the filenames, with TanStack's `.` and `/`
 * both reading as separators.
 */
export function fileRoutePaths(): Set<string> {
  const paths = new Set<string>();

  for (const full of walk(FILE_ROUTE_DIR)) {
    if (!isSource(full)) {
      continue;
    }

    const segments = full
      .slice(FILE_ROUTE_DIR.length + 1)
      .replace(/\.ts$/, "")
      .split("/")
      .flatMap((segment) => segment.split("."));

    paths.add(`/api/${segments.join("/")}`);
  }

  return paths;
}

/** How a literal resolved — and, when it did, what declares it. */
export type ResolvedApiPath =
  | { kind: "contract"; source: string }
  | { kind: "file-route"; source: string }
  | { kind: "pending"; source: string }
  | { kind: "unresolved"; source: null };

/**
 * `/api/v1/health` is answered inside the oRPC handler itself (`HEALTH_SUFFIX` in orpc.ts)
 * rather than by a contract op or a file route, so it is resolved from that constant.
 */
function handlerServedPaths(): Set<string> {
  const body = readFileSync(ORPC_MODULE, "utf8");
  const match = /const HEALTH_SUFFIX = "([^"]+)"/.exec(body);

  return new Set(match?.[1] ? [`${apiPrefix()}${match[1]}`] : []);
}

/** Resolve one full path literal (`/api/v1/admin/health`) against the workspace. */
export function resolveApiPath(literal: string): ResolvedApiPath {
  const prefix = apiPrefix();
  const suffix = literal.startsWith(prefix) ? literal.slice(prefix.length) : null;
  const contract = suffix === null ? undefined : contractOpPaths().get(suffix);

  if (contract !== undefined) {
    return { kind: "contract", source: `packages/contracts/src/orpc/${contract}` };
  }

  if (fileRoutePaths().has(literal)) {
    return { kind: "file-route", source: "apps/web/src/routes/api" };
  }

  if (handlerServedPaths().has(literal)) {
    return { kind: "file-route", source: "apps/web/src/lib/server/orpc.ts (HEALTH_SUFFIX)" };
  }

  const pending = PENDING_WORKSPACE_PATHS.get(literal);

  return pending === undefined
    ? { kind: "unresolved", source: null }
    : { kind: "pending", source: pending };
}

/** One hardcoded API path found in a box script. */
export type BoxScriptApiPath = { file: string; line: number; literal: string };

/**
 * The shell scripts that talk to the Worker: rave-02's sweeps + host units, and rave-01's
 * self-deploys and watchdog. `packages/skills/**` is deliberately out — those are operator
 * runbook helpers a human drives, not units a timer fires.
 */
const SCRIPT_ROOTS = [
  "docs/agents/hermes",
  "apps/sonar/deploy",
  "apps/ssh/deploy",
  "apps/ssh/watchdog",
];

/**
 * Every `/api/v1/…` literal a box script would actually PUT ON THE WIRE.
 *
 * Comment lines are skipped on purpose: prose legitimately names a path loosely (`… posts to
 * /api/v1/status.` carries a sentence's full stop), and a wrong path in a comment misleads a
 * reader without breaking a run. Only executable lines are held to the contract.
 */
export function boxScriptApiPaths(): BoxScriptApiPath[] {
  const found: BoxScriptApiPath[] = [];

  for (const root of SCRIPT_ROOTS) {
    for (const full of walk(join(REPO_ROOT, root))) {
      if (!full.endsWith(".sh")) {
        continue;
      }

      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/^\s*#/.test(line)) {
            return;
          }

          for (const match of line.matchAll(/\/api\/v1[A-Za-z0-9/_-]*/g)) {
            found.push({
              file: full.slice(REPO_ROOT.length + 1),
              line: index + 1,
              literal: match[0],
            });
          }
        });
    }
  }

  return found;
}
