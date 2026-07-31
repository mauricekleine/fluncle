import { getTableColumns, getTableName, type SQLiteTable } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { albums, artists, findings, labels, trackArtists, tracks } from "../../src/db/schema";
import {
  BANNED_DEVICE_COLUMN_PATTERNS,
  DEVICE_DB_COLUMNS,
  DEVICE_SOURCE_TABLES,
  DEVICE_SYNC_META_COLUMNS,
} from "./device-db-schema";

const LIVE_TABLES = [tracks, findings, artists, labels, albums, trackArtists] as const;

describe("device database column boundary", () => {
  it("names only the six ruled public source tables", () => {
    expect(DEVICE_SOURCE_TABLES).toEqual([
      "tracks",
      "findings",
      "artists",
      "labels",
      "albums",
      "track_artists",
    ]);
  });

  it("keeps every source column aligned with the live Drizzle schema", () => {
    const liveColumnsByTable = new Map(
      LIVE_TABLES.map((table) => [
        getTableName(table),
        new Set(Object.values(getTableColumns(table as SQLiteTable)).map((column) => column.name)),
      ]),
    );

    for (const table of DEVICE_SOURCE_TABLES) {
      const liveColumns = liveColumnsByTable.get(table);

      expect(liveColumns, `missing live schema table ${table}`).toBeDefined();

      for (const column of DEVICE_DB_COLUMNS[table]) {
        expect(liveColumns?.has(column), `${table}.${column} is absent from the live schema`).toBe(
          true,
        );
      }
    }
  });

  it("never allows a banned data-bearing column name onto a device", () => {
    const columns = [
      ...Object.entries(DEVICE_DB_COLUMNS).flatMap(([table, tableColumns]) =>
        tableColumns.map((column) => `${table}.${column}`),
      ),
      ...DEVICE_SYNC_META_COLUMNS.map((column) => `device_sync_meta.${column}`),
    ];

    for (const { name, pattern } of BANNED_DEVICE_COLUMN_PATTERNS) {
      expect(
        columns.filter((column) => pattern.test(column.split(".")[1] ?? "")),
        `${name} columns crossed the device boundary`,
      ).toEqual([]);
    }
  });
});
