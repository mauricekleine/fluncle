import { createHash } from "node:crypto";

export const PROBE_NOW = "2026-01-02T03:04:05.000Z";
export const PROBE_BEFORE = "2025-11-02T03:04:05.000Z";
export const PROBE_AFTER = "2026-02-02T03:04:05.000Z";

export const PROBE_LADDER_BASE: readonly unknown[] = [
  null,
  "",
  "probe",
  0,
  1,
  PROBE_BEFORE,
  PROBE_AFTER,
  true,
  false,
  "pending",
  "failed",
  "processing",
  "complete",
  "empty",
  "duplicate-cleared",
  "wrong-audio",
  "full",
  "disabled",
];

export const PROBE_LADDER_TIMESTAMP: readonly unknown[] = [
  null,
  "",
  "probe",
  PROBE_BEFORE,
  PROBE_NOW,
  PROBE_AFTER,
];

export function isTimestampProbeColumn(column: string): boolean {
  return /(?:_at|At)$/.test(column);
}

export function probeLadderCrossing(thresholds: readonly number[]): readonly unknown[] {
  const crossings = new Set<number>();
  for (const threshold of thresholds) {
    if (!Number.isFinite(threshold)) {
      throw new Error("a probe threshold must be a finite number");
    }
    crossings.add(threshold - 1);
    crossings.add(threshold);
    crossings.add(threshold + 1);
  }
  return [...PROBE_LADDER_BASE, ...[...crossings].sort((left, right) => left - right)];
}

export function probeMatrix<Base extends Record<string, unknown>>(
  bases: readonly Base[],
  columns: readonly string[],
  ladder: readonly unknown[],
): Base[] {
  const probes: Base[] = [...bases];
  for (const base of bases) {
    for (const column of columns) {
      for (const value of isTimestampProbeColumn(column) ? PROBE_LADDER_TIMESTAMP : ladder) {
        probes.push({ ...base, [column]: value });
      }
    }
  }
  return probes;
}

export function memoizedProbeMatrix<Base extends Record<string, unknown>>(
  cache: Map<string, unknown>,
  key: string,
  build: () => Base[],
): Base[] {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached as Base[];
  }
  const built = build();
  cache.set(key, built);
  return built;
}

export function probeAnswer(answer: () => string): string {
  try {
    return answer();
  } catch {
    return "!";
  }
}

export function definitionFingerprint(namespace: string, transcript: readonly string[]): string {
  const digest = createHash("sha256")
    .update(`${namespace}${transcript.join("")}`)
    .digest("hex");
  return `dv1-${digest.slice(0, 16)}`;
}

export function memoizedDefinitionVersion(
  cache: Map<string, string>,
  key: string,
  compute: () => string,
): string {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const value = compute();
  cache.set(key, value);
  return value;
}
