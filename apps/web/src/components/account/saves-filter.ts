// The saved-findings power-scale tools (the Quiet Surface Rule: they appear only
// once the list is big enough to need them). Pure functions, deliberately kept out
// of the component so they carry their own focused unit tests. The `SavedFinding`
// type is imported type-only, so this module has no runtime dependency on the
// React-carrying `shared.tsx`.

import { type SavedFinding } from "./shared";

export type SavesSort = "saved" | "title";

/**
 * The threshold that summons the search + sort controls. Below it, the list is
 * scannable on its own and the tools stay hidden (DESIGN.md's Quiet Surface Rule —
 * scale summons the tool). The brief's "> ~40 findings".
 */
export const SAVES_POWER_SCALE = 40;

/**
 * Case-insensitive substring match over a finding's artists and title — the two
 * things a saver recognises a row by. An empty/blank query returns the list
 * untouched (same array reference), so the no-search path costs nothing.
 */
export function filterSavedFindings(findings: SavedFinding[], query: string): SavedFinding[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return findings;
  }

  return findings.filter((finding) =>
    `${finding.artists.join(" ")} ${finding.title}`.toLowerCase().includes(needle),
  );
}

/**
 * Order the list. `saved` is the server's own order (most-recently-saved first),
 * returned untouched; `title` re-sorts A→Z, case-insensitively, without mutating
 * the input (a fresh array — the server order stays intact for the toggle back).
 */
export function sortSavedFindings(findings: SavedFinding[], sort: SavesSort): SavedFinding[] {
  if (sort === "saved") {
    return findings;
  }

  return [...findings].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
}
