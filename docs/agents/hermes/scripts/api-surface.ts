import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const ORPC_MODULE = join(REPO_ROOT, "apps/web/src/lib/server/orpc.ts");

const CONTRACT_DIR = join(REPO_ROOT, "packages/contracts/src/orpc");

const FILE_ROUTE_DIR = join(REPO_ROOT, "apps/web/src/routes/api");

export function apiPrefix(): string {
  const match = /const API_PREFIX = "([^"]+)"/.exec(readFileSync(ORPC_MODULE, "utf8"));

  if (!match?.[1]) {
    throw new Error(`could not read API_PREFIX out of ${ORPC_MODULE}`);
  }

  return match[1];
}

export const RUN_EVENT_ENDPOINT = "/api/v1/admin/telemetry/runs";

export const PENDING_WORKSPACE_PATHS = new Map<string, string>([
  [RUN_EVENT_ENDPOINT, "PR #1006 — the record_run contract (admin-telemetry.ts)"],
]);

export const LEDGER_GATE_STATES = [
  "active",
  "admission-skipped",
  "disabled",
  "dry-run",
  "forced",
  "locked",
  "paused",
] as const;

const RUN_EVENTS_MODULE = join(REPO_ROOT, "apps/web/src/lib/server/run-events.ts");

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

export function workspaceGateStates(): null | string[] {
  return workspaceStringSet("GATE_STATES");
}

export function workspaceNeverLookedGateStates(): null | string[] {
  return workspaceStringSet("GATE_STATES_THAT_NEVER_LOOKED");
}

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

export type ResolvedApiPath =
  | { kind: "contract"; source: string }
  | { kind: "file-route"; source: string }
  | { kind: "pending"; source: string }
  | { kind: "unresolved"; source: null };

function handlerServedPaths(): Set<string> {
  const body = readFileSync(ORPC_MODULE, "utf8");
  const match = /const HEALTH_SUFFIX = "([^"]+)"/.exec(body);

  return new Set(match?.[1] ? [`${apiPrefix()}${match[1]}`] : []);
}

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

export type BoxScriptApiPath = { file: string; line: number; literal: string };

const SCRIPT_ROOTS = [
  "docs/agents/hermes",
  "apps/sonar/deploy",
  "apps/ssh/deploy",
  "apps/ssh/watchdog",
];

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
