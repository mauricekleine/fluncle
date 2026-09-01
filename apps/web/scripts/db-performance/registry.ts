import { type InValue } from "@libsql/client";

import {
  PERFORMANCE_BUDGETS,
  PERFORMANCE_CRITERION_CATEGORIES,
  PERFORMANCE_RESOURCE_WARNING_THRESHOLDS,
  type PerformanceCriterionCategory,
  type PerformanceResourceThresholds,
  type PerformanceWorkClass,
  distribution,
} from "./budgets";
import { type FixtureCounts, type ScaleProfile } from "./manifest";
import {
  buildIndexAudit,
  type IndexAuditReport,
  type IndexEvidenceDefinition,
} from "./index-inventory";
import { type ExplainPlanAnalysis, type ExplainPlanPolicy, analyzeExplainPlan } from "./plan";

export const PERFORMANCE_CONTRACT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const PERFORMANCE_REPORT_SCHEMA_VERSION = 5 as const;

export type PerformanceStatement = { args: InValue[]; sql: string };

export type PerformanceResult = {
  rows: unknown[];
  rowsAffected?: number;
};

export type ConvergenceObservation = {
  category: "projection" | "queue";
  converged: boolean;
  fieldMismatches: number;
  missingRows: number;
  projectedRows: number;
  repairRows: number;
  scope: string;
  sourceRows: number;
  unexpectedRows: number;
};

export type ConvergenceReport = ConvergenceObservation & {
  failedObservations: number;
  observations: number;
};

export type PerformanceResourceSample = {
  heapUsedBytes: number;
  rssBytes: number;
};

export type PerformanceResourceSampleSource =
  | "process.memoryUsage"
  | "process.memoryUsage.isolated-local-libsql-client"
  | "provided";

export type PerformanceExecutionProgress = {
  contractId?: string;
  iteration?: number;
  iterations?: number;
  phase:
    | "fixture-identity"
    | "fixture-census"
    | "index-plan"
    | "warmup"
    | "measured-iteration"
    | "terminal-proof";
};

export function formatPerformanceExecutionProgress(progress: PerformanceExecutionProgress): string {
  const fields = [`phase=${progress.phase}`];
  if (progress.contractId !== undefined) {
    fields.push(`contract=${progress.contractId}`);
  }
  if (progress.iteration !== undefined && progress.iterations !== undefined) {
    fields.push(`iteration=${progress.iteration}/${progress.iterations}`);
  }
  return `[db-performance] ${fields.join(" ")}`;
}

