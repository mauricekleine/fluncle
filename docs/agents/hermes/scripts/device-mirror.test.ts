import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMirrorStatement,
  main,
  planDeviceMirrorDiff,
  type DeviceRow,
  type DeviceRowSets,
  type MirrorOperation,
} from "./device-mirror";
import { DEVICE_DB_COLUMNS } from "./device-db-derivation";

const MIRROR_ENV_NAMES = [
  "DEVICE_MIRROR_LOCK_DIR",
  "DEVICE_TURSO_AUTH_TOKEN",
  "DEVICE_TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_URL",
] as const;
const originalEnv = Object.fromEntries(
  MIRROR_ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof MIRROR_ENV_NAMES)[number], string | undefined>;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const name of MIRROR_ENV_NAMES) {
    const value = originalEnv[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function rowSets(overrides: Partial<DeviceRowSets> = {}): DeviceRowSets {
  return {
    albums: [],
    artists: [],
    findings: [],
    labels: [],
    track_artists: [],
    tracks: [],
    ...overrides,
  };
}

function textCell(value: DeviceRow[string]): string {
  if (typeof value !== "string") {
    throw new Error("Expected a text primary-key cell");
  }

  return value;
}

function operationId(operation: MirrorOperation): string {
  const key =
    operation.table === "track_artists"
      ? `${textCell(operation.row.track_id)}/${textCell(operation.row.artist_id)}`
      : textCell(
          operation.row[
            operation.table === "tracks" || operation.table === "findings" ? "track_id" : "id"
          ],
        );

  return `${operation.kind}:${operation.table}:${key}`;
}

describe("planDeviceMirrorDiff", () => {
  test("classifies new, changed, deleted, and unchanged rows by primary key and full tuple", () => {
    const stable: DeviceRow = { title: "Stable", track_id: "track-stable" };
    const changedBefore: DeviceRow = { title: "Before", track_id: "track-changed" };
    const changedAfter: DeviceRow = { title: "After", track_id: "track-changed" };
    const added: DeviceRow = { title: "Added", track_id: "track-added" };
    const departed: DeviceRow = { title: "Departed", track_id: "track-departed" };

    const plan = planDeviceMirrorDiff(
      rowSets({ tracks: [stable, changedAfter, added] }),
      rowSets({ tracks: [stable, changedBefore, departed] }),
    );

    expect(plan.tables.tracks.newRows).toEqual([added]);
    expect(plan.tables.tracks.changedRows).toEqual([changedAfter]);
    expect(plan.tables.tracks.deletedRows).toEqual([departed]);
    expect(plan.tables.tracks.unchangedRows).toEqual([stable]);
    expect(plan.operations.map(operationId)).toEqual([
      "delete:tracks:track-departed",
      "upsert:tracks:track-added",
      "upsert:tracks:track-changed",
    ]);
  });

  test("orders every dependent-first delete before every parent-first upsert", () => {
    const source = rowSets({
      albums: [{ id: "album-new" }],
      artists: [{ id: "artist-new" }],
      findings: [{ log_id: "002.1.1A", track_id: "track-new" }],
      labels: [{ id: "label-new" }],
      track_artists: [
        { artist_id: "artist-new", position: 0, role: "primary", track_id: "track-new" },
      ],
      tracks: [
        { title: "Changed", track_id: "track-changed" },
        { title: "New", track_id: "track-new" },
      ],
    });
    const target = rowSets({
      albums: [{ id: "album-old" }],
      artists: [{ id: "artist-old" }],
      findings: [{ log_id: "001.1.1A", track_id: "track-old" }],
      labels: [{ id: "label-old" }],
      track_artists: [
        { artist_id: "artist-old", position: 0, role: "primary", track_id: "track-old" },
      ],
      tracks: [
        { title: "Before", track_id: "track-changed" },
        { title: "Old", track_id: "track-old" },
      ],
    });

    expect(planDeviceMirrorDiff(source, target).operations.map(operationId)).toEqual([
      "delete:track_artists:track-old/artist-old",
      "delete:findings:track-old",
      "delete:tracks:track-old",
      "delete:artists:artist-old",
      "delete:labels:label-old",
      "delete:albums:album-old",
      "upsert:albums:album-new",
      "upsert:artists:artist-new",
      "upsert:labels:label-new",
      "upsert:tracks:track-changed",
      "upsert:tracks:track-new",
      "upsert:findings:track-new",
      "upsert:track_artists:track-new/artist-new",
    ]);
  });

  test("rejects duplicate primary keys instead of silently planning an ambiguous snapshot", () => {
    const duplicate = { title: "First", track_id: "same-key" };

    expect(() =>
      planDeviceMirrorDiff(
        rowSets({ tracks: [duplicate, { ...duplicate, title: "Second" }] }),
        rowSets(),
      ),
    ).toThrow("Duplicate tracks primary key");
  });
});

describe("buildMirrorStatement", () => {
  test("binds every upsert value as a parameter", () => {
    const statement = buildMirrorStatement({
      kind: "upsert",
      row: { title: "A value that must never enter SQL", track_id: "track-1" },
      table: "tracks",
    });

    expect(statement.sql).toContain("ON CONFLICT");
    expect(statement.sql).not.toContain("A value that must never enter SQL");
    expect(statement.args?.[0]).toBe("track-1");
    expect(statement.args).toHaveLength(DEVICE_DB_COLUMNS.tracks.length);
  });

  test("binds every composite delete key as a parameter", () => {
    const statement = buildMirrorStatement({
      kind: "delete",
      row: { artist_id: "artist-1", track_id: "track-1" },
      table: "track_artists",
    });

    expect(statement.sql).toContain('"track_id" = ? AND "artist_id" = ?');
    expect(statement.args).toEqual(["track-1", "artist-1"]);
  });
});

describe("mirror ledger summary", () => {
  test("derives ok from the error count and leaves unmeasured drift unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "device-mirror-test-"));
    temporaryDirectories.push(directory);
    process.env.DEVICE_MIRROR_LOCK_DIR = join(directory, "lock");
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.DEVICE_TURSO_DATABASE_URL;
    delete process.env.DEVICE_TURSO_AUTH_TOKEN;

    const stdout = console.log;
    const stderr = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
      const summary = await main();

      expect(summary.errors).toBe(1);
      expect(summary.ok).toBe(false);
      expect(summary.driftMeasured).toBe(false);
      expect(summary.queueDepth).toBeNull();
    } finally {
      console.log = stdout;
      console.error = stderr;
    }
  });
});
