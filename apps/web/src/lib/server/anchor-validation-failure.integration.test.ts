import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: () => Promise.resolve(db) };
});

beforeEach(async () => {
  db = await createIntegrationDb();
  await db.execute({
    args: ["mb_d99a706f-1e9f-4117-a800-3d2453af800c"],
    sql: `insert into tracks
          (track_id, title, artists_json, duration_ms, isrc, has_isrc,
           spotify_anchor_attempts)
          values (?, 'The Streets', '["DJ Chef"]', 301000, 'GBQXF1710012', 1, 5)`,
  });
});

describe("anchor candidate validation quarantine", () => {
  it("retires a repeated 400 from the worklist on the third receipt", async () => {
    const { recordAnchorValidationFailure } = await import("./anchor");
    const { listTrackWork } = await import("./track-work");
    const trackId = "mb_d99a706f-1e9f-4117-a800-3d2453af800c";
    expect((await listTrackWork({ kind: "anchor", limit: 1 }))[0]?.trackId).toBe(trackId);
    expect(await recordAnchorValidationFailure(trackId, 400)).toMatchObject({
      attempts: 1,
      terminal: false,
    });
    expect(await recordAnchorValidationFailure(trackId, 400)).toMatchObject({
      attempts: 2,
      terminal: false,
    });
    expect(await recordAnchorValidationFailure(trackId, 400)).toMatchObject({
      attempts: 3,
      terminal: true,
    });
    expect(await listTrackWork({ kind: "anchor", limit: 1 })).toEqual([]);
    const row = await db.execute({
      args: [trackId],
      sql: "select spotify_anchor_terminal_error from tracks where track_id = ?",
    });
    expect(row.rows[0]?.spotify_anchor_terminal_error).toBe("http_400");
    const { requeueAnchorStamps } = await import("./anchor");
    expect(await requeueAnchorStamps([trackId])).toBe(1);
    expect((await listTrackWork({ kind: "anchor", limit: 1 }))[0]?.trackId).toBe(trackId);
  });

  it("refuses to quarantine a retryable 503", async () => {
    const { recordAnchorValidationFailure } = await import("./anchor");
    const { listTrackWork } = await import("./track-work");
    const trackId = "mb_d99a706f-1e9f-4117-a800-3d2453af800c";
    await expect(recordAnchorValidationFailure(trackId, 503)).rejects.toThrow();
    expect((await listTrackWork({ kind: "anchor", limit: 1 }))[0]?.trackId).toBe(trackId);
  });

  it("selects only ISRC rows when quota is closed and only prior asks on throttle", async () => {
    const { listTrackWork } = await import("./track-work");
    const trackId = "mb_d99a706f-1e9f-4117-a800-3d2453af800c";
    await db.execute({
      args: [],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms)
            values ('mb_no_isrc', 'No ISRC', '["DJ Chef"]', 301000)`,
    });
    expect(
      (await listTrackWork({ kind: "anchor", limit: 10, paidMode: "quota" })).map(
        (row) => row.trackId,
      ),
    ).toEqual([trackId]);
    expect(await listTrackWork({ kind: "anchor", limit: 10, paidMode: "prior" })).toEqual([]);
    await db.execute({
      args: ["2026-09-25T07:32:42.975Z", trackId],
      sql: "update tracks set spotify_isrc_asked_at = ? where track_id = ?",
    });
    expect(
      (await listTrackWork({ kind: "anchor", limit: 10, paidMode: "prior" }))[0]?.trackId,
    ).toBe(trackId);
  });
});
