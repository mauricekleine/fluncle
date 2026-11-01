import { type Client } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";
import {
  ALL_TRACK_OR_LOG_ID_MATCHES_CTE,
  bulkTrackOrLogIdCte,
  FINDING_TRACK_OR_LOG_ID_CTE,
  TRACK_OR_LOG_ID_CTE,
} from "./track-id-resolver";

const FINDING_TRACK = "findingTrack0000000001";
const FINDING_LOG = "004.7.2I";
const CATALOGUE_TRACK = "catalogueTrack00000001";
const SHADOWED_FINDING_TRACK = "shadowedFinding0000001";
const COLLIDING_TOKEN = "009.1.1A";

let db: Client;

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected a string column, got ${typeof value}`);
  }

  return value;
}

beforeAll(async () => {
  db = await createIntegrationDb();
  await seedTrack(db, { logId: FINDING_LOG, trackId: FINDING_TRACK });
  await seedCatalogueTrack(db, { trackId: CATALOGUE_TRACK });
  await seedTrack(db, { logId: COLLIDING_TOKEN, trackId: SHADOWED_FINDING_TRACK });
  await seedCatalogueTrack(db, { trackId: COLLIDING_TOKEN });
});

async function resolveOne(cte: string, token: string): Promise<string[]> {
  const result = await db.execute({
    args: [token, token, token],
    sql: `with ${cte} select track_id from resolved_track`,
  });

  return result.rows.map((row) => text(row.track_id));
}

async function resolveAll(token: string): Promise<string[]> {
  const result = await db.execute({
    args: [token, token, token],
    sql: `with ${ALL_TRACK_OR_LOG_ID_MATCHES_CTE} select track_id from resolved_tracks order by track_id`,
  });

  return result.rows.map((row) => text(row.track_id));
}

async function resolveBulk(tokens: string[]): Promise<Array<[string, string | null]>> {
  const result = await db.execute({
    args: tokens,
    sql: `with ${bulkTrackOrLogIdCte(tokens.length)} select track_id, log_id from resolved_tracks order by track_id`,
  });

  return result.rows.map((row) => [
    text(row.track_id),
    row.log_id === null ? null : text(row.log_id),
  ]);
}

describe("TRACK_OR_LOG_ID_CTE", () => {
  it("resolves a track id to itself, catalogue rows included", async () => {
    expect(await resolveOne(TRACK_OR_LOG_ID_CTE, FINDING_TRACK)).toEqual([FINDING_TRACK]);
    expect(await resolveOne(TRACK_OR_LOG_ID_CTE, CATALOGUE_TRACK)).toEqual([CATALOGUE_TRACK]);
  });

  it("resolves a log id to its finding's track", async () => {
    expect(await resolveOne(TRACK_OR_LOG_ID_CTE, FINDING_LOG)).toEqual([FINDING_TRACK]);
  });

  it("resolves an unknown token to nothing", async () => {
    expect(await resolveOne(TRACK_OR_LOG_ID_CTE, "nope")).toEqual([]);
  });

  it("prefers the track id when a token is both a track id and another finding's log id", async () => {
    expect(await resolveOne(TRACK_OR_LOG_ID_CTE, COLLIDING_TOKEN)).toEqual([COLLIDING_TOKEN]);
  });
});

describe("FINDING_TRACK_OR_LOG_ID_CTE", () => {
  it("resolves a finding's track id and its log id to the same finding", async () => {
    expect(await resolveOne(FINDING_TRACK_OR_LOG_ID_CTE, FINDING_TRACK)).toEqual([FINDING_TRACK]);
    expect(await resolveOne(FINDING_TRACK_OR_LOG_ID_CTE, FINDING_LOG)).toEqual([FINDING_TRACK]);
  });

  it("never resolves a catalogue track id", async () => {
    expect(await resolveOne(FINDING_TRACK_OR_LOG_ID_CTE, CATALOGUE_TRACK)).toEqual([]);
  });

  it("lets a log id win over a catalogue row that shares its spelling", async () => {
    expect(await resolveOne(FINDING_TRACK_OR_LOG_ID_CTE, COLLIDING_TOKEN)).toEqual([
      SHADOWED_FINDING_TRACK,
    ]);
  });
});

describe("ALL_TRACK_OR_LOG_ID_MATCHES_CTE", () => {
  it("returns both the track and the finding when a token matches each", async () => {
    expect(await resolveAll(COLLIDING_TOKEN)).toEqual([COLLIDING_TOKEN, SHADOWED_FINDING_TRACK]);
  });

  it("returns a finding's track once when the token is its own track id", async () => {
    expect(await resolveAll(FINDING_TRACK)).toEqual([FINDING_TRACK]);
  });

  it("returns a finding's track for its log id", async () => {
    expect(await resolveAll(FINDING_LOG)).toEqual([FINDING_TRACK]);
  });
});

describe("bulkTrackOrLogIdCte", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an input count of %s",
    (count) => {
      expect(() => bulkTrackOrLogIdCte(count)).toThrow(
        "bulk track resolver requires at least one input",
      );
    },
  );

  it("binds exactly one placeholder per input", () => {
    for (const count of [1, 2, 7]) {
      expect(bulkTrackOrLogIdCte(count).match(/\?/g)).toHaveLength(count);
    }
  });

  it("resolves mixed track ids and log ids, carrying each finding's log id", async () => {
    expect(await resolveBulk([CATALOGUE_TRACK, FINDING_LOG, "nope"])).toEqual([
      [CATALOGUE_TRACK, null],
      [FINDING_TRACK, FINDING_LOG],
    ]);
  });

  it("returns a finding once when both its track id and its log id are inputs", async () => {
    expect(await resolveBulk([FINDING_TRACK, FINDING_LOG])).toEqual([[FINDING_TRACK, FINDING_LOG]]);
  });

  it("prefers the track id when a token is both a track id and another finding's log id", async () => {
    expect(await resolveBulk([COLLIDING_TOKEN])).toEqual([[COLLIDING_TOKEN, null]]);
  });
});
