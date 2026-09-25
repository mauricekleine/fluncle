export type CapturePriorityKind =
  | "artist"
  | "label"
  | "none"
  | "seed-label"
  | "skipped-label"
  | "unauthorized";

export const CAPTURE_TIER: Record<CapturePriorityKind, number> = {
  artist: 3,
  label: 2,
  none: 0,
  "seed-label": 1,
  "skipped-label": -1,
  unauthorized: -3,
};

export const CAPTURE_TIER_LABELS: Record<CapturePriorityKind, string> = {
  artist: "Known artist",
  label: "Known label",
  none: "Cold",
  "seed-label": "Seed label",
  "skipped-label": "Not our lane",
  unauthorized: "Not qualified",
};

export function captureTierLabelFor(priority: number): string {
  for (const kind of Object.keys(CAPTURE_TIER_LABELS) as CapturePriorityKind[]) {
    if (CAPTURE_TIER[kind] === priority) {
      return CAPTURE_TIER_LABELS[kind];
    }
  }

  return priority === -2 ? "Already in the archive" : "Unranked";
}
