import { type SonarMatch } from "./sonar";

/**
 * Hydrate ranked Sonar ids against current Turso truth.
 *
 * Sonar order is authoritative for the returned matches, while Turso is authoritative for whether
 * an id still exists and still clears the consumer's hydration predicate. Missing rows are dropped;
 * they are never synthesized from stale index data. Track, log, and sonic search share this exact
 * late-hydration contract.
 */
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
