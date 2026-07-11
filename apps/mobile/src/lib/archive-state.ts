// Pure, React-Native-free helpers for the archive screen and its finding row, so
// the state branch and the truncation/meta logic can be unit-tested in the repo's
// framework-free harness (see submit-fault.test.ts) without mounting an RN tree.

/** The four mutually-exclusive views the archive resolves before it renders. */
export type ArchiveView = "loading" | "error" | "empty" | "list";

/**
 * The honest state branch. A cold start is `loading` (skeletons, not an empty
 * state), a first-load failure with nothing to show is `error`, a genuinely empty
 * result is `empty`, and anything with findings is the `list`. Data wins over a
 * later error so a background refetch failure never nukes an already-loaded list;
 * this is what keeps "Quiet sector." from being a lie on every cold start.
 */
export function archiveView({
  count,
  isError,
  isPending,
}: {
  count: number;
  isError: boolean;
  isPending: boolean;
}): ArchiveView {
  if (isPending) {
    return "loading";
  }
  if (count > 0) {
    return "list";
  }
  if (isError) {
    return "error";
  }
  return "empty";
}

/**
 * The finding row's primary line, split so the TITLE always survives truncation.
 * The artist list is the shrinkable half (the row ellipsizes it when long); the
 * title is returned whole and the row never shrinks it, so a long artist list can
 * never delete the title. The " — " separator lives with the title span and
 * disambiguates titles that carry their own " - " (e.g. remixes).
 */
export function findingLineParts(
  artists: string[],
  title: string,
): { artists: string; title: string } {
  return { artists: artists.join(", "), title };
}

/** A meta segment: its text and whether it is a figure (BPM/key) that must be set
 * in the tabular numeric face (the Tabular Rule). */
export type MetaSegment = { numeric: boolean; text: string };

/**
 * The finding row's quiet meta line, as typed segments. BPM and key are figures
 * (numeric → Oxanium tabular); the galaxy name is prose (the reading face). Empty
 * fields drop out, so the row renders no separator around a missing value.
 */
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
