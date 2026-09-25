import { type SavedFinding } from "./shared";

export type SavesSort = "saved" | "title";

export const SAVES_POWER_SCALE = 40;

export function filterSavedFindings(findings: SavedFinding[], query: string): SavedFinding[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return findings;
  }

  return findings.filter((finding) =>
    `${finding.artists.join(" ")} ${finding.title}`.toLowerCase().includes(needle),
  );
}

export function sortSavedFindings(findings: SavedFinding[], sort: SavesSort): SavedFinding[] {
  if (sort === "saved") {
    return findings;
  }

  return [...findings].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
}
