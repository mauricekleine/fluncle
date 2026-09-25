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

export type SavedFinding = SavableFinding & { savedAt: number };

type SavedEnvelope = { items: SavedFinding[]; version: 1 };

const CURRENT_VERSION = 1 as const;

export function savedKey(finding: Pick<SavableFinding, "logId" | "trackId">): string {
  return finding.logId ?? finding.trackId;
}

export function isSaved(
  list: SavedFinding[],
  finding: Pick<SavableFinding, "logId" | "trackId">,
): boolean {
  const key = savedKey(finding);
  return list.some((item) => savedKey(item) === key);
}

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

export function removeSaved(
  list: SavedFinding[],
  finding: Pick<SavableFinding, "logId" | "trackId">,
): SavedFinding[] {
  const key = savedKey(finding);
  return list.filter((item) => savedKey(item) !== key);
}

export function toggleSaved(
  list: SavedFinding[],
  finding: SavableFinding,
  savedAt: number,
): SavedFinding[] {
  return isSaved(list, finding) ? removeSaved(list, finding) : addSaved(list, finding, savedAt);
}

export function serialize(list: SavedFinding[]): string {
  return JSON.stringify({ items: list, version: CURRENT_VERSION } satisfies SavedEnvelope);
}

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
