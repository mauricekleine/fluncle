import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createProgram } from "../../../../cli/src/cli";
import { type Argument, type ArrayExpression, parseSync, Visitor } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { DATABASE_OPERATION_ID_MAX_LENGTH, isDatabaseOperationId } from "./database-observability";
import {
  DATABASE_OPERATION_REGISTRY,
  INCIDENT_MUTATION_POLICIES,
  type OperationCadence,
  resolveDatabaseOperationOwner,
  TRIGGER_MUTATION_POLICY_IDS,
  WRITE_MUTATION_POLICIES,
} from "./database-operation-registry";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const HERMES_ROOT = join(REPO_ROOT, "docs/agents/hermes");
const RECURRING_ROOTS = [
  HERMES_ROOT,
  join(REPO_ROOT, "apps/sonar/deploy"),
  join(REPO_ROOT, "apps/ssh/deploy"),
  join(REPO_ROOT, "apps/ssh/watchdog"),
];
const SCRIPTS = "docs/agents/hermes/scripts";
const EXPECTED_WRITE_OPERATION_IDS = [
  "analytics.funnel-snapshot",
  "artist.resolve",
  "backfill.artist-credits",
  "backfill.artist-edges",
  "backfill.cover-masters",
  "backfill.label-images",
  "backfill.label-lineage",
  "backfill.recording-mbids",
  "backfill.vendor-sweep",
  "bio.album",
  "bio.artist",
  "bio.label",
  "catalogue.anchor",
  "catalogue.crawl",
  "catalogue.demand",
  "catalogue.isrc-recovery",
  "catalogue.label-releases",
  "catalogue.rank",
  "catalogue.reconcile-hub-counts",
  "catalogue.verify-captures",
  "clips.studio",
  "device.mirror",
  "frontier.refresh",
  "galaxies.cluster",
  "health.snapshot",
  "live.snapshot",
  "logbook.draft",
  "newsletter.draft",
  "ops.pin-watch",
  "ops.rave-watchdog",
  "ops.sonar-freshen",
  "ops.ssh-freshen",
  "reach.collect",
  "social.capture",
  "social.metrics",
  "social.publish-advance",
  "submissions.triage",
  "track.capture",
  "track.context",
  "track.embed",
  "track.enrich",
  "track.note",
  "track.observe",
] as const;
const EXPECTED_INCIDENT_FUNCTION_NAMES = [
  "fillEmptyAlbumBio",
  "listDeezerWork",
  "markResolved",
  "rearmStaleAllowedArtists",
  "stripCrawlerPrefixes",
] as const;
const EXPECTED_RECEIPT_BACKED_OPERATION_IDS = ["health.snapshot"] as const;
const EXPECTED_DELIBERATELY_NON_REPLAYABLE_OPERATION_IDS = [
  "clips.studio",
  "frontier.refresh",
  "ops.pin-watch",
  "ops.rave-watchdog",
  "ops.sonar-freshen",
  "ops.ssh-freshen",
  "track.capture",
  "track.embed",
  "track.enrich",
  "track.observe",
] as const;
const EXPECTED_MUTATION_DISPOSITION_KINDS = new Set([
  "deliberately-non-replayable",
  "not-applicable",
  "receipt-backed",
  "replay-safe-idempotent",
]);

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function resolveNamedImportSource(importerSource: string, importedName: string): string {
  const importerPath = join(REPO_ROOT, importerSource);
  const importer = readFileSync(importerPath, "utf8");
  const namedImport = new RegExp(
    `import\\s*\\{[^}]*\\b${importedName}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`,
    "s",
  ).exec(importer);
  const specifier = namedImport?.[1];

  if (!specifier?.startsWith(".")) {
    throw new Error(`${importerSource} does not import ${importedName} from a local module`);
  }

  const sourcePath = resolve(dirname(importerPath), `${specifier}.ts`);
  return relative(REPO_ROOT, sourcePath).replaceAll("\\", "/");
}

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);

    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function unitValue(contents: string, key: string): string | undefined {
  const line = contents.split("\n").find((candidate) => candidate.startsWith(`${key}=`));

  return line?.slice(key.length + 1);
}

