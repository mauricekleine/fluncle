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

export type DeviceDbClosureCheck = {
  edge: string;
  sql: string;
};

export const DEVICE_SELECTED_TRACKS_TABLE = "device_selected_track_ids";

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

function selectedTracksWhere(cut: DeviceDbCut, recEligibleWhere: string): string {
  if (cut === "certified") {
    return "f.track_id is not null";
  }
  if (cut === "anchored") {
    return `f.track_id is not null or (${recEligibleWhere})`;
  }

  return `f.track_id is not null
    or (t.dismissed_at is null and t.duplicate_of_track_id is null)`;
}

/**
 * Build the anchored-ID relation once. Every corpus copy query below reads this TEMP table and
 * therefore cannot accidentally re-run the growing recommendation-eligibility scan.
 */
export function materializeSelectedTrackIdsSql(
  cut: DeviceDbCut,
  recEligibleWhere: string,
  sourceSchema: "main" | "source" = "source",
): readonly string[] {
  const schema = quoteDeviceDbIdentifier(sourceSchema);
  const selected = quoteDeviceDbIdentifier(DEVICE_SELECTED_TRACKS_TABLE);

  return [
    `CREATE TEMP TABLE ${selected} (
      ${quoteDeviceDbIdentifier("track_id")} TEXT NOT NULL PRIMARY KEY
    ) WITHOUT ROWID`,
    `INSERT INTO temp.${selected} (${quoteDeviceDbIdentifier("track_id")})
      SELECT t.${quoteDeviceDbIdentifier("track_id")}
      FROM ${schema}.${quoteDeviceDbIdentifier("tracks")} AS t
      LEFT JOIN ${schema}.${quoteDeviceDbIdentifier("findings")} AS f
        ON f.track_id = t.track_id
      LEFT JOIN ${schema}.${quoteDeviceDbIdentifier("track_embeddings")} AS emb
        ON emb.track_id = t.track_id
      WHERE ${selectedTracksWhere(cut, recEligibleWhere)}
      ORDER BY t.${quoteDeviceDbIdentifier("track_id")}`,
  ];
}

function selectedSourceSql(
  table: DeviceSourceTable,
  cut: DeviceDbCut,
  sourceSchema: "main" | "source",
): string {
  const schema = quoteDeviceDbIdentifier(sourceSchema);
  const sourceTable = `${schema}.${quoteDeviceDbIdentifier(table)}`;
  const selected = `temp.${quoteDeviceDbIdentifier(DEVICE_SELECTED_TRACKS_TABLE)}`;

  if (table === "tracks" || table === "findings" || table === "track_artists") {
    return `SELECT source_row.*
      FROM ${sourceTable} AS source_row
      JOIN ${selected} AS selected ON selected.track_id = source_row.track_id`;
  }

  if (cut === "full") {
    return `SELECT source_row.* FROM ${sourceTable} AS source_row`;
  }

  if (table === "artists") {
    return `SELECT source_row.*
      FROM ${sourceTable} AS source_row
      WHERE source_row.id IN (
        SELECT track_artist.artist_id
        FROM ${schema}.${quoteDeviceDbIdentifier("track_artists")} AS track_artist
        JOIN ${selected} AS selected ON selected.track_id = track_artist.track_id
      )`;
  }

  if (table === "labels") {
    // The parent pointer ships, so its complete ancestry must ship as well. UNION (not UNION ALL)
    // both deduplicates shared ancestry and terminates a malformed parent cycle deterministically.
    return `WITH RECURSIVE selected_labels(id) AS (
        SELECT track.label_id
        FROM ${schema}.${quoteDeviceDbIdentifier("tracks")} AS track
        JOIN ${selected} AS selected ON selected.track_id = track.track_id
        WHERE track.label_id IS NOT NULL
        UNION
        SELECT label.parent_label_id
        FROM ${schema}.${quoteDeviceDbIdentifier("labels")} AS label
        JOIN selected_labels AS child ON child.id = label.id
        WHERE label.parent_label_id IS NOT NULL
      )
      SELECT source_row.*
      FROM ${sourceTable} AS source_row
      JOIN selected_labels AS selected_label ON selected_label.id = source_row.id`;
  }

  return `SELECT source_row.*
    FROM ${sourceTable} AS source_row
    WHERE source_row.id IN (
      SELECT track.album_id
      FROM ${schema}.${quoteDeviceDbIdentifier("tracks")} AS track
      JOIN ${selected} AS selected ON selected.track_id = track.track_id
      WHERE track.album_id IS NOT NULL
    )`;
}