export function isPerformanceTimeoutError(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(candidate instanceof Error)) {
      return false;
    }
    if (candidate.name === "TimeoutError") {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

export async function executePerformancePhase<T>(
  progress: PerformanceExecutionProgress,
  onProgress: ((progress: PerformanceExecutionProgress) => void) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  onProgress?.(progress);
  try {
    return await operation();
  } catch (error) {
    if (!isPerformanceTimeoutError(error)) {
      throw error;
    }

    const timeout = new Error(`${formatPerformanceExecutionProgress(progress)} request timed out`);
    timeout.name = "TimeoutError";
    throw timeout;
  }
}

export type PerformanceResourceReport = {
  availability: "measured" | "unavailable";
  failures: string[];
  mode: "required" | "bounded-memory-timing-warning";
  peak: (PerformanceResourceSample & { wallDurationMs: number }) | null;
  sampleSource: PerformanceResourceSampleSource | null;
  unavailableReason: string | null;
  warningThresholds: PerformanceResourceThresholds;
  warnings: string[];
};

export type PerformanceClient = {
  batch?: (statements: PerformanceStatement[], mode: "write") => Promise<PerformanceResult[]>;
  execute: (statement: PerformanceStatement | string) => Promise<PerformanceResult>;
};

export async function executePerformanceBatch(
  client: PerformanceClient,
  statements: readonly PerformanceStatement[],
): Promise<PerformanceResult[]> {
  if (client.batch === undefined) {
    throw new Error("performance contract requires transactional batch support");
  }

  return client.batch([...statements], "write");
}

export type ContractObservation = {
  affectedRowCount?: number;
  batchCount?: number | null;
  durationMs?: number;
  invariants?: Partial<
    Record<
      | "ambiguousOutcomes"
      | "architectureFailures"
      | "atomicityViolations"
      | "convergenceFailures"
      | "fifoViolations"
      | "fencingViolations"
      | "remoteFullCorpusScans"
      | "repeatedProductionCorpusScans"
      | "uncontendedAcquisitionViolations",
      number
    >
  >;
  metadata?: Record<string, boolean | number | string | null>;
  queueMs?: number;
  resultRowCount: number;
  convergence?: ConvergenceObservation;
};

export type ContractExecution = ContractObservation & {
  rawResult?: PerformanceResult;
};

export type ContractContext = {
  client: PerformanceClient;
  fixtureCounts?: FixtureCounts;
  iteration: number;
  now: () => number;
  profile: ScaleProfile;
};

export type PerformanceContract = {
  description: string;
  execute: (context: ContractContext) => Promise<ContractExecution>;
  id: string;
  indexEvidence?: IndexEvidenceDefinition;
  iterations: number;
  plan?: {
    policy: ExplainPlanPolicy;
    statement: PerformanceStatement;
  };
  terminalProof?: {
    execute: (context: ContractContext) => Promise<ContractExecution>;
    validate?: (execution: ContractExecution) => readonly string[];
  };
  validate?: (execution: ContractExecution) => readonly string[];
  warmupIterations?: number;
  workClass: PerformanceWorkClass;
};

export type ContractReport = {
  affectedRowCount: ReturnType<typeof distribution> | null;
  batchCount: ReturnType<typeof distribution> | null;
  budget: {
    description: string;
    failures: string[];
    required: boolean;
    warnings: string[];
  };
  contractId: string;
  criterionCategories: PerformanceCriterionCategory[];
  description: string;
  durationMs: ReturnType<typeof distribution>;
  invariantTotals: Record<string, number>;
  iterations: number;
  metadata: Record<string, boolean | number | string | null>[];
  passed: boolean;
  plan: ExplainPlanAnalysis | null;
  queueMs: ReturnType<typeof distribution> | null;
  resultRowCount: ReturnType<typeof distribution>;
  convergence: ConvergenceReport | null;
  validationFailures: string[];
  workClass: PerformanceWorkClass;
};

export type PerformanceCriterionReport = {
  addressed: boolean;
  contractIds: string[];
  passed: boolean | null;
  warnings: string[];
};

export type PerformanceRunReport = {
  contracts: ContractReport[];
  criteria: Record<PerformanceCriterionCategory, PerformanceCriterionReport>;
  generatedAt: string;
  indexAudit: IndexAuditReport | null;
  passed: boolean;
  profile: ScaleProfile;
  resources: PerformanceResourceReport;
  schemaVersion: typeof PERFORMANCE_REPORT_SCHEMA_VERSION;
};

export class PerformanceRegistry {
  readonly #contracts = new Map<string, PerformanceContract>();

  register(contract: PerformanceContract): this {
    if (!PERFORMANCE_CONTRACT_ID.test(contract.id) || contract.id.length > 96) {
      throw new Error(`invalid performance contract id: ${contract.id}`);
    }

    if (!Number.isSafeInteger(contract.iterations) || contract.iterations < 1) {
      throw new Error(`${contract.id} must run at least one iteration`);
    }

    if (this.#contracts.has(contract.id)) {
      throw new Error(`duplicate performance contract id: ${contract.id}`);
    }

    this.#contracts.set(contract.id, contract);

    return this;
  }

  get(id: string): PerformanceContract {
    const contract = this.#contracts.get(id);

    if (!contract) {
      throw new Error(`unknown performance contract: ${id}`);
    }

    return contract;
  }

  list(): PerformanceContract[] {
    return [...this.#contracts.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export type SqlContractOptions = Omit<PerformanceContract, "execute"> & {
  convergence?: (
    context: ContractContext,
    result: PerformanceResult,
  ) => Promise<ConvergenceObservation>;
  statement: PerformanceStatement;
};

export function sqlContract(options: SqlContractOptions): PerformanceContract {
  const { convergence, ...contract } = options;

  return {
    ...contract,
    async execute(context) {
      const startedAt = context.now();
      const result = await context.client.execute(options.statement);

      return {
        affectedRowCount: result.rowsAffected ?? 0,
        convergence: convergence ? await convergence(context, result) : undefined,
        durationMs: Math.max(0, context.now() - startedAt),
        rawResult: result,
        resultRowCount: result.rows.length,
      };
    },
  };
}

function planDetails(result: PerformanceResult): string[] {
  return result.rows.map((row, index) => {
    if (typeof row === "object" && row !== null && "detail" in row) {
      const detail = (row as { detail?: unknown }).detail;

      if (typeof detail === "string") {
        return detail;
      }
    }

    throw new Error(`EXPLAIN QUERY PLAN row ${index} has no string detail`);
  });
}

function metricValue(
  metric: "max" | "p95" | "p99",
  values: ReturnType<typeof distribution>,
): number {
  return values[metric];
}

function requireResourceValue(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`resource sampling returned an invalid ${field} value`);
  }

  return value;
}

export function readPerformanceResourceSample(): PerformanceResourceSample {
  if (typeof process === "undefined" || typeof process.memoryUsage !== "function") {
    throw new Error("resource sampling is unavailable: process.memoryUsage is required");
  }

  const memory = process.memoryUsage();

  return {
    heapUsedBytes: requireResourceValue(memory.heapUsed, "heapUsedBytes"),
    rssBytes: requireResourceValue(memory.rss, "rssBytes"),
  };
}

function validatePerformanceResourceSample(
  sample: PerformanceResourceSample,
): PerformanceResourceSample {
  return {
    heapUsedBytes: requireResourceValue(sample.heapUsedBytes, "heapUsedBytes"),
    rssBytes: requireResourceValue(sample.rssBytes, "rssBytes"),
  };
}

export function maxPerformanceResourceSample(
  left: PerformanceResourceSample,
  right: PerformanceResourceSample,
): PerformanceResourceSample {
  return {
    heapUsedBytes: Math.max(left.heapUsedBytes, right.heapUsedBytes),
    rssBytes: Math.max(left.rssBytes, right.rssBytes),
  };
}

function resourceWarnings(
  peak: NonNullable<PerformanceResourceReport["peak"]>,
  thresholds: PerformanceResourceThresholds,
): string[] {
  const warnings: string[] = [];

  for (const [field, actual, threshold] of [
    ["heapUsedBytes", peak.heapUsedBytes, thresholds.heapUsedBytes],
    ["rssBytes", peak.rssBytes, thresholds.rssBytes],
    ["wallDurationMs", peak.wallDurationMs, thresholds.wallDurationMs],
  ] as const) {
    if (actual > threshold) {
      warnings.push(`${field} ${actual} exceeds ${threshold}`);
    }
  }

  return warnings;
}

function convergenceReport(observations: readonly ContractExecution[]): ConvergenceReport | null {
  const evidence = observations.flatMap((observation) =>
    observation.convergence === undefined ? [] : [observation.convergence],
  );
  const first = evidence[0];

  if (first === undefined) {
    return null;
  }

  return {
    ...first,
    converged: evidence.every((entry) => entry.converged),
    failedObservations: evidence.filter((entry) => !entry.converged).length,
    observations: evidence.length,
  };
}

function criterionCategoriesForContract(
  contract: PerformanceContract,
): PerformanceCriterionCategory[] {
  return PERFORMANCE_CRITERION_CATEGORIES.includes(contract.workClass) ? [contract.workClass] : [];
}

function emptyCriteria(): Record<PerformanceCriterionCategory, PerformanceCriterionReport> {
  return Object.fromEntries(
    PERFORMANCE_CRITERION_CATEGORIES.map((category) => [
      category,
      { addressed: false, contractIds: [], passed: null, warnings: [] },
    ]),
  ) as Record<PerformanceCriterionCategory, PerformanceCriterionReport>;
}

function buildCriteria(
  reports: readonly ContractReport[],
  resources: PerformanceResourceReport,
): Record<PerformanceCriterionCategory, PerformanceCriterionReport> {
  const criteria = emptyCriteria();

  for (const report of reports) {
    const categories = report.criterionCategories;

    for (const category of categories) {
      const criterion = criteria[category];
      criterion.addressed = true;
      criterion.contractIds.push(report.contractId);
      criterion.passed = (criterion.passed ?? true) && report.passed;
      criterion.warnings.push(...report.budget.warnings);
    }
  }

  const resourcesCriterion = criteria.resources;
  resourcesCriterion.addressed = resources.availability === "measured";
  resourcesCriterion.passed =
    resources.availability === "measured" ? resources.failures.length === 0 : null;
  resourcesCriterion.warnings.push(...resources.warnings);

  return criteria;
}

function buildPerformanceResourceReport(options: {
  hasResourceSampling: boolean;
  now: () => number;
  peak: null | PerformanceResourceSample;
  profile: ScaleProfile;
  resource?: {
    sample?: () => PerformanceResourceSample;
    sampleSource?: PerformanceResourceSampleSource;
    wallDurationWarning?: boolean;
  };
  wallStartedAt: number;
}): PerformanceResourceReport {
  const resources: PerformanceResourceReport = {
    availability: options.hasResourceSampling ? "measured" : "unavailable",
    failures: [],
    mode:
      options.profile === "4x" || options.resource?.wallDurationWarning === true
        ? "bounded-memory-timing-warning"
        : "required",
    peak:
      options.peak === null
        ? null
        : {
            ...options.peak,
            wallDurationMs: Math.max(0, options.now() - options.wallStartedAt),
          },
    sampleSource: options.hasResourceSampling
      ? (options.resource?.sampleSource ??
        (options.resource?.sample ? "provided" : "process.memoryUsage"))
      : null,
    unavailableReason: options.hasResourceSampling
      ? null
      : "resource sampling was not supplied for this contract-only run",
    warningThresholds: PERFORMANCE_RESOURCE_WARNING_THRESHOLDS[options.profile],
    warnings: [],
  };

  if (resources.peak === null) {
    resources.warnings.push(resources.unavailableReason ?? "resource sampling is unavailable");
    return resources;
  }

  const resourceProblems = resourceWarnings(resources.peak, resources.warningThresholds);
  if (resources.mode === "required") {
    resources.failures = resourceProblems;
  } else {
    resources.failures = resourceProblems.filter(
      (problem) => !problem.startsWith("wallDurationMs "),
    );
    resources.warnings = resourceProblems.filter((problem) =>
      problem.startsWith("wallDurationMs "),
    );
  }

  return resources;
}

async function attachTerminalContractEvidence(options: {
  client: PerformanceClient;
  contracts: readonly PerformanceContract[];
  fixtureCounts?: FixtureCounts;
  now: () => number;
  onProgress?: (progress: PerformanceExecutionProgress) => void;
  onTerminalProof: () => void;
  profile: ScaleProfile;
  reports: ContractReport[];
}): Promise<void> {
  // The embedded local driver keeps EXPLAIN statements alive long enough to block a later explicit
  // write-batch commit. Contracts therefore finish every production-shaped mutation first; plans
  // and structural proofs remain mandatory evidence in this terminal read-only phase.
  for (const [index, contract] of options.contracts.entries()) {
    const report = options.reports[index];
    if (report === undefined || report.contractId !== contract.id) {
      throw new Error(`performance report order diverged at ${contract.id}`);
    }

    if (contract.plan !== undefined) {
      const contractPlan = contract.plan;
      const result = await executePerformancePhase(
        { contractId: contract.id, phase: "index-plan" },
        options.onProgress,
        () =>
          options.client.execute({
            args: contractPlan.statement.args,
            sql: `EXPLAIN QUERY PLAN ${contractPlan.statement.sql}`,
          }),
      );
      const plan = analyzeExplainPlan(planDetails(result), contractPlan.policy);
      report.plan = plan;
      report.passed = report.passed && plan.violations.length === 0;
    }

    if (contract.terminalProof !== undefined) {
      const terminalProofContract = contract.terminalProof;
      const terminalProof = await executePerformancePhase(
        { contractId: contract.id, phase: "terminal-proof" },
        options.onProgress,
        () =>
          terminalProofContract.execute({
            client: options.client,
            fixtureCounts: options.fixtureCounts,
            iteration: 0,
            now: options.now,
            profile: options.profile,
          }),
      );
      const terminalFailures = terminalProofContract.validate?.(terminalProof) ?? [];
      report.validationFailures.push(
        ...terminalFailures.map((failure) => `terminal proof: ${failure}`),
      );
      if (terminalProof.metadata !== undefined) {
        report.metadata =
          report.metadata.length === 0
            ? [terminalProof.metadata]
            : report.metadata.map((metadata) => ({ ...metadata, ...terminalProof.metadata }));
      }
      report.passed = report.passed && terminalFailures.length === 0;
      options.onTerminalProof();
    }
  }
}

type PerformanceResourceOptions = {
  initial?: PerformanceResourceSample;
  sample?: () => PerformanceResourceSample;
  sampleSource?: PerformanceResourceSampleSource;
  startedAtMs?: number;
  wallDurationWarning?: boolean;
};

function prepareResourceSampling(
  resource: PerformanceResourceOptions | undefined,
  now: () => number,
): {
  hasResourceSampling: boolean;
  peak: PerformanceResourceSample | null;
  resourceSample: () => PerformanceResourceSample;
  wallStartedAt: number;
} {
  const resourceSample = () =>
    validatePerformanceResourceSample((resource?.sample ?? readPerformanceResourceSample)());
  const hasResourceSampling = resource !== undefined;
  const initial = resource?.initial;
  const peak = hasResourceSampling
    ? maxPerformanceResourceSample(
        initial === undefined ? resourceSample() : validatePerformanceResourceSample(initial),
        resourceSample(),
      )
    : null;
  return {
    hasResourceSampling,
    peak,
    resourceSample,
    wallStartedAt: resource?.startedAtMs ?? now(),
  };
}

function buildContractReport(
  contract: PerformanceContract,
  observations: ContractExecution[],
  validationFailures: string[],
  profile: ScaleProfile,
): ContractReport {
  const durations = distribution(observations.map((observation) => observation.durationMs ?? 0));
  const queueValues = observations.flatMap((observation) =>
    observation.queueMs === undefined ? [] : [observation.queueMs],
  );
  const affectedRowCounts = observations.flatMap((observation) =>
    observation.affectedRowCount === undefined ? [] : [observation.affectedRowCount],
  );
  const batchCounts = observations.flatMap((observation) =>
    observation.batchCount === undefined || observation.batchCount === null
      ? []
      : [observation.batchCount],
  );
  const resultCounts = distribution(observations.map((observation) => observation.resultRowCount));
  const metadata = observations
    .flatMap((observation) => (observation.metadata ? [observation.metadata] : []))
    .filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) ===
        index,
    );
  const invariantTotals: Record<string, number> = {};

  for (const observation of observations) {
    for (const [field, value] of Object.entries(observation.invariants ?? {})) {
      invariantTotals[field] = (invariantTotals[field] ?? 0) + (value ?? 0);
    }
    if (
      observation.convergence?.converged === false &&
      observation.invariants?.convergenceFailures === undefined
    ) {
      invariantTotals.convergenceFailures = (invariantTotals.convergenceFailures ?? 0) + 1;
    }
  }

  const definition = PERFORMANCE_BUDGETS[contract.workClass];
  const required = definition.requiredProfiles.includes(profile);
  const measurementProblems: string[] = [];

  for (const measurement of definition.measurements) {
    const actual = metricValue(measurement.metric, durations);
    if (actual > measurement.thresholdMs) {
      measurementProblems.push(
        `${measurement.metric} ${actual}ms exceeds ${measurement.thresholdMs}ms`,
      );
    }
  }

  const invariantProblems: string[] = [];
  for (const invariant of definition.invariants) {
    const actual = invariantTotals[invariant.field] ?? 0;
    if (actual > invariant.maximum) {
      invariantProblems.push(`${invariant.field} ${actual} exceeds ${invariant.maximum}`);
    }
  }

  const failures = [...invariantProblems, ...(required ? measurementProblems : [])];
  const warnings = required ? [] : measurementProblems;

  return {
    affectedRowCount: affectedRowCounts.length > 0 ? distribution(affectedRowCounts) : null,
    batchCount: batchCounts.length > 0 ? distribution(batchCounts) : null,
    budget: {
      description: definition.description,
      failures,
      required,
      warnings,
    },
    contractId: contract.id,
    convergence: convergenceReport(observations),
    criterionCategories: criterionCategoriesForContract(contract),
    description: contract.description,
    durationMs: durations,
    invariantTotals,
    iterations: observations.length,
    metadata,
    passed: failures.length === 0 && validationFailures.length === 0,
    plan: null,
    queueMs: queueValues.length > 0 ? distribution(queueValues) : null,
    resultRowCount: resultCounts,
    validationFailures,
    workClass: contract.workClass,
  };
}