function timerCadence(contents: string): OperationCadence {
  const onBootSec = unitValue(contents, "OnBootSec");
  const onCalendar = unitValue(contents, "OnCalendar");
  const onUnitActiveSec = unitValue(contents, "OnUnitActiveSec");
  const persistent = unitValue(contents, "Persistent") === "true";
  const randomizedDelaySec = unitValue(contents, "RandomizedDelaySec");

  return {
    ...(onBootSec ? { onBootSec } : {}),
    ...(onCalendar ? { onCalendar } : {}),
    ...(onUnitActiveSec ? { onUnitActiveSec } : {}),
    persistent,
    ...(randomizedDelaySec ? { randomizedDelaySec } : {}),
  };
}

function cliRouteExists(route: readonly string[]): boolean {
  let commands = createProgram().commands;

  for (const token of route) {
    const command = commands.find((candidate) => candidate.name() === token);

    if (!command) {
      return false;
    }

    commands = command.commands;
  }

  return true;
}

function workerPathExists(path: string): boolean {
  const orpcModule = readFileSync(join(REPO_ROOT, "apps/web/src/lib/server/orpc.ts"), "utf8");
  const prefix = /const API_PREFIX = "([^"]+)"/.exec(orpcModule)?.[1];

  if (!prefix || !path.startsWith(prefix)) {
    return false;
  }

  const suffix = path.slice(prefix.length);
  const contractSources = filesBelow(join(REPO_ROOT, "packages/contracts/src/orpc")).filter(
    (source) => source.endsWith(".ts") && !source.endsWith(".test.ts"),
  );
  const contractPaths = contractSources.flatMap((source) =>
    [...readFileSync(source, "utf8").matchAll(/^\s*path: "([^"]+)",$/gm)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    ),
  );

  if (contractPaths.includes(suffix)) {
    return true;
  }

  if (path === `${prefix}/health`) {
    return /const HEALTH_SUFFIX = "\/health"/.test(orpcModule);
  }

  const routeRoot = join(REPO_ROOT, "apps/web/src/routes/api");
  const fileRoutePaths = filesBelow(routeRoot)
    .filter((source) => source.endsWith(".ts") && !source.endsWith(".test.ts"))
    .map(
      (source) =>
        `/api/${relative(routeRoot, source)
          .replace(/\.ts$/, "")
          .split("/")
          .flatMap((segment) => segment.split("."))
          .join("/")}`,
    );

  return fileRoutePaths.includes(path);
}

type DiscoveredCliCall = Readonly<{
  route: readonly string[];
  source: string;
}>;

function discoverTypescriptCliCalls(source: string): {
  calls: DiscoveredCliCall[];
  unresolved: number;
} {
  const path = join(REPO_ROOT, source);
  const body = readFileSync(path, "utf8");
  const parsed = parseSync(path, body, { lang: "ts" });
  const arrays = new Map<string, ArrayExpression>();
  const calls: DiscoveredCliCall[] = [];
  let unresolved = 0;

  function arrayFor(expression: Argument | undefined): ArrayExpression | undefined {
    if (expression?.type === "ArrayExpression") {
      return expression;
    }

    return expression?.type === "Identifier" ? arrays.get(expression.name) : undefined;
  }

  function routePrefix(expression: Argument | undefined): string[] {
    const array = arrayFor(expression);

    if (!array) {
      return [];
    }

    const route: string[] = [];

    for (const element of array.elements) {
      if (
        element?.type !== "Literal" ||
        typeof element.value !== "string" ||
        element.value.startsWith("--")
      ) {
        break;
      }

      route.push(element.value);
    }

    return route;
  }

  new Visitor({
    CallExpression(node) {
      if (node.callee.type !== "Identifier") {
        return;
      }

      const name = node.callee.name;
      const expression =
        name === "fluncleJson" ? node.arguments[0] : name === "run" ? node.arguments[1] : undefined;

      if (!expression) {
        return;
      }

      const route = routePrefix(expression);

      if (route[0] === "admin" || route[0] === "tracks") {
        if (route.length >= 2) {
          calls.push({ route, source });
        } else {
          unresolved += 1;
        }
      } else if (name === "fluncleJson") {
        unresolved += 1;
      }
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init?.type === "ArrayExpression") {
        arrays.set(node.id.name, node.init);
      }
    },
  }).visit(parsed.program);

  return { calls, unresolved };
}

function discoverShellCliCalls(source: string): DiscoveredCliCall[] {
  const body = readFileSync(join(REPO_ROOT, source), "utf8");

  return [
    ...body.matchAll(/"?\$FLUNCLE_BIN"?\s+((?:admin|tracks)(?:\s+[a-z0-9-]+){1,2})/g),
  ].flatMap((match) => (match[1] ? [{ route: match[1].split(/\s+/), source }] : []));
}