export function selectDeviceRowsSql(
  table: DeviceSourceTable,
  cut: DeviceDbCut,
  sourceSchema: "main" | "source" = "source",
): string {
  const projection = DEVICE_DB_COLUMNS[table]
    .map((column) => `source_row.${quoteDeviceDbIdentifier(column)}`)
    .join(", ");
  const order = DEVICE_DB_PRIMARY_KEYS[table]
    .map((column) => `source_row.${quoteDeviceDbIdentifier(column)}`)
    .join(", ");
  const selectedSql = selectedSourceSql(table, cut, sourceSchema).replace(
    "SELECT source_row.*",
    `SELECT ${projection}`,
  );

  return `${selectedSql}
    ORDER BY ${order}`;
}

export function insertDeviceTableSql(table: DeviceSourceTable, cut: DeviceDbCut): string {
  const columns = DEVICE_DB_COLUMNS[table];

  return `INSERT INTO main.${quoteDeviceDbIdentifier(table)} (${columns
    .map(quoteDeviceDbIdentifier)
    .join(", ")})
    ${selectDeviceRowsSql(table, cut)}`;
}

/** Every pointer copied into the public artifact has a matching copied destination row. */
export function deviceDbClosureChecksSql(schemaName = "main"): readonly DeviceDbClosureCheck[] {
  const schema = quoteDeviceDbIdentifier(schemaName);
  const table = (name: DeviceSourceTable) => `${schema}.${quoteDeviceDbIdentifier(name)}`;

  return [
    {
      edge: "findings.track_id -> tracks.track_id",
      sql: `SELECT count(*) AS count FROM ${table("findings")} AS child
        LEFT JOIN ${table("tracks")} AS parent ON parent.track_id = child.track_id
        WHERE parent.track_id IS NULL`,
    },
    {
      edge: "track_artists.track_id -> tracks.track_id",
      sql: `SELECT count(*) AS count FROM ${table("track_artists")} AS child
        LEFT JOIN ${table("tracks")} AS parent ON parent.track_id = child.track_id
        WHERE parent.track_id IS NULL`,
    },
    {
      edge: "track_artists.artist_id -> artists.id",
      sql: `SELECT count(*) AS count FROM ${table("track_artists")} AS child
        LEFT JOIN ${table("artists")} AS parent ON parent.id = child.artist_id
        WHERE parent.id IS NULL`,
    },
    {
      edge: "tracks.album_id -> albums.id",
      sql: `SELECT count(*) AS count FROM ${table("tracks")} AS child
        LEFT JOIN ${table("albums")} AS parent ON parent.id = child.album_id
        WHERE child.album_id IS NOT NULL AND parent.id IS NULL`,
    },
    {
      edge: "tracks.label_id -> labels.id",
      sql: `SELECT count(*) AS count FROM ${table("tracks")} AS child
        LEFT JOIN ${table("labels")} AS parent ON parent.id = child.label_id
        WHERE child.label_id IS NOT NULL AND parent.id IS NULL`,
    },
    {
      edge: "labels.parent_label_id -> labels.id",
      sql: `SELECT count(*) AS count FROM ${table("labels")} AS child
        LEFT JOIN ${table("labels")} AS parent ON parent.id = child.parent_label_id
        WHERE child.parent_label_id IS NOT NULL AND parent.id IS NULL`,
    },
  ];
}
