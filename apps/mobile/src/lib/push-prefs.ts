// Pure, React-Native-free logic for the push category preferences, so the mapping
// between the two on-screen toggles and the contract's `mutedCategories` array can be
// unit-tested in the repo's framework-free harness (see submit-fault.test.ts).
//
// The persistence + the React hook live in ./notification-prefs.ts (which imports
// these). The wire owns the INVERSE: `register_device` takes the categories a device
// has MUTED, so a toggle that is ON is a category that is ABSENT from the array.

/** The two categories a device can toggle. Mirrors the server's two send paths
 * (notifyNewFinding → "findings", notifyNewMixtape → "mixtapes") and the contract's
 * `PushCategorySchema` enum — kept as a const so the muted-array element type is
 * exactly the `register_device` input's `mutedCategories` element type. */
export const PUSH_CATEGORIES = ["findings", "mixtapes"] as const;

/** One push category — `"findings" | "mixtapes"`, matching the contract enum. */
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

/** Which categories the device WANTS (the toggles). ON ⇔ delivered; default both on. */
export type PushPrefs = { findings: boolean; mixtapes: boolean };

/** The default: everything on, nothing muted — a device opts OUT, never in. */
export const DEFAULT_PUSH_PREFS: PushPrefs = { findings: true, mixtapes: true };

/**
 * The `mutedCategories` array the contract wants: exactly the categories whose toggle
 * is OFF. Both on → `[]` (send everything). Order is stable (findings before mixtapes)
 * so an unchanged pref never produces a churny re-registration payload.
 */
export function mutedCategories(prefs: PushPrefs): PushCategory[] {
  return PUSH_CATEGORIES.filter((category) => !prefs[category]);
}

/** Serialize the prefs to storage. */
export function serialize(prefs: PushPrefs): string {
  return JSON.stringify(prefs);
}

/**
 * Read the prefs back, tolerant of anything (null/absent, invalid JSON, missing keys):
 * a missing or non-boolean key falls back to ON, so a corrupt store degrades to
 * "deliver everything" rather than silently muting the crew.
 */
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
