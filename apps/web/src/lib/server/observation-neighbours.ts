import { getDb, typedRows } from "./db";
import { type ObservationNeighbor } from "./observation-echo";
import { getSimilarFindings } from "./tracks";

const OBSERVATION_NEIGHBOR_LIMIT = 6;

export async function observationNeighbours(
  trackId: string,
  limit: number = OBSERVATION_NEIGHBOR_LIMIT,
): Promise<ObservationNeighbor[]> {
  const findings = await getSimilarFindings(trackId, limit);

  const ranked = findings.flatMap((finding) =>
    finding.trackId && finding.logId ? [{ logId: finding.logId, trackId: finding.trackId }] : [],
  );

  if (ranked.length === 0) {
    return [];
  }

  const db = await getDb();
  const placeholders = ranked.map(() => "?").join(", ");
  const result = await db.execute({
    args: ranked.map((neighbor) => neighbor.trackId),
    sql: `select track_id, observation_script from findings
          where track_id in (${placeholders})
            and observation_script is not null and trim(observation_script) != ''`,
  });

  const scriptByTrackId = new Map<string, string>();

  for (const row of typedRows<{ observation_script: string | null; track_id: string }>(
    result.rows,
  )) {
    if (row.observation_script?.trim()) {
      scriptByTrackId.set(row.track_id, row.observation_script.trim());
    }
  }

  return ranked.flatMap((neighbor) => {
    const script = scriptByTrackId.get(neighbor.trackId);

    return script ? [{ logId: neighbor.logId, script }] : [];
  });
}
