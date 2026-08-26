import { type InValue } from "@libsql/client";

import { PERFORMANCE_BUDGETS, type PerformanceWorkClass, distribution } from "./budgets";
import { type FixtureCounts, type ScaleProfile } from "./manifest";
import { type ExplainPlanAnalysis, type ExplainPlanPolicy, analyzeExplainPlan } from "./plan";

export const PERFORMANCE_CONTRACT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export type PerformanceStatement = { args: InValue[]; sql: string };

export type PerformanceResult = {
  rows: unknown[];
  rowsAffected?: number;
};

export type PerformanceClient = {
  execute: (statement: PerformanceStatement | string) => Promise<PerformanceResult>;
};

export type ContractObservation = {
  affectedRowCount?: number;
  batchCount?: number | null;
  durationMs?: number;
  invariants?: Partial<
    Record<"ambiguousOutcomes" | "remoteFullCorpusScans" | "repeatedProductionCorpusScans", number>
  >;
  metadata?: Record<string, boolean | number | string | null>;
  queueMs?: number;
  resultRowCount: number;
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
  iterations: number;
  plan?: {
    policy: ExplainPlanPolicy;
    statement: PerformanceStatement;
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
  description: string;
  durationMs: ReturnType<typeof distribution>;
  invariantTotals: Record<string, number>;
  iterations: number;
  metadata: Record<string, boolean | number | string | null>[];
  passed: boolean;
  plan: ExplainPlanAnalysis | null;
  queueMs: ReturnType<typeof distribution> | null;
  resultRowCount: ReturnType<typeof distribution>;
  validationFailures: string[];
  workClass: PerformanceWorkClass;
};

export type PerformanceRunReport = {
  contracts: ContractReport[];
  generatedAt: string;
  passed: boolean;
  profile: ScaleProfile;
  schemaVersion: 1;
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
  statement: PerformanceStatement;
};

export function sqlContract(options: SqlContractOptions): PerformanceContract {
  return {
    ...options,
    async execute(context) {
      const startedAt = context.now();
      const result = await context.client.execute(options.statement);

      return {
        affectedRowCount: result.rowsAffected ?? 0,
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

export async function runPerformanceContracts(options: {
  client: PerformanceClient;
  contracts: readonly PerformanceContract[];
  fixtureCounts?: FixtureCounts;
  generatedAt?: string;
  now?: () => number;
  profile: ScaleProfile;
}): Promise<PerformanceRunReport> {
  const now = options.now ?? performance.now.bind(performance);
  const reports: ContractReport[] = [];

  for (const contract of options.contracts) {
    let plan: ExplainPlanAnalysis | null = null;

    if (contract.plan) {
      const result = await options.client.execute({
        args: contract.plan.statement.args,
        sql: `EXPLAIN QUERY PLAN ${contract.plan.statement.sql}`,
      });
      plan = analyzeExplainPlan(planDetails(result), contract.plan.policy);
    }

    const warmups = contract.warmupIterations ?? 0;
    for (let iteration = 0; iteration < warmups; iteration += 1) {
      await contract.execute({
        client: options.client,
        fixtureCounts: options.fixtureCounts,
        iteration: -iteration - 1,
        now,
        profile: options.profile,
      });
    }

    const observations: ContractExecution[] = [];
    const validationFailures: string[] = [];

    for (let iteration = 0; iteration < contract.iterations; iteration += 1) {
      const observation = await contract.execute({
        client: options.client,
        fixtureCounts: options.fixtureCounts,
        iteration,
        now,
        profile: options.profile,
      });
      observations.push(observation);

      for (const failure of contract.validate?.(observation) ?? []) {
        validationFailures.push(`iteration ${iteration + 1}: ${failure}`);
      }
    }

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
    const resultCounts = distribution(
      observations.map((observation) => observation.resultRowCount),
    );
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
    }

    const definition = PERFORMANCE_BUDGETS[contract.workClass];
    const required = definition.requiredProfiles.includes(options.profile);
    const budgetProblems: string[] = [];

    for (const measurement of definition.measurements) {
      const actual = metricValue(measurement.metric, durations);
      if (actual > measurement.thresholdMs) {
        budgetProblems.push(
          `${measurement.metric} ${actual}ms exceeds ${measurement.thresholdMs}ms`,
        );
      }
    }

    for (const invariant of definition.invariants) {
      const actual = invariantTotals[invariant.field] ?? 0;
      if (actual > invariant.maximum) {
        budgetProblems.push(`${invariant.field} ${actual} exceeds ${invariant.maximum}`);
      }
    }

    const failures = required ? budgetProblems : [];
    const warnings = required ? [] : budgetProblems;
    const planFailures = plan?.violations ?? [];

    reports.push({
      affectedRowCount: affectedRowCounts.length > 0 ? distribution(affectedRowCounts) : null,
      batchCount: batchCounts.length > 0 ? distribution(batchCounts) : null,
      budget: {
        description: definition.description,
        failures,
        required,
        warnings,
      },
      contractId: contract.id,
      description: contract.description,
      durationMs: durations,
      invariantTotals,
      iterations: observations.length,
      metadata,
      passed: failures.length === 0 && validationFailures.length === 0 && planFailures.length === 0,
      plan,
      queueMs: queueValues.length > 0 ? distribution(queueValues) : null,
      resultRowCount: resultCounts,
      validationFailures,
      workClass: contract.workClass,
    });
  }

  return {
    contracts: reports,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    passed: reports.every((report) => report.passed),
    profile: options.profile,
    schemaVersion: 1,
  };
}
