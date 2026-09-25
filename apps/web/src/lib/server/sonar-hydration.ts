import { type SonarMatch } from "./sonar";

export async function hydrateRankedSonarMatches<Row, Result>(
  matches: SonarMatch[],
  loadRows: (ids: string[]) => Promise<Row[]>,
  rowId: (row: Row) => string,
  project: (row: Row, match: SonarMatch) => Result,
): Promise<Result[]> {
  const ids = [...new Set(matches.map((match) => match.id))];

  if (ids.length === 0) {
    return [];
  }

  const rows = await loadRows(ids);
  const byId = new Map(rows.map((row) => [rowId(row), row]));

  return matches.flatMap((match) => {
    const row = byId.get(match.id);

    return row ? [project(row, match)] : [];
  });
}
