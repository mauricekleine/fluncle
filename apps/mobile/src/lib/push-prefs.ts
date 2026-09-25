import { type PushCategory } from "@fluncle/contracts";

export type { PushCategory };

const PUSH_CATEGORIES = ["findings", "mixtapes"] as const satisfies readonly PushCategory[];

export type PushPrefs = { findings: boolean; mixtapes: boolean };

export const DEFAULT_PUSH_PREFS: PushPrefs = { findings: true, mixtapes: true };

export function mutedCategories(prefs: PushPrefs): PushCategory[] {
  return PUSH_CATEGORIES.filter((category) => !prefs[category]);
}

export function serialize(prefs: PushPrefs): string {
  return JSON.stringify(prefs);
}

export function deserialize(raw: string | null | undefined): PushPrefs {
  if (!raw) {
    return { ...DEFAULT_PUSH_PREFS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PUSH_PREFS };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_PUSH_PREFS };
  }
  const row = parsed as Record<string, unknown>;
  return {
    findings: typeof row.findings === "boolean" ? row.findings : true,
    mixtapes: typeof row.mixtapes === "boolean" ? row.mixtapes : true,
  };
}
