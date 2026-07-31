import { DEVICE_DB_COLUMNS, type DeviceSourceTable } from "./device-db-schema";

export {
  DEVICE_DB_COLUMNS,
  DEVICE_DB_SCHEMA_VERSION,
  DEVICE_SOURCE_TABLES,
  DEVICE_SYNC_META_COLUMNS,
  type DeviceSourceTable,
} from "./device-db-schema";

export type DeviceDbCut = "anchored" | "certified" | "full";

export type DeviceDbIndex = {
  columns: readonly string[];
  name: string;
  table: DeviceSourceTable;
  unique?: boolean;
};

export type DeviceDbSqliteColumn = {
  cid: number;
  dflt_value: null | string;
  name: string;
  notnull: 0 | 1;
  pk: number;
  type: string;
};

export const DEVICE_DB_PRIMARY_KEYS: Record<DeviceSourceTable, readonly string[]> = {
  albums: ["id"],
  artists: ["id"],
  findings: ["track_id"],
  labels: ["id"],
  track_artists: ["track_id", "artist_id"],
  tracks: ["track_id"],
};

export const DEVICE_DB_INDEXES: readonly DeviceDbIndex[] = [
  { columns: ["album_id"], name: "device_tracks_album_id_idx", table: "tracks" },
  { columns: ["label_id"], name: "device_tracks_label_id_idx", table: "tracks" },
  { columns: ["is_catalogue"], name: "device_tracks_is_catalogue_idx", table: "tracks" },
  { columns: ["release_date"], name: "device_tracks_release_date_idx", table: "tracks" },
  {
    columns: ["log_id"],
    name: "device_findings_log_id_idx",
    table: "findings",
    unique: true,
  },
  { columns: ["added_at"], name: "device_findings_added_at_idx", table: "findings" },
  { columns: ["slug"], name: "device_artists_slug_idx", table: "artists", unique: true },
  { columns: ["slug"], name: "device_labels_slug_idx", table: "labels", unique: true },
  { columns: ["parent_label_id"], name: "device_labels_parent_id_idx", table: "labels" },
  { columns: ["slug"], name: "device_albums_slug_idx", table: "albums", unique: true },
  {
    columns: ["track_id"],
    name: "device_track_artists_track_id_idx",
    table: "track_artists",
  },
  {
    columns: ["artist_id"],
    name: "device_track_artists_artist_id_idx",
    table: "track_artists",
  },
];

export function quoteDeviceDbIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function declaredType(type: string, table: string, column: string): string {
  const normalized = type.trim().toUpperCase();

  if (normalized.includes("INT")) {
    return "INTEGER";
  }
  if (normalized.includes("CHAR") || normalized.includes("CLOB") || normalized.includes("TEXT")) {
    return "TEXT";
  }
  if (normalized.includes("REAL") || normalized.includes("FLOA") || normalized.includes("DOUB")) {
    return "REAL";
  }
  if (normalized === "" || normalized.includes("BLOB")) {
    return "BLOB";
  }
  if (normalized.includes("NUM") || normalized.includes("DEC") || normalized.includes("BOOL")) {
    return "NUMERIC";
  }

  throw new Error(`Unsupported declared type for ${table}.${column}: ${type}`);
}

export function createDeviceTableSql(
  table: DeviceSourceTable,
  sourceColumns: readonly DeviceDbSqliteColumn[],
): string {
  const byName = new Map(sourceColumns.map((column) => [column.name, column]));
  const definitions: string[] = [];

  for (const name of DEVICE_DB_COLUMNS[table]) {
    const column = byName.get(name);

    if (!column) {
      throw new Error(`Source column is missing: ${table}.${name}`);
    }

    definitions.push(
      `${quoteDeviceDbIdentifier(name)} ${declaredType(column.type, table, name)}${
        column.notnull === 1 ? " NOT NULL" : ""
      }`,
    );
  }

  const primaryKey = sourceColumns
    .filter(
      (column) => column.pk > 0 && DEVICE_DB_COLUMNS[table].some((name) => name === column.name),
    )
    .sort((left, right) => left.pk - right.pk)
    .map((column) => quoteDeviceDbIdentifier(column.name));

  if (primaryKey.length > 0) {
    definitions.push(`PRIMARY KEY (${primaryKey.join(", ")})`);
  }

  return `CREATE TABLE main.${quoteDeviceDbIdentifier(table)} (${definitions.join(", ")})`;
}

