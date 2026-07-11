// Pure, React-Native-free logic for device-local saved findings, so the toggle,
// keying, ordering, and (de)serialization can be unit-tested in the repo's
// framework-free harness (see submit-fault.test.ts) without touching AsyncStorage.
//
// The persistence + the React hook live in ./saved.ts (which imports these). This
// module never imports RN or AsyncStorage so `bun test` can load it directly.
//
// A save stores a SNAPSHOT (the coordinate + the fields a row renders from), not a
// live reference. So a saved finding always renders from what was saved even if the
// archive later moves — and tapping a coordinate that no longer resolves is the
// detail screen's honest "Finding not found." branch, not a broken row here.

/** The minimal shape a caller must supply to save a finding (a TrackListItem or a
 * SearchHit, each mapped down to this). `logId` is the coordinate; a finding without
 * one is not certified and is never offered for saving. */
export type SavableFinding = {
  albumImageUrl?: string | null;
  artists: string[];
  bpm?: number | null;
  galaxyName?: string | null;
  key?: string | null;
  logId?: string | null;
  spotifyUrl?: string | null;
  title: string;
  trackId: string;
};

/** A saved finding: the snapshot plus when it was saved (for newest-first order). */
export type SavedFinding = SavableFinding & { savedAt: number };

/** The storage envelope. Versioned so a future shape change can migrate or discard. */
export type SavedEnvelope = { items: SavedFinding[]; version: 1 };

const CURRENT_VERSION = 1 as const;

/** The stable key for a saved finding — its coordinate, falling back to the trackId. */
export function savedKey(finding: Pick<SavableFinding, "logId" | "trackId">): string {
  return finding.logId ?? finding.trackId;
}

/** True ⇔ this finding is already in the saved list. */
export function isSaved(
  list: SavedFinding[],
  finding: Pick<SavableFinding, "logId" | "trackId">,
): boolean {
  const key = savedKey(finding);
  return list.some((item) => savedKey(item) === key);
}

/** Add a finding to the front of the list (newest-first); a no-op if already saved. */
export function addSaved(
  list: SavedFinding[],
  finding: SavableFinding,
  savedAt: number,
): SavedFinding[] {
  if (isSaved(list, finding)) {
    return list;
  }
  return [{ ...finding, savedAt }, ...list];
}

/** Remove a finding from the list by key; a no-op if it wasn't there. */
export function removeSaved(
  list: SavedFinding[],
  finding: Pick<SavableFinding, "logId" | "trackId">,
): SavedFinding[] {
  const key = savedKey(finding);
  return list.filter((item) => savedKey(item) !== key);
}

/** Flip a finding's saved state: add it if absent, drop it if present. */
export function toggleSaved(
  list: SavedFinding[],
  finding: SavableFinding,
  savedAt: number,
): SavedFinding[] {
  return isSaved(list, finding) ? removeSaved(list, finding) : addSaved(list, finding, savedAt);
}

/** Serialize the list to the versioned storage envelope. */
export function serialize(list: SavedFinding[]): string {
  return JSON.stringify({ items: list, version: CURRENT_VERSION } satisfies SavedEnvelope);
}

/**
 * Read the list back from storage, tolerant of anything: a null/absent value, invalid
 * JSON, a wrong version, or a row missing the fields a save needs all resolve to an
 * empty list rather than throwing. Rows are returned newest-first regardless of how
 * they were stored.
 */
export function deserialize(raw: string | null | undefined): SavedFinding[] {
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const envelope = parsed as { items?: unknown; version?: unknown };
  if (envelope.version !== CURRENT_VERSION || !Array.isArray(envelope.items)) {
    return [];
  }
  const items = envelope.items.filter(isSavedFinding);
  return [...items].sort((a, b) => b.savedAt - a.savedAt);
}

/** A row is usable only if it carries the fields a save needs — a coordinate/trackId,
 * a title, an artist array, and a timestamp. Anything short of that is dropped. */
function isSavedFinding(value: unknown): value is SavedFinding {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.trackId === "string" &&
    typeof row.title === "string" &&
    Array.isArray(row.artists) &&
    typeof row.savedAt === "number"
  );
}