export async function runPerformanceContracts(options: {
  client: PerformanceClient;
  contracts: readonly PerformanceContract[];
  fixtureCounts?: FixtureCounts;
  generatedAt?: string;
  now?: () => number;
  onProgress?: (progress: PerformanceExecutionProgress) => void;
  profile: ScaleProfile;
  resource?: PerformanceResourceOptions;
}): Promise<PerformanceRunReport> {
  const now = options.now ?? performance.now.bind(performance);
  const sampling = prepareResourceSampling(options.resource, now);
  const { hasResourceSampling, resourceSample, wallStartedAt } = sampling;
  let { peak } = sampling;
  const reports: ContractReport[] = [];

  for (const contract of options.contracts) {
    const warmups = contract.warmupIterations ?? 0;
    for (let iteration = 0; iteration < warmups; iteration += 1) {
      await executePerformancePhase(
        {
          contractId: contract.id,
          iteration: iteration + 1,
          iterations: warmups,
          phase: "warmup",
        },
        options.onProgress,
        () =>
          contract.execute({
            client: options.client,
            fixtureCounts: options.fixtureCounts,
            iteration: -iteration - 1,
            now,
            profile: options.profile,
          }),
      );
      peak = peak === null ? null : maxPerformanceResourceSample(peak, resourceSample());
    }

    const observations: ContractExecution[] = [];
    const validationFailures: string[] = [];

    for (let iteration = 0; iteration < contract.iterations; iteration += 1) {
      const observation = await executePerformancePhase(
        {
          contractId: contract.id,
          iteration: iteration + 1,
          iterations: contract.iterations,
          phase: "measured-iteration",
        },
        options.onProgress,
        () =>
          contract.execute({
            client: options.client,
            fixtureCounts: options.fixtureCounts,
            iteration,
            now,
            profile: options.profile,
          }),
      );
      observations.push(observation);
      peak = peak === null ? null : maxPerformanceResourceSample(peak, resourceSample());

      for (const failure of contract.validate?.(observation) ?? []) {
        validationFailures.push(`iteration ${iteration + 1}: ${failure}`);
      }
      if (observation.convergence?.converged === false) {
        validationFailures.push(
          `iteration ${iteration + 1}: convergence evidence did not converge`,
        );
      }
    }

    reports.push(buildContractReport(contract, observations, validationFailures, options.profile));
  }

  await attachTerminalContractEvidence({
    client: options.client,
    contracts: options.contracts,
    fixtureCounts: options.fixtureCounts,
    now,
    onProgress: options.onProgress,
    onTerminalProof: () => {
      peak = peak === null ? null : maxPerformanceResourceSample(peak, resourceSample());
    },
    profile: options.profile,
    reports,
  });

  peak = peak === null ? null : maxPerformanceResourceSample(peak, resourceSample());
  const resources = buildPerformanceResourceReport({
    hasResourceSampling,
    now,
    peak,
    profile: options.profile,
    resource: options.resource,
    wallStartedAt,
  });

  const indexAudit = buildIndexAudit({
    contracts: options.contracts,
    profile: options.profile,
    reports,
  });

  return {
    contracts: reports,
    criteria: buildCriteria(reports, resources),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    indexAudit,
    passed:
      reports.every((report) => report.passed) &&
      resources.failures.length === 0 &&
      (indexAudit?.passed ?? true),
    profile: options.profile,
    resources,
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
  };
}
