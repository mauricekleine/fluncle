import { type Client } from "@libsql/client";
import { getScaleManifest } from "./manifest";

export async function applyHotPageStatistics(client: Client): Promise<void> {
  const counts = getScaleManifest("1x").counts;
  const tableCounts: Record<string, number> = {
    albums: counts.albums,
    artists: counts.artists,
    findings: counts.findings,
    labels: counts.labels,
    track_artists: counts.trackArtists,
    tracks: counts.tracks,
  };
  const distinct: Record<string, number> = {
    album_id: counts.albums,
    artist_id: counts.artists,
    dismissed_at: 1,
    duplicate_of_track_id: 1,
    is_catalogue: 2,
    label_id: counts.labels,
    release_date: 3650,
  };
  await client.execute("ANALYZE sqlite_schema");
  await client.execute("DELETE FROM sqlite_stat1");
  const statements = [];
  for (const [table, count] of Object.entries(tableCounts)) {
    const indexes = await client.execute({
      args: [table],
      sql: "SELECT name FROM pragma_index_list(?)",
    });
    for (const index of indexes.rows) {
      if (typeof index.name !== "string") {
        throw new Error("index inventory has no name");
      }
      const name = index.name;
      const columns = await client.execute({
        args: [name],
        sql: "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
      });
      let rowsPerPrefix = count;
      const prefixCounts = columns.rows.map((column) => {
        const columnName = typeof column.name === "string" ? column.name : "";
        const cardinality = /^(?:id|track_id|slug|spotify_uri|log_id)$/.test(columnName)
          ? count
          : (distinct[columnName] ?? 10);
        rowsPerPrefix = Math.max(1, Math.ceil(rowsPerPrefix / cardinality));
        return rowsPerPrefix;
      });
      statements.push({
        args: [table, name, [count, ...prefixCounts].join(" ")],
        sql: "INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES (?, ?, ?)",
      });
    }
  }
  await client.batch(statements, "write");
  await client.execute("ANALYZE sqlite_schema");
}
