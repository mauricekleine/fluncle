import { useEffect, useState } from "react";

export const FRESH_VISIT_STORAGE_KEY = "fluncle:fresh-visit";

export const FRESH_VISIT_SITTING_MS = 30 * 60 * 1000;

const FRESH_VISIT_KEY_CEILING = 2000;

export type FreshVisitRecord = { at: number; baseline?: string[]; first?: boolean; seen: string[] };

export type FreshVisitState =
  | { kind: "first" }
  | { kind: "returning"; newKeys: ReadonlySet<string> };

function keyList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((key) => typeof key === "string")
    ? value.slice(0, FRESH_VISIT_KEY_CEILING)
    : undefined;
}

export function parseFreshVisit(raw: string | null): FreshVisitRecord | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(raw);

    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const seen = keyList(record.seen);

    if (typeof record.at !== "number" || !seen) {
      return undefined;
    }

    return {
      at: record.at,
      baseline: keyList(record.baseline),
      first: record.first === true ? true : undefined,
      seen,
    };
  } catch {
    return undefined;
  }
}

export function nextFreshVisit(
  stored: FreshVisitRecord | undefined,
  currentKeys: string[],
  now: number,
): { record: FreshVisitRecord; state: FreshVisitState } {
  const inSitting =
    stored !== undefined && stored.at <= now && now - stored.at < FRESH_VISIT_SITTING_MS;

  if (!stored || (inSitting && stored.first)) {
    return {
      record: { at: now, first: true, seen: currentKeys.slice(0, FRESH_VISIT_KEY_CEILING) },
      state: { kind: "first" },
    };
  }

  const sameSitting = inSitting && stored.baseline !== undefined;
  const baseline = sameSitting ? (stored.baseline ?? []) : stored.seen;
  const known = new Set(baseline);

  return {
    record: {
      at: now,
      baseline: baseline.slice(0, FRESH_VISIT_KEY_CEILING),
      seen: currentKeys.slice(0, FRESH_VISIT_KEY_CEILING),
    },
    state: {
      kind: "returning",
      newKeys: new Set(currentKeys.filter((key) => !known.has(key))),
    },
  };
}

export function useFreshVisit(currentKeys: string[]): FreshVisitState | undefined {
  const [state, setState] = useState<FreshVisitState>();
  const signature = currentKeys.join("\n");

  useEffect(() => {
    let stored: FreshVisitRecord | undefined;

    try {
      stored = parseFreshVisit(window.localStorage.getItem(FRESH_VISIT_STORAGE_KEY));
    } catch {
      setState({ kind: "first" });

      return;
    }

    const next = nextFreshVisit(stored, currentKeys, Date.now());

    try {
      window.localStorage.setItem(FRESH_VISIT_STORAGE_KEY, JSON.stringify(next.record));
    } catch {}

    setState(next.state);

    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return state;
}
