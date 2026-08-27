import { type ScaleProfile } from "./manifest";

export const PERFORMANCE_WORK_CLASSES = [
  "route-db",
  "route-e2e",
  "projection",
  "queue",
  "writer-admission",
  "mutation",
  "sonar-refresh",
  "device-derivation",
] as const;

export type PerformanceWorkClass = (typeof PERFORMANCE_WORK_CLASSES)[number];

export type NumericBudget = {
  metric: "max" | "p95" | "p99";
  thresholdMs: number;
};

export type InvariantBudget = {
  field:
    | "ambiguousOutcomes"
    | "architectureFailures"
    | "atomicityViolations"
    | "convergenceFailures"
    | "fifoViolations"
    | "fencingViolations"
    | "remoteFullCorpusScans"
    | "repeatedProductionCorpusScans"
    | "uncontendedAcquisitionViolations";
  maximum: number;
};

export type PerformanceBudget = {
  description: string;
  id: PerformanceWorkClass;
  invariants: readonly InvariantBudget[];
  measurements: readonly NumericBudget[];
  requiredProfiles: readonly ScaleProfile[];
};

export const PERFORMANCE_BUDGETS: Record<PerformanceWorkClass, PerformanceBudget> = {
  "device-derivation": {
    description: "Device derivation after replica synchronization",
    id: "device-derivation",
    invariants: [
      { field: "architectureFailures", maximum: 0 },
      { field: "atomicityViolations", maximum: 0 },
      { field: "convergenceFailures", maximum: 0 },
      { field: "repeatedProductionCorpusScans", maximum: 0 },
    ],
    measurements: [],
    requiredProfiles: ["1x", "2x", "4x"],
  },
  mutation: {
    description: "Ordinary successful mutation transaction and outcome classification",
    id: "mutation",
    invariants: [
      { field: "ambiguousOutcomes", maximum: 0 },
      { field: "architectureFailures", maximum: 0 },
    ],
    measurements: [{ metric: "max", thresholdMs: 2_000 }],
    requiredProfiles: ["1x", "2x"],
  },
  projection: {
    description: "Contract D crawl and public projection reads",
    id: "projection",
    invariants: [{ field: "convergenceFailures", maximum: 0 }],
    measurements: [{ metric: "p95", thresholdMs: 250 }],
    requiredProfiles: ["1x", "2x", "4x"],
  },
  queue: {
    description: "Queue empty check or bounded claim",
    id: "queue",
    invariants: [{ field: "convergenceFailures", maximum: 0 }],
    measurements: [{ metric: "p95", thresholdMs: 250 }],
    requiredProfiles: ["1x", "2x"],
  },
  "route-db": {
    description: "Public route database spans",
    id: "route-db",
    invariants: [],
    measurements: [
      { metric: "p95", thresholdMs: 250 },
      { metric: "p99", thresholdMs: 750 },
    ],
    requiredProfiles: ["1x", "2x"],
  },
  "route-e2e": {
    description: "Public route end-to-end",
    id: "route-e2e",
    invariants: [],
    measurements: [
      { metric: "p95", thresholdMs: 1_000 },
      { metric: "p99", thresholdMs: 2_500 },
    ],
    requiredProfiles: ["1x", "2x"],
  },
  "sonar-refresh": {
    description: "Sonar steady-state refresh",
    id: "sonar-refresh",
    invariants: [
      { field: "architectureFailures", maximum: 0 },
      { field: "convergenceFailures", maximum: 0 },
      { field: "remoteFullCorpusScans", maximum: 0 },
    ],
    measurements: [],
    requiredProfiles: ["1x", "2x", "4x"],
  },
  "writer-admission": {
    description: "Background writer admission while uncontended",
    id: "writer-admission",
    invariants: [
      { field: "architectureFailures", maximum: 0 },
      { field: "convergenceFailures", maximum: 0 },
      { field: "fifoViolations", maximum: 0 },
      { field: "fencingViolations", maximum: 0 },
      { field: "uncontendedAcquisitionViolations", maximum: 0 },
    ],
    measurements: [{ metric: "p95", thresholdMs: 250 }],
    requiredProfiles: ["1x", "2x"],
  },
};

export const PERFORMANCE_CRITERION_CATEGORIES = [...PERFORMANCE_WORK_CLASSES, "resources"] as const;

export type PerformanceCriterionCategory = (typeof PERFORMANCE_CRITERION_CATEGORIES)[number];

export type PerformanceResourceThresholds = {
  heapUsedBytes: number;
  rssBytes: number;
  wallDurationMs: number;
};

export const PERFORMANCE_RESOURCE_WARNING_THRESHOLDS: Record<
  ScaleProfile,
  PerformanceResourceThresholds
> = {
  "1x": {
    heapUsedBytes: 128 * 1024 * 1024,
    rssBytes: 256 * 1024 * 1024,
    wallDurationMs: 60_000,
  },
  "2x": {
    heapUsedBytes: 192 * 1024 * 1024,
    rssBytes: 384 * 1024 * 1024,
    wallDurationMs: 90_000,
  },
  "4x": {
    heapUsedBytes: 256 * 1024 * 1024,
    rssBytes: 512 * 1024 * 1024,
    wallDurationMs: 180_000,
  },
};

export const PERFORMANCE_4X_RESOURCE_WARNING_THRESHOLDS =
  PERFORMANCE_RESOURCE_WARNING_THRESHOLDS["4x"];

export type Distribution = {
  max: number;
  p50: number;
  p95: number;
  p99: number;
};

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  if (percentileValue < 0 || percentileValue > 1) {
    throw new Error("percentile must be between zero and one");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);

  return sorted[index] ?? 0;
}

export function distribution(values: readonly number[]): Distribution {
  return {
    max: values.length === 0 ? 0 : Math.max(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}
