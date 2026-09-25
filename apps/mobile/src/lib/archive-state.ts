export type ArchiveView = "loading" | "offline" | "error" | "empty" | "list";

export function archiveView({
  count,
  isError,
  isPaused,
  isPending,
}: {
  count: number;
  isError: boolean;
  isPaused: boolean;
  isPending: boolean;
}): ArchiveView {
  if (count > 0) {
    return "list";
  }
  if (isPaused) {
    return "offline";
  }
  if (isPending) {
    return "loading";
  }
  if (isError) {
    return "error";
  }
  return "empty";
}

export const archiveCopy = {
  offline:
    "You're off the map for a minute. I'll pull the findings through the moment you're back.",
} as const;

export function findingLineParts(
  artists: string[],
  title: string,
): { artists: string; title: string } {
  return { artists: artists.join(", "), title };
}

export type MetaSegment = { numeric: boolean; text: string };

export function findingMetaSegments(finding: {
  bpm?: number | null;
  galaxyName?: string | null;
  key?: string | null;
}): MetaSegment[] {
  const segments: MetaSegment[] = [];
  if (finding.bpm) {
    segments.push({ numeric: true, text: `${Math.round(finding.bpm)} BPM` });
  }
  if (finding.key) {
    segments.push({ numeric: true, text: finding.key });
  }
  if (finding.galaxyName) {
    segments.push({ numeric: false, text: finding.galaxyName });
  }
  return segments;
}