function reachableTimerSources(): string[] {
  const localScripts = RECURRING_ROOTS.flatMap(filesBelow)
    .filter(
      (path) =>
        /\.(?:py|sh|ts)$/.test(path) &&
        !path.endsWith(".test.ts") &&
        !path.includes("/audit/prompts/"),
    )
    .map((path) => relative(REPO_ROOT, path));
  const scriptsByBasename = new Map<string, string[]>();

  for (const source of localScripts) {
    const name = basename(source);
    scriptsByBasename.set(name, [...(scriptsByBasename.get(name) ?? []), source]);
  }

  const reachable = new Set(
    DATABASE_OPERATION_REGISTRY.map((operation) => operation.wrapperSource),
  );
  const queue = [...reachable];

  while (queue.length > 0) {
    const source = queue.shift();

    if (!source) {
      continue;
    }

    const executable = readFileSync(join(REPO_ROOT, source), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    for (const match of executable.matchAll(/([a-z0-9][a-z0-9-]*\.(?:py|sh|ts))/g)) {
      const name = match[1];

      if (!name) {
        continue;
      }

      for (const delegate of scriptsByBasename.get(name) ?? []) {
        if (!reachable.has(delegate)) {
          reachable.add(delegate);
          queue.push(delegate);
        }
      }
    }
  }

  return [...reachable].sort();
}

function allMutationDispositions() {
  return DATABASE_OPERATION_REGISTRY.flatMap((operation) => [
    operation.mutationDisposition,
    ...operation.triggers.map((trigger) => trigger.mutationDisposition),
    ...operation.incidents.map((incident) => incident.mutationDisposition),
  ]);
}

describe("database operation registry", () => {
  it("covers every committed recurring timer and pins its exact cadence", () => {
    const timerSources = RECURRING_ROOTS.flatMap(filesBelow)
      .filter((path) => path.endsWith(".timer"))
      .map((path) => relative(REPO_ROOT, path))
      .sort();
    const registered = DATABASE_OPERATION_REGISTRY.map((operation) => operation.timerSource).sort();

    expect(registered).toEqual(timerSources);
    expect(new Set(registered).size).toBe(registered.length);

    for (const operation of DATABASE_OPERATION_REGISTRY) {
      const timer = readFileSync(join(REPO_ROOT, operation.timerSource), "utf8");
      expect(operation.cadence, operation.owner.timer).toEqual(timerCadence(timer));
      expect(basename(operation.timerSource), operation.operationId).toBe(operation.owner.timer);
    }
  });

  it("resolves every timer through its service and checked-in wrapper", () => {
    for (const operation of DATABASE_OPERATION_REGISTRY) {
      expect(existsSync(join(REPO_ROOT, operation.serviceSource)), operation.serviceSource).toBe(
        true,
      );
      expect(existsSync(join(REPO_ROOT, operation.wrapperSource)), operation.wrapperSource).toBe(
        true,
      );

      const service = readFileSync(join(REPO_ROOT, operation.serviceSource), "utf8");
      const execStart = unitValue(service, "ExecStart") ?? "";
      expect(execStart, operation.owner.service).toContain(basename(operation.wrapperSource));
      expect(basename(operation.serviceSource), operation.operationId).toBe(
        operation.owner.service,
      );

      for (const trigger of operation.triggers) {
        expect(existsSync(join(REPO_ROOT, trigger.source)), trigger.source).toBe(true);
      }

      for (const incident of operation.incidents) {
        expect(existsSync(join(REPO_ROOT, incident.source)), incident.source).toBe(true);
      }
    }
  });

  it("keeps run and step IDs bounded, stable, public-safe, and resolvable by unit", () => {
    const runIds = DATABASE_OPERATION_REGISTRY.map((operation) => operation.operationId);
    expect(new Set(runIds).size).toBe(runIds.length);

    for (const operation of DATABASE_OPERATION_REGISTRY) {
      expect(isDatabaseOperationId(operation.operationId), operation.operationId).toBe(true);
      expect(operation.operationId.length).toBeLessThanOrEqual(DATABASE_OPERATION_ID_MAX_LENGTH);

      for (const trigger of operation.triggers) {
        expect(isDatabaseOperationId(trigger.operationId), trigger.operationId).toBe(true);
      }

      const expected = {
        accessClass: operation.accessClass,
        heavy: operation.heavy,
        operationId: operation.operationId,
      };

      expect(resolveDatabaseOperationOwner(operation.owner.timer)).toEqual(expected);
      expect(resolveDatabaseOperationOwner(operation.owner.service)).toEqual(expected);
      expect(resolveDatabaseOperationOwner(operation.owner.telemetryUnit)).toEqual(expected);
    }

    expect(resolveDatabaseOperationOwner("new-unregistered-timer")).toBeUndefined();
    expect(resolveDatabaseOperationOwner("../../unsafe")).toBeUndefined();
  });

  it("resolves every registered CLI route against the real Commander tree", () => {
    const cliTriggers = DATABASE_OPERATION_REGISTRY.flatMap(
      (operation) => operation.triggers,
    ).filter((trigger) => trigger.kind === "cli");

    expect(cliTriggers.length).toBeGreaterThan(0);

    for (const trigger of cliTriggers) {
      expect(trigger.cliRoute, trigger.operationId).toBeDefined();
      expect(cliRouteExists(trigger.cliRoute ?? []), trigger.target).toBe(true);
    }
  });

  it("parses recurring wrappers so a new CLI call cannot bypass the registry", () => {
    const cliTriggers = DATABASE_OPERATION_REGISTRY.flatMap(
      (operation) => operation.triggers,
    ).filter((trigger) => trigger.kind === "cli");
    const sources = reachableTimerSources();
    const discovered: DiscoveredCliCall[] = [];
    const unresolvedBySource = new Map<string, number>();

    for (const trigger of DATABASE_OPERATION_REGISTRY.flatMap((operation) => operation.triggers)) {
      expect(sources, `${trigger.operationId}: ${trigger.source}`).toContain(trigger.source);
    }

    for (const source of sources) {
      if (source.endsWith(".ts")) {
        const result = discoverTypescriptCliCalls(source);
        discovered.push(...result.calls);

        if (result.unresolved > 0) {
          unresolvedBySource.set(source, result.unresolved);
        }
      } else if (source.endsWith(".sh")) {
        discovered.push(...discoverShellCliCalls(source));
      }
    }

    expect(Object.fromEntries(unresolvedBySource)).toEqual({
      [`${SCRIPTS}/entity-bio-sweep.ts`]: 3,
    });

    for (const call of discovered) {
      const registered = cliTriggers.some(
        (trigger) =>
          trigger.source === call.source &&
          call.route.every((token, index) => trigger.cliRoute?.[index] === token),
      );
      expect(registered, `${call.source}: fluncle ${call.route.join(" ")}`).toBe(true);
    }
  });

  it("resolves every direct Worker trigger against the checked-in HTTP surface", () => {
    const endpointTriggers = DATABASE_OPERATION_REGISTRY.flatMap(
      (operation) => operation.triggers,
    ).filter((trigger) => trigger.kind === "worker-endpoint");

    for (const trigger of endpointTriggers) {
      const path = trigger.target.split(" ")[1] ?? "";
      expect(workerPathExists(path), trigger.target).toBe(true);
    }
  });

  it("classifies every recurring raw health writer and its receipt metadata", () => {
    const rawCallers = RECURRING_ROOTS.flatMap(filesBelow)
      .filter((path) => /\.(?:sh|ts)$/.test(path) && !path.endsWith(".test.ts"))
      .filter((path) => {
        const body = readFileSync(path, "utf8");
        const withoutBlockComments = path.endsWith(".ts")
          ? body.replace(/\/\*[\s\S]*?\*\//g, "")
          : body;
        return withoutBlockComments
          .split("\n")
          .filter((line) => !/^\s*(?:#|\/\/)/.test(line))
          .join("\n")
          .includes("/api/v1/admin/health");
      })
      .map((path) => relative(REPO_ROOT, path))
      .sort();
    const registered = DATABASE_OPERATION_REGISTRY.flatMap((operation) => operation.triggers)
      .filter(
        (trigger) =>
          trigger.kind === "worker-endpoint" && trigger.target === "POST /api/v1/admin/health",
      )
      .map((trigger) => trigger.source)
      .sort();

    expect(registered).toEqual(rawCallers);
    expect(new Set(registered).size).toBe(registered.length);

    for (const source of rawCallers) {
      const body = readFileSync(join(REPO_ROOT, source), "utf8");
      expect(body, source).toContain("operationKey");
      expect(body, source).toContain("producer");
      expect(body, source).toContain("requestDigest");

      if (source.endsWith(".sh")) {
        expect(body, source).toContain('{"at":"%s","checks":[{"latencyMs":');
        expect(body, source).toContain('}],"producer":"%s"}');
        expect(body, source).toContain('key="health.snapshot:${producer}:${at}"');
        expect(body, source).toContain("sha256sum");
        expect(body, source).toContain("shasum -a 256");
      } else {
        expect(body, source).toContain("healthSnapshotReceiptMetadata");
        expect(body, source).toContain("crypto.subtle.digest");
      }
    }
  });

  it("makes the six direct Worker database timers explicit", () => {
    const expected = [
      "catalogue.anchor",
      "catalogue.label-releases",
      "catalogue.verify-captures",
      "social.capture",
      "social.publish-advance",
      "track.capture",
    ];
    const direct = DATABASE_OPERATION_REGISTRY.filter((operation) =>
      expected.includes(operation.operationId),
    );

    expect(direct.map((operation) => operation.operationId).sort()).toEqual(expected.sort());

    for (const operation of direct) {
      expect(operation.accessClass).toBe("write");
      expect(operation.mutationDisposition.kind).toBe(
        operation.operationId === "track.capture"
          ? "deliberately-non-replayable"
          : "replay-safe-idempotent",
      );
      expect(operation.triggers.some((trigger) => trigger.kind === "worker-endpoint")).toBe(true);
    }
  });

  it("names all five audited incident functions and assigns their disposition", () => {
    const incidents = DATABASE_OPERATION_REGISTRY.flatMap((operation) => operation.incidents);

    expect(sorted(incidents.map((incident) => incident.functionName))).toEqual(
      sorted(EXPECTED_INCIDENT_FUNCTION_NAMES),
    );

    for (const incident of incidents) {
      const owner = DATABASE_OPERATION_REGISTRY.find((operation) =>
        operation.triggers.some((trigger) => trigger.operationId === incident.operationId),
      );
      const source = readFileSync(join(REPO_ROOT, incident.source), "utf8");
      expect(owner, incident.functionName).toBeDefined();
      expect(owner?.mutationDisposition.kind, incident.functionName).toBe("replay-safe-idempotent");
      expect(incident.mutationDisposition.kind, incident.functionName).toBe(
        "replay-safe-idempotent",
      );
      expect(incident.mutationDisposition.evidenceSource, incident.functionName).toBe(
        incident.source,
      );
      expect(new RegExp(`\\b${incident.functionName}\\b`).test(source), incident.source).toBe(true);
    }
  });

  it("binds reach.collect evidence to the mutation module called by its write handler", () => {
    const handlerSource = "apps/web/src/lib/server/orpc/admin-reach.ts";
    const handler = readFileSync(join(REPO_ROOT, handlerSource), "utf8");
    const mutationSource = resolveNamedImportSource(handlerSource, "recordPlatformStats");
    const policy = WRITE_MUTATION_POLICIES["reach.collect"];

    expect(handler).toMatch(/await recordPlatformStats\(\)/);
    expect(policy.evidenceSource).toBe(mutationSource);
    expect(policy.kind).toBe("replay-safe-idempotent");
  });

  it("machine-checks complete mutation disposition coverage", () => {
    const writeOperations = DATABASE_OPERATION_REGISTRY.filter(
      (operation) => operation.accessClass === "write",
    );
    const writeTriggers = DATABASE_OPERATION_REGISTRY.flatMap(
      (operation) => operation.triggers,
    ).filter((trigger) => trigger.accessClass === "write");
    const receiptBacked = writeOperations
      .filter((operation) => operation.mutationDisposition.kind === "receipt-backed")
      .map((operation) => operation.operationId);
    const deliberatelyNonReplayable = writeOperations
      .filter((operation) => operation.mutationDisposition.kind === "deliberately-non-replayable")
      .map((operation) => operation.operationId);
    const incidents = DATABASE_OPERATION_REGISTRY.flatMap((operation) => operation.incidents);
    const dispositions = allMutationDispositions();
    const receiptBackedIds = new Set<string>(EXPECTED_RECEIPT_BACKED_OPERATION_IDS);
    const deliberatelyNonReplayableIds = new Set<string>(
      EXPECTED_DELIBERATELY_NON_REPLAYABLE_OPERATION_IDS,
    );

    expect(sorted(writeOperations.map((operation) => operation.operationId))).toEqual(
      sorted(EXPECTED_WRITE_OPERATION_IDS),
    );
    expect(sorted(Object.keys(WRITE_MUTATION_POLICIES))).toEqual(
      sorted(EXPECTED_WRITE_OPERATION_IDS),
    );
    expect(sorted(Object.keys(TRIGGER_MUTATION_POLICY_IDS))).toEqual(
      sorted([...new Set(writeTriggers.map((trigger) => trigger.operationId))]),
    );
    expect(sorted(incidents.map((incident) => incident.functionName))).toEqual(
      sorted(EXPECTED_INCIDENT_FUNCTION_NAMES),
    );
    expect(sorted(Object.keys(INCIDENT_MUTATION_POLICIES))).toEqual(
      sorted(EXPECTED_INCIDENT_FUNCTION_NAMES),
    );
    expect(sorted(receiptBacked)).toEqual(sorted(EXPECTED_RECEIPT_BACKED_OPERATION_IDS));
    expect(sorted(deliberatelyNonReplayable)).toEqual(
      sorted(EXPECTED_DELIBERATELY_NON_REPLAYABLE_OPERATION_IDS),
    );
    expect(new Set(dispositions.map((disposition) => disposition.kind))).toEqual(
      EXPECTED_MUTATION_DISPOSITION_KINDS,
    );

    for (const operation of DATABASE_OPERATION_REGISTRY) {
      if (operation.accessClass !== "write") {
        expect(operation.mutationDisposition.kind, operation.operationId).toBe("not-applicable");
        continue;
      }

      const expectedKind = receiptBackedIds.has(operation.operationId)
        ? "receipt-backed"
        : deliberatelyNonReplayableIds.has(operation.operationId)
          ? "deliberately-non-replayable"
          : "replay-safe-idempotent";
      expect(operation.mutationDisposition.kind, operation.operationId).toBe(expectedKind);
    }

    for (const trigger of writeTriggers) {
      const policyId =
        TRIGGER_MUTATION_POLICY_IDS[
          trigger.operationId as keyof typeof TRIGGER_MUTATION_POLICY_IDS
        ];
      expect(policyId, trigger.operationId).toBeDefined();
      if (policyId === undefined) {
        throw new Error(`missing trigger policy for ${trigger.operationId}`);
      }
      expect(trigger.mutationDisposition.kind, trigger.operationId).toBe(
        WRITE_MUTATION_POLICIES[policyId].kind,
      );
    }

    for (const incident of incidents) {
      expect(incident.mutationDisposition.kind, incident.functionName).toBe(
        "replay-safe-idempotent",
      );
    }

    for (const disposition of dispositions) {
      expect(disposition.evidenceSource.trim()).not.toBe("");
      expect(
        existsSync(join(REPO_ROOT, disposition.evidenceSource)),
        disposition.evidenceSource,
      ).toBe(true);
      expect(disposition.rationale.trim()).not.toBe("");
      expect(disposition.reconciliation.trim()).not.toBe("");
    }
  });

  it("requires structured dispositions on every recurring operation and trigger", () => {
    const noDatabaseTimers = DATABASE_OPERATION_REGISTRY.filter(
      (operation) => operation.accessClass === null,
    );

    expect(noDatabaseTimers.map((operation) => operation.operationId).sort()).toEqual(
      [
        "ops.audit",
        "ops.audit-review",
        "ops.secrets-sync",
        "ops.sentry-triage",
        "ops.timer-watchdog",
      ].sort(),
    );

    for (const operation of DATABASE_OPERATION_REGISTRY) {
      const triggerClasses = operation.triggers.map((trigger) => trigger.accessClass);
      const aggregate = triggerClasses.includes("write")
        ? "write"
        : triggerClasses.includes("heavy-read")
          ? "heavy-read"
          : triggerClasses.includes("read")
            ? "read"
            : null;

      expect(operation.accessClass, operation.operationId).toBe(aggregate);

      if (operation.accessClass === "write") {
        expect(operation.mutationDisposition.kind, operation.operationId).not.toBe(
          "not-applicable",
        );
      } else {
        expect(operation.mutationDisposition.kind, operation.operationId).toBe("not-applicable");
      }

      if (operation.accessClass === null) {
        expect(operation.triggers.every((trigger) => trigger.kind === "no-database")).toBe(true);
      }

      for (const trigger of operation.triggers) {
        expect(trigger.mutationDisposition.kind, trigger.operationId).toBe(
          trigger.accessClass === "write"
            ? trigger.operationId === "health.snapshot"
              ? "receipt-backed"
              : operation.mutationDisposition.kind
            : "not-applicable",
        );
      }
    }
  });
});