function selectedTracksCte(
  cut: DeviceDbCut,
  recEligibleWhere: string,
  sourceSchema: "main" | "source",
): string {
  const where =
    cut === "certified"
      ? "f.track_id is not null"
      : cut === "anchored"
        ? `f.track_id is not null or (${recEligibleWhere})`
        : `f.track_id is not null
           or (t.dismissed_at is null and t.duplicate_of_track_id is null)`;
  const schema = quoteDeviceDbIdentifier(sourceSchema);

  return `WITH selected_tracks(track_id) AS (
    SELECT t.track_id
    FROM ${schema}.${quoteDeviceDbIdentifier("tracks")} AS t
    LEFT JOIN ${schema}.${quoteDeviceDbIdentifier("findings")} AS f ON f.track_id = t.track_id
    WHERE ${where}
  )`;
}

function selectedSourceSql(
  table: DeviceSourceTable,
  cut: DeviceDbCut,
  recEligibleWhere: string,
  sourceSchema: "main" | "source",
): string {
  const cte = selectedTracksCte(cut, recEligibleWhere, sourceSchema);
  const schema = quoteDeviceDbIdentifier(sourceSchema);
  const sourceTable = `${schema}.${quoteDeviceDbIdentifier(table)}`;

  if (table === "tracks") {
    return `${cte}
      SELECT source_row.*
      FROM ${sourceTable} AS source_row
      JOIN selected_tracks selected ON selected.track_id = source_row.track_id`;
  }

  if (table === "findings" || table === "track_artists") {
    return `${cte}
      SELECT source_row.*
      FROM ${sourceTable} AS source_row
      JOIN selected_tracks selected ON selected.track_id = source_row.track_id`;
  }

  if (cut === "full") {
    return `SELECT source_row.* FROM ${sourceTable} AS source_row`;
  }

  if (table === "artists") {
    return `${cte}
      SELECT source_row.*
      FROM ${sourceTable} AS source_row
      WHERE source_row.id IN (
        SELECT track_artist.artist_id
        FROM ${schema}.${quoteDeviceDbIdentifier("track_artists")} AS track_artist
        JOIN selected_tracks selected ON selected.track_id = track_artist.track_id
      )`;
  }

  const pointer = table === "labels" ? "label_id" : "album_id";

  return `${cte}
    SELECT source_row.*
    FROM ${sourceTable} AS source_row
    WHERE source_row.id IN (
      SELECT track.${quoteDeviceDbIdentifier(pointer)}
      FROM ${schema}.${quoteDeviceDbIdentifier("tracks")} AS track
      JOIN selected_tracks selected ON selected.track_id = track.track_id
      WHERE track.${quoteDeviceDbIdentifier(pointer)} IS NOT NULL
    )`;
}

export function selectDeviceRowsSql(
  table: DeviceSourceTable,
  cut: DeviceDbCut,
  recEligibleWhere: string,
  sourceSchema: "main" | "source" = "source",
): string {
  const projection = DEVICE_DB_COLUMNS[table]
    .map((column) => `source_row.${quoteDeviceDbIdentifier(column)}`)
    .join(", ");
  const order = DEVICE_DB_PRIMARY_KEYS[table]
    .map((column) => `source_row.${quoteDeviceDbIdentifier(column)}`)
    .join(", ");
  const selectedSql = selectedSourceSql(table, cut, recEligibleWhere, sourceSchema).replace(
    "SELECT source_row.*",
    `SELECT ${projection}`,
  );

  return `${selectedSql}
    ORDER BY ${order}`;
}

export function insertDeviceTableSql(
  table: DeviceSourceTable,
  cut: DeviceDbCut,
  recEligibleWhere: string,
): string {
  const columns = DEVICE_DB_COLUMNS[table];

  return `INSERT INTO main.${quoteDeviceDbIdentifier(table)} (${columns
    .map(quoteDeviceDbIdentifier)
    .join(", ")})
    ${selectDeviceRowsSql(table, cut, recEligibleWhere)}`;
}
