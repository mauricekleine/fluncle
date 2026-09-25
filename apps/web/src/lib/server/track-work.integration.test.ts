import { type Client, type InStatement } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
} from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

async function openCaptureBudget(): Promise<void> {
  const { setCatalogueCapturePaused } = await import("./capture-budget");

  await setCatalogueCapturePaused(false);
}

async function spendCatalogueCaptures(count: number, bytesEach = 1_000_000): Promise<void> {
  const at = new Date().toISOString();

  for (let index = 0; index < count; index += 1) {
    const trackId = `spent${String(index).padStart(17, "0")}`;

    await seedCatalogueTrack(db, { trackId });
    await db.execute({
      args: [at, at, bytesEach, trackId],
      sql: `update tracks
            set capture_status = 'done', source_audio_key = 'k/x.webm',
                source_audio_attempted_at = ?, source_audio_captured_at = ?,
                source_audio_bytes = ?
            where track_id = ?`,
    });
  }
}

async function withAudio(
  trackId: string,
  fields: { analyzedFrom?: "full" | "preview"; embedding?: boolean } = {},
): Promise<void> {
  await db.execute({
    args: [
      `${trackId}/sha.webm`,
      fields.analyzedFrom ?? null,
      fields.analyzedFrom ? "2026-07-01T00:00:00.000Z" : null,
      trackId,
    ],
    sql: `update tracks
          set source_audio_key = ?, analyzed_from = ?, analyzed_at = ?,
              capture_status = 'done'
          where track_id = ?`,
  });

  await seedEmbedding(
    db,
    trackId,
    fields.embedding ? Array.from({ length: 1024 }, () => 0.01) : null,
  );
}

async function withPriority(trackId: string, priority: number): Promise<void> {
  await db.execute({
    args: [priority, trackId],
    sql: `update tracks set capture_priority = ? where track_id = ?`,
  });
}

async function withWorkOrder(
  trackId: string,
  capturePriority: null | number,
  demandScore: null | number,
): Promise<void> {
  await db.execute({
    args: [capturePriority, demandScore, trackId],
    sql: `update tracks set capture_priority = ?, demand_score = ? where track_id = ?`,
  });
}

async function withCaptureSignals(
  trackId: string,
  fields: { analyzedFrom?: "full" | "preview"; bpm?: number; failures?: number },
): Promise<void> {
  await db.execute({
    args: [fields.bpm ?? null, fields.analyzedFrom ?? null, fields.failures ?? 0, trackId],
    sql: `update tracks
          set bpm = ?, analyzed_from = ?, source_audio_failures = ?
          where track_id = ?`,
  });
}

async function withArtistYoutubeChannel(trackId: string, channelId: string): Promise<void> {
  const artistId = `art-${trackId.slice(0, 8)}`;
  const at = "2026-07-01T00:00:00.000Z";

  await db.execute({
    args: [artistId, `Artist ${artistId}`, `artist-${artistId}`, at, at],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
          values (?, ?, ?, ?, ?)
          on conflict (id) do nothing`,
  });
  await db.execute({
    args: [trackId, artistId],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });
  await db.execute({
    args: [`soc-${artistId}`, artistId, `https://www.youtube.com/channel/${channelId}`, at, at],
    sql: `insert into artist_socials
            (id, artist_id, platform, source, status, url, created_at, updated_at)
          values (?, ?, 'youtube', 'operator', 'confirmed', ?, ?, ?)`,
  });
}

async function seedDisabledLabel(name: string, slug: string): Promise<void> {
  await db.execute({
    args: [`lbl-${slug}`, name, slug],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, 'disabled', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

async function seedEnabledLabel(name: string, slug: string): Promise<void> {
  await db.execute({
    args: [`lbl-${slug}`, name, slug],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, 'enabled', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

async function setIsrc(trackId: string, isrc: string): Promise<void> {
  await db.execute({
    args: [isrc, trackId],
    sql: `update tracks set isrc = ?, has_isrc = 1 where track_id = ?`,
  });
}

async function makeIsrcRecoveryCandidate(trackId: string): Promise<void> {
  await db.execute({
    args: [trackId],
    sql: `update tracks
          set spotify_uri = null, spotify_url = null, isrc = null, has_isrc = 0,
              duration_ms = 270000, dismissed_at = null, duplicate_of_track_id = null,
              isrc_recovery_attempted_at = null
          where track_id = ?`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("listTrackWork — the catalogue is workable", () => {
  it("reports whether an embed work item has waited over a day without exposing its identity", async () => {
    const { oldestQueuedEmbedCaptureOver24h } = await import("./track-work");
    const trackId = "cat0000000000000000000";
    await seedCatalogueTrack(db, { trackId });
    await withAudio(trackId);
    expect(await oldestQueuedEmbedCaptureOver24h()).toBe(false);
    await db.execute({
      args: [new Date(Date.now() - 60 * 60_000).toISOString(), trackId],
      sql: "update tracks set source_audio_captured_at = ? where track_id = ?",
    });
    expect(await oldestQueuedEmbedCaptureOver24h()).toBe(false);
    await db.execute({
      args: [new Date(Date.now() - 25 * 60 * 60_000).toISOString(), trackId],
      sql: "update tracks set source_audio_captured_at = ? where track_id = ?",
    });
    expect(await oldestQueuedEmbedCaptureOver24h()).toBe(true);
  });

  it("embeds a CATALOGUE track: finding-free tracks are work items", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { title: "Uncertified", trackId: "cat0000000000000000000" });
    await withAudio("cat0000000000000000000");

    const work = await listTrackWork({ kind: "embed" });

    expect(work.map((item) => item.trackId)).toEqual(["cat0000000000000000000"]);
    expect(work[0]?.certified).toBe(false);
    expect(work[0]?.logId).toBeNull();
  });

  it("analyses a CATALOGUE track, and drops it once analysed from the FULL song", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat0000000000000000000" });
    await withAudio("cat0000000000000000000");

    expect((await listTrackWork({ kind: "analyze" })).map((i) => i.trackId)).toEqual([
      "cat0000000000000000000",
    ]);

    await withAudio("cat0000000000000000000", { analyzedFrom: "full" });
    expect(await listTrackWork({ kind: "analyze" })).toEqual([]);

    await withAudio("cat0000000000000000000", { analyzedFrom: "preview" });
    expect((await listTrackWork({ kind: "analyze" })).map((i) => i.trackId)).toEqual([
      "cat0000000000000000000",
    ]);
  });

  it("never queues a track with no captured audio for analyze/embed", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat0000000000000000000" });

    expect(await listTrackWork({ kind: "analyze" })).toEqual([]);
    expect(await listTrackWork({ kind: "embed" })).toEqual([]);
  });

  it("honours the scope: findings-only, catalogue-only, or both", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat0000000000000000000" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withAudio("cat0000000000000000000");

    const ids = async (scope: "all" | "catalogue" | "findings") =>
      (await listTrackWork({ kind: "embed", scope })).map((item) => item.trackId);

    expect(await ids("findings")).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
    expect(await ids("catalogue")).toEqual(["cat0000000000000000000"]);
    expect(await ids("all")).toEqual(["aaaaaaaaaaaaaaaaaaaaaa", "cat0000000000000000000"]);
  });
});

describe("listTrackWork — the isrc-recovery pass", () => {
  it("selects only un-anchored, ISRC-less, verifiable catalogue rows", async () => {
    const { ISRC_RECOVERY_REASK_AFTER_DAYS, listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, {
      artists: ["Calibre"],
      title: "Even If",
      trackId: "eligible000000000000000",
    });
    await makeIsrcRecoveryCandidate("eligible000000000000000");

    await seedTrack(db, { logId: "004.7.2I", trackId: "finding0000000000000000" });
    await makeIsrcRecoveryCandidate("finding0000000000000000");

    await seedCatalogueTrack(db, { trackId: "anchored000000000000000" });

    await seedCatalogueTrack(db, { trackId: "withisrc000000000000000" });
    await makeIsrcRecoveryCandidate("withisrc000000000000000");
    await setIsrc("withisrc000000000000000", "GBBKS2400001");

    await seedCatalogueTrack(db, { trackId: "noduration0000000000000" });
    await makeIsrcRecoveryCandidate("noduration0000000000000");
    await db.execute({
      args: ["noduration0000000000000"],
      sql: `update tracks set duration_ms = 0 where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "dismissed00000000000000" });
    await makeIsrcRecoveryCandidate("dismissed00000000000000");
    await db.execute({
      args: ["dismissed00000000000000"],
      sql: `update tracks set dismissed_at = '2026-07-01T00:00:00.000Z' where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "duplicate00000000000000" });
    await makeIsrcRecoveryCandidate("duplicate00000000000000");
    await db.execute({
      args: ["eligible000000000000000", "duplicate00000000000000"],
      sql: `update tracks set duplicate_of_track_id = ? where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "recentask000000000000000" });
    await makeIsrcRecoveryCandidate("recentask000000000000000");
    await db.execute({
      args: [new Date().toISOString(), "recentask000000000000000"],
      sql: `update tracks set isrc_recovery_attempted_at = ? where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "staleask0000000000000000" });
    await makeIsrcRecoveryCandidate("staleask0000000000000000");
    await db.execute({
      args: [
        new Date(
          Date.now() - (ISRC_RECOVERY_REASK_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000,
        ).toISOString(),
        "staleask0000000000000000",
      ],
      sql: `update tracks set isrc_recovery_attempted_at = ? where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "sharedask000000000000000" });
    await makeIsrcRecoveryCandidate("sharedask000000000000000");
    await db.execute({
      args: [new Date().toISOString(), "sharedask000000000000000"],
      sql: `update tracks set isrc_attempted_at = ? where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "anchortried00000000000" });
    await makeIsrcRecoveryCandidate("anchortried00000000000");
    await db.execute({
      args: [new Date().toISOString(), "anchortried00000000000"],
      sql: `update tracks set spotify_anchor_attempted_at = ? where track_id = ?`,
    });

    expect(
      (await listTrackWork({ kind: "isrc-recovery" })).map((item) => item.trackId).sort(),
    ).toEqual(["eligible000000000000000", "sharedask000000000000000", "staleask0000000000000000"]);
  });

  it("drains a clean-empty box search until the dedicated re-ask window expires", async () => {
    const { recoverIsrcViaDeezer } = await import("./anchor");
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, {
      artists: ["Calibre"],
      title: "Even If",
      trackId: "cleanempty00000000000000",
    });
    await makeIsrcRecoveryCandidate("cleanempty00000000000000");

    expect((await listTrackWork({ kind: "isrc-recovery" })).map((item) => item.trackId)).toEqual([
      "cleanempty00000000000000",
    ]);

    await recoverIsrcViaDeezer("cleanempty00000000000000", db, ["Calibre"], "Even If", 270_000, []);

    expect(await listTrackWork({ kind: "isrc-recovery" })).toEqual([]);
  });

  it("applies the anchor queue's ruled-out-label veto", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedDisabledLabel("Outside Records", "outside-records");
    await seedCatalogueTrack(db, {
      label: "Outside Records",
      trackId: "vetoed0000000000000000",
    });
    await makeIsrcRecoveryCandidate("vetoed0000000000000000");
    await db.execute({
      args: ["lbl-outside-records", "vetoed0000000000000000"],
      sql: `update tracks set label_id = ? where track_id = ?`,
    });

    await seedCatalogueTrack(db, { trackId: "allowed0000000000000000" });
    await makeIsrcRecoveryCandidate("allowed0000000000000000");

    expect((await listTrackWork({ kind: "isrc-recovery" })).map((item) => item.trackId)).toEqual([
      "allowed0000000000000000",
    ]);
  });

  it("carries the server-owned Deezer query and no billed anchor query", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, {
      artists: ["Fred V & Grafix"],
      title: "Major Happy",
      trackId: "query000000000000000000",
    });
    await makeIsrcRecoveryCandidate("query000000000000000000");

    const [item] = await listTrackWork({ kind: "isrc-recovery" });

    expect(item?.deezerQuery).toBe("Fred V & Grafix Major Happy");
    expect(item?.anchorQuery).toBeUndefined();
  });

  it("has an explicit clause and can never fall through to the embed predicate", async () => {
    const { kindClause } = await import("./track-work");

    const recovery = kindClause("isrc-recovery");
    const embed = kindClause("embed");

    expect(recovery.sql).not.toBe(embed.sql);
    expect(recovery.args).toHaveLength(1);
    expect(recovery.sql).toContain("f.track_id is null");
    expect(recovery.sql).toContain("t.spotify_uri is null");
    expect(recovery.sql).toContain("t.has_isrc = 0");
    expect(recovery.sql).toContain("t.isrc_recovery_attempted_at");
    expect(recovery.sql).not.toContain("t.isrc_attempted_at");
    expect(recovery.sql).not.toContain("t.backfill_deezer_attempted_at");
    expect(recovery.sql).not.toContain("t.has_embedding = 0");
  });
});

describe("listTrackWork — the order is the budget", () => {
  it("returns the old query's identical sequence for every kind across NULLs and complete ties", async () => {
    const { kindClause, listTrackWork } = await import("./track-work");

    const legacyIds = async (
      kind:
        | "analyze"
        | "anchor"
        | "capture"
        | "embed"
        | "isrc-recovery"
        | "youtube-provenance"
        | "youtube-reverdict",
      limit: number,
    ): Promise<string[]> => {
      const kindWhere = kindClause(kind);
      const order =
        kind === "anchor" || kind === "isrc-recovery"
          ? `order by t.has_isrc desc,
              t.has_embedding desc,
              t.nearest_finding_score desc,
              t.track_id desc`
          : kind === "youtube-reverdict"
            ? "order by t.youtube_verified_at asc, t.track_id asc"
            : `order by (f.track_id is not null) desc,
                coalesce(t.capture_priority, 0) desc,
                ${
                  kind === "capture"
                    ? "(f.track_id is not null or t.spotify_uri is not null) desc,"
                    : ""
                }
                coalesce(t.demand_score, 0) desc,
                coalesce(f.added_at, '') desc,
                t.track_id desc`;
      const result = await db.execute({
        args: [...kindWhere.args, limit],
        sql: `select t.track_id
              from tracks t
              left join findings f on f.track_id = t.track_id
              where 1 = 1 and ${kindWhere.sql}
              ${order}
              limit ?`,
      });

      return result.rows.map((row) => {
        if (typeof row.track_id !== "string") {
          throw new Error("legacy track-work oracle returned a non-string track_id");
        }

        return row.track_id;
      });
    };

    await openCaptureBudget();

    const addedAt = "2026-01-01T00:00:00.000Z";
    const findingCaptureIds = ["finding-capture-a", "finding-capture-b"] as const;
    const findingAudioIds = ["finding-audio-a", "finding-audio-b"] as const;
    const findingReverdictIds = ["finding-reverdict-a", "finding-reverdict-b"] as const;
    const catalogueCaptureIds = ["catalogue-capture-a", "catalogue-capture-b"] as const;
    const catalogueAudioIds = ["catalogue-audio-a", "catalogue-audio-b"] as const;
    const catalogueReverdictIds = ["catalogue-reverdict-a", "catalogue-reverdict-b"] as const;

    for (const [index, trackId] of [
      ...findingCaptureIds,
      ...findingAudioIds,
      ...findingReverdictIds,
    ].entries()) {
      await seedTrack(db, { addedAt, logId: `004.7.${index + 1}A`, trackId });
    }

    for (const trackId of [
      ...catalogueCaptureIds,
      ...catalogueAudioIds,
      ...catalogueReverdictIds,
    ]) {
      await seedCatalogueTrack(db, { trackId });
    }

    for (const trackId of [...findingAudioIds, ...catalogueAudioIds]) {
      await withAudio(trackId);
    }

    for (const trackId of [...catalogueCaptureIds, ...catalogueReverdictIds]) {
      await makeIsrcRecoveryCandidate(trackId);
    }

    await db.execute({
      args: [
        `spotify:track:${catalogueCaptureIds[0]}`,
        `https://open.spotify.com/track/${catalogueCaptureIds[0]}`,
        catalogueCaptureIds[0],
      ],
      sql: `update tracks set spotify_uri = ?, spotify_url = ? where track_id = ?`,
    });

    for (const trackId of [...findingReverdictIds, ...catalogueReverdictIds]) {
      await db.execute({
        args: [`video-${trackId}`, trackId],
        sql: `update tracks
              set youtube_video_id = ?, youtube_video_official = 0, youtube_verified_at = null
              where track_id = ?`,
      });
    }

    const nullZeroPairs = [findingCaptureIds, findingAudioIds, findingReverdictIds];

    for (const [nullId, zeroId] of nullZeroPairs) {
      await withWorkOrder(nullId, null, null);
      await withWorkOrder(zeroId, 0, 0);
    }

    const cataloguePairs = [catalogueCaptureIds, catalogueReverdictIds];

    for (const [nullDemandId, zeroDemandId] of cataloguePairs) {
      await withWorkOrder(nullDemandId, 2, null);
      await withWorkOrder(zeroDemandId, 2, 0);
    }

    await withWorkOrder(catalogueAudioIds[0], null, null);
    await withWorkOrder(catalogueAudioIds[1], 0, 0);

    const shape = await db.execute(`select t.capture_priority, t.demand_score,
                                          (f.track_id is not null) as certified
                                   from tracks t
                                   left join findings f on f.track_id = t.track_id`);
    expect(shape.rows.some((row) => Number(row.certified) === 1)).toBe(true);
    expect(shape.rows.some((row) => Number(row.certified) === 0)).toBe(true);
    expect(shape.rows.some((row) => row.capture_priority === null)).toBe(true);
    expect(shape.rows.some((row) => row.capture_priority !== null)).toBe(true);
    expect(shape.rows.some((row) => row.demand_score === null)).toBe(true);
    expect(shape.rows.some((row) => row.demand_score !== null)).toBe(true);

    const anchors = await db.execute(`select t.spotify_uri
                                      from tracks t
                                      left join findings f on f.track_id = t.track_id
                                      where f.track_id is null and t.source_audio_key is null`);
    expect(anchors.rows.some((row) => row.spotify_uri === null)).toBe(true);
    expect(anchors.rows.some((row) => row.spotify_uri !== null)).toBe(true);

    const kinds = [
      "analyze",
      "anchor",
      "capture",
      "embed",
      "isrc-recovery",
      "youtube-provenance",
      "youtube-reverdict",
    ] as const;

    for (const kind of kinds) {
      for (const limit of [1, 2, 4, 5, 200]) {
        expect((await listTrackWork({ kind, limit })).map((item) => item.trackId)).toEqual(
          await legacyIds(kind, limit),
        );
      }
    }
  });

  it("seeks the catalogue capture ladder before sorting only its deep tie-breaks", async () => {
    const { listTrackWork } = await import("./track-work");

    await openCaptureBudget();
    await seedCatalogueTrack(db, { trackId: "catalogue-plan-candidate" });
    await withPriority("catalogue-plan-candidate", 2);

    const execute = vi.spyOn(db, "execute");

    try {
      await listTrackWork({ kind: "capture", scope: "catalogue" });

      const calls = execute.mock.calls as unknown as unknown[][];
      const statement = calls
        .map(([candidate]) => candidate)
        .find(
          (candidate): candidate is Exclude<InStatement, string> =>
            typeof candidate === "object" &&
            candidate !== null &&
            "sql" in candidate &&
            typeof candidate.sql === "string" &&
            candidate.sql.includes("f.log_id as log_id"),
        );

      expect(statement).toBeDefined();

      if (statement === undefined) {
        return;
      }

      const plan = await db.execute({
        args: statement.args ?? [],
        sql: `explain query plan ${statement.sql}`,
      });
      const details = plan.rows
        .map((row) => (typeof row.detail === "string" ? row.detail : ""))
        .join("\n");

      expect(details).toContain(
        "tracks_catalogue_capture_idx (is_catalogue=? AND dismissed_at=? AND capture_priority>?)",
      );
      expect(details).toContain("USE TEMP B-TREE FOR RIGHT PART OF ORDER BY");
      expect(details.split("\n")).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      execute.mockRestore();
    }
  });

  it("drains in capture_priority order, NOT insertion or alphabetical order", async () => {
    const { listTrackWork } = await import("./track-work");

    await openCaptureBudget();

    await seedCatalogueTrack(db, { title: "Aaa Nothing", trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { title: "Bbb Seed", trackId: "cat2000000000000000000" });
    await seedCatalogueTrack(db, { title: "Ccc Label", trackId: "cat3000000000000000000" });
    await seedCatalogueTrack(db, { title: "Ddd Artist", trackId: "cat4000000000000000000" });

    await withPriority("cat1000000000000000000", 0);
    await withPriority("cat2000000000000000000", 1);
    await withPriority("cat3000000000000000000", 2);
    await withPriority("cat4000000000000000000", 3);

    const work = await listTrackWork({ kind: "capture" });

    expect(work.map((item) => item.trackId)).toEqual([
      "cat4000000000000000000",
      "cat3000000000000000000",
      "cat2000000000000000000",
      "cat1000000000000000000",
    ]);
    expect(work.map((item) => item.capturePriority)).toEqual([3, 2, 1, 0]);
  });

  it("spends a tier's metered capture on its ANCHORED rows first", async () => {
    const { listTrackWork } = await import("./track-work");

    await openCaptureBudget();

    for (const trackId of [
      "cat1000000000000000000",
      "cat2000000000000000000",
      "cat3000000000000000000",
      "cat4000000000000000000",
    ]) {
      await seedCatalogueTrack(db, { trackId });
    }

    await withWorkOrder("cat4000000000000000000", 2, 0);
    await withWorkOrder("cat3000000000000000000", 2, 9);
    await withWorkOrder("cat2000000000000000000", 1, 0);
    await withWorkOrder("cat1000000000000000000", 1, 9);

    for (const trackId of ["cat3000000000000000000", "cat1000000000000000000"]) {
      await db.execute({
        args: [trackId],
        sql: `update tracks set spotify_uri = null, spotify_url = null where track_id = ?`,
      });
    }

    const work = await listTrackWork({ kind: "capture" });

    expect(work.map((item) => item.trackId)).toEqual([
      "cat4000000000000000000",
      "cat3000000000000000000",
      "cat2000000000000000000",
      "cat1000000000000000000",
    ]);
  });

  it("never hands a VETOED label to the capture queue — the money is never spent", async () => {
    const { listTrackWork } = await import("./track-work");
    const { rankCatalogue } = await import("./catalogue");

    await openCaptureBudget();

    await seedDisabledLabel("Anjunabeats", "anjunabeats");
    await seedTrack(db, {
      artists: ["Some Trance Act"],
      label: "Anjunabeats",
      logId: "004.7.2I",
      title: "The Crossover Remix",
      trackId: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    await seedCatalogueTrack(db, {
      artists: ["Another Trance Act"],
      label: "Anjunabeats",
      title: "More Trance",
      trackId: "cat1000000000000000000",
    });

    await seedEnabledLabel("Critical Music", "critical-music");
    await seedCatalogueTrack(db, {
      artists: ["Nobody We Know"],
      label: "Critical Music",
      title: "In Our Lane, Unproven",
      trackId: "cat2000000000000000000",
    });

    await rankCatalogue();

    const priorities = await db.execute(
      `select track_id, capture_priority from tracks where track_id like 'cat%' order by track_id`,
    );
    expect(priorities.rows.map((row) => Number(row.capture_priority))).toEqual([-1, 1]);

    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(work.map((item) => item.trackId)).toEqual(["cat2000000000000000000"]);
  });

  it("never hands an ISRC DUPLICATE to the capture queue — audio already owned is never re-bought", async () => {
    const { listTrackWork } = await import("./track-work");
    const { rankCatalogue } = await import("./catalogue");

    await openCaptureBudget();

    await seedTrack(db, {
      logId: "004.7.2I",
      title: "Infinity",
      trackId: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    await setIsrc("aaaaaaaaaaaaaaaaaaaaaa", "GBAYE1234567");
    await seedCatalogueTrack(db, { title: "Infinity (copy)", trackId: "cat1000000000000000000" });
    await setIsrc("cat1000000000000000000", "gb-aye-12-34567");

    await seedEnabledLabel("Critical Music", "critical-music");
    await seedCatalogueTrack(db, {
      artists: ["Nobody We Know"],
      label: "Critical Music",
      title: "A Real Candidate",
      trackId: "cat2000000000000000000",
    });

    await rankCatalogue();

    const priorities = await db.execute(
      `select track_id, capture_priority, duplicate_of_track_id from tracks
       where track_id like 'cat%' order by track_id`,
    );

    expect(priorities.rows.map((row) => Number(row.capture_priority))).toEqual([-2, 1]);
    expect(priorities.rows[0]?.duplicate_of_track_id).toBe("aaaaaaaaaaaaaaaaaaaaaa");

    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(work.map((item) => item.trackId)).toEqual(["cat2000000000000000000"]);
  });

  it("still MEASURES a vetoed track whose bytes are already bought", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { label: "Anjunabeats", trackId: "cat1000000000000000000" });
    await seedCatalogueTrack(db, { label: "Hospital", trackId: "cat2000000000000000000" });
    await withAudio("cat1000000000000000000");
    await withAudio("cat2000000000000000000");
    await withPriority("cat1000000000000000000", -1);
    await withPriority("cat2000000000000000000", 2);

    const work = await listTrackWork({ kind: "embed" });

    expect(work.map((item) => item.trackId)).toEqual([
      "cat2000000000000000000",
      "cat1000000000000000000",
    ]);
  });

  it("puts CERTIFIED work ahead of the whole catalogue — the telescope can never starve it", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "zzz1000000000000000000" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withAudio("zzz1000000000000000000");

    await withPriority("zzz1000000000000000000", 3);

    const work = await listTrackWork({ kind: "embed" });

    expect(work.map((item) => item.trackId)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaa",
      "zzz1000000000000000000",
    ]);
    expect(work.map((item) => item.certified)).toEqual([true, false]);
  });

  it("keeps an UNRANKED catalogue row out of the capture queue — rank first, then spend", async () => {
    const { listTrackWork } = await import("./track-work");

    await openCaptureBudget();

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });

    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);

    await withPriority("cat1000000000000000000", 1);
    expect((await listTrackWork({ kind: "capture", scope: "catalogue" })).length).toBe(1);
  });

  it("keeps a coordinate-less FINDING out of the capture queue (the R2 key needs a Log ID)", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: null, trackId: "aaaaaaaaaaaaaaaaaaaaaa" });

    expect(await listTrackWork({ kind: "capture", scope: "findings" })).toEqual([]);
  });

  it("drops a track from the capture queue once its capture is terminal", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    expect((await listTrackWork({ kind: "capture" })).length).toBe(1);

    for (const status of ["done", "unmatched"]) {
      await db.execute({
        args: [status],
        sql: `update tracks set capture_status = ? where track_id = 'aaaaaaaaaaaaaaaaaaaaaa'`,
      });
      expect(await listTrackWork({ kind: "capture" })).toEqual([]);
    }
  });
});

describe("listTrackWork — the wire", () => {
  it("carries only identity + the two facts a sweep acts on; no vector, no note", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, {
      artists: ["Krakota"],
      label: "Hospital",
      title: "See For Miles",
      trackId: "cat1000000000000000000",
    });
    await withAudio("cat1000000000000000000", { embedding: false });

    const [item] = await listTrackWork({ kind: "embed" });

    expect(item).toEqual({
      artists: ["Krakota"],
      capturePriority: null,
      certified: false,
      durationMs: 270_000,
      isrc: null,
      label: "Hospital",
      logId: null,
      sourceAudioKey: "cat1000000000000000000/sha.webm",
      title: "See For Miles",
      trackId: "cat1000000000000000000",
    });
  });

  it("carries the CAPTURE sweep's trust + re-derive signals — and ONLY on the capture worklist", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, {
      artists: ["Some Artist"],
      label: "Hospital",
      logId: "004.7.2I",
      title: "A Finding Needing Capture",
      trackId: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    await withCaptureSignals("aaaaaaaaaaaaaaaaaaaaaa", {
      analyzedFrom: "preview",
      bpm: 174,
      failures: 2,
    });
    await withArtistYoutubeChannel("aaaaaaaaaaaaaaaaaaaaaa", "UCr8ocLOaApCXWLjL7vdsgw");

    const [capture] = await listTrackWork({ kind: "capture" });

    expect(capture?.analyzedFrom).toBe("preview");
    expect(capture?.bpm).toBe(174);
    expect(capture?.sourceAudioFailures).toBe(2);
    expect(capture?.artistYoutubeChannelIds).toEqual(["UCr8ocLOaApCXWLjL7vdsgw"]);

    await withAudio("aaaaaaaaaaaaaaaaaaaaaa", { analyzedFrom: "preview" });

    for (const kind of ["analyze", "embed"] as const) {
      const [item] = await listTrackWork({ kind });

      expect(item?.trackId).toBe("aaaaaaaaaaaaaaaaaaaaaa");
      expect(item?.bpm).toBeUndefined();
      expect(item?.analyzedFrom).toBeUndefined();
      expect(item?.sourceAudioFailures).toBeUndefined();
      expect(item?.artistYoutubeChannelIds).toBeUndefined();
    }
  });

  it("carries the operator's CAPTURE-SOURCE PIN — on the capture worklist only, and a pinned row re-queued `pending` is served", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await db.execute({
      args: ["aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks set capture_status = 'unmatched' where track_id = ?`,
    });
    expect(await listTrackWork({ kind: "capture" })).toEqual([]);

    await db.execute({
      args: ["aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks set capture_status = 'pending', capture_source_pin = 'dQw4w9WgXcQ'
            where track_id = ?`,
    });

    const [capture] = await listTrackWork({ kind: "capture" });

    expect(capture?.trackId).toBe("aaaaaaaaaaaaaaaaaaaaaa");
    expect(capture?.captureSourcePin).toBe("dQw4w9WgXcQ");

    expect(capture?.captureSourcePinAllowDuration).toBeUndefined();

    await db.execute({
      args: ["aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks set capture_source_pin_allow_duration = 1 where track_id = ?`,
    });
    const [waived] = await listTrackWork({ kind: "capture" });
    expect(waived?.captureSourcePinAllowDuration).toBe(true);

    await withAudio("aaaaaaaaaaaaaaaaaaaaaa", { analyzedFrom: "preview" });

    for (const kind of ["analyze", "embed"] as const) {
      const [item] = await listTrackWork({ kind });

      expect(item?.trackId).toBe("aaaaaaaaaaaaaaaaaaaaaa");
      expect(item?.captureSourcePin).toBeUndefined();
      expect(item?.captureSourcePinAllowDuration).toBeUndefined();
    }
  });

  it("omits the capture signals when they are empty (a missing bpm / zero failures / no channel)", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });

    const [capture] = await listTrackWork({ kind: "capture" });

    expect(capture?.trackId).toBe("aaaaaaaaaaaaaaaaaaaaaa");
    expect(capture?.bpm).toBeUndefined();
    expect(capture?.analyzedFrom).toBeUndefined();
    expect(capture?.sourceAudioFailures).toBeUndefined();
    expect(capture?.artistYoutubeChannelIds).toBeUndefined();
    expect(capture?.captureSourcePin).toBeUndefined();
    expect(capture?.captureSourcePinAllowDuration).toBeUndefined();
  });

  it("drops an embedded track from the embed queue (idempotent by construction)", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000", { embedding: true });

    expect(await listTrackWork({ kind: "embed" })).toEqual([]);
  });
});

describe("listTrackWork — the capture budget stops the money", () => {
  it("PROOF 1 — the budget STOPS the sweep once it is spent", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCaptureBudget } = await import("./capture-budget");

    await openCaptureBudget();
    await setCatalogueCaptureBudget({ dailyBytes: 1024 * 1024 * 1024, dailyTracks: 3 });

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    expect((await listTrackWork({ kind: "capture", scope: "catalogue" })).length).toBe(1);

    await spendCatalogueCaptures(3);

    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });

  it("PROOF 1b — the BYTE cap stops it too, with count to spare", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCaptureBudget } = await import("./capture-budget");

    await openCaptureBudget();
    await setCatalogueCaptureBudget({ dailyBytes: 10_000_000, dailyTracks: 500 });

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    await spendCatalogueCaptures(2, 5_000_000);

    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });

  it("PROOF 2 — the kill switch stops it in ONE flip, and is DEFAULT-DENY", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCapturePaused } = await import("./capture-budget");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);

    await setCatalogueCapturePaused(false);
    expect((await listTrackWork({ kind: "capture", scope: "catalogue" })).length).toBe(1);

    await setCatalogueCapturePaused(true);
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });

  it("PROOF 3 — a CERTIFIED finding still captures when the catalogue budget is gone", async () => {
    const { listTrackWork } = await import("./track-work");
    const { setCatalogueCaptureBudget } = await import("./capture-budget");

    await openCaptureBudget();
    await setCatalogueCaptureBudget({ dailyBytes: 1, dailyTracks: 0 });

    await seedTrack(db, {
      logId: "004.7.2I",
      title: "A Real Banger",
      trackId: "aaaaaaaaaaaaaaaaaaaaaa",
    });
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    const work = await listTrackWork({ kind: "capture" });

    expect(work.map((item) => item.trackId)).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
    expect(work[0]?.certified).toBe(true);

    expect((await listTrackWork({ kind: "capture", scope: "findings" })).length).toBe(1);
  });

  it("PROOF 3b — and the same holds under the KILL SWITCH, not just a spent cap", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    expect((await listTrackWork({ kind: "capture" })).map((item) => item.trackId)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaa",
    ]);
  });

  it("gates CAPTURE alone — bytes already bought are free to analyse and embed", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");

    expect((await listTrackWork({ kind: "analyze" })).length).toBe(1);
    expect((await listTrackWork({ kind: "embed" })).length).toBe(1);
    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
  });
});

describe("countTrackWork — how big is the backlog, not how big is the page", () => {
  it("counts the WHOLE queue, past the page ceiling a read is capped at", async () => {
    const { countTrackWork, listTrackWork } = await import("./track-work");

    for (let index = 0; index < 12; index += 1) {
      const trackId = `cat${String(index).padStart(19, "0")}`;

      await seedCatalogueTrack(db, { trackId });
      await withAudio(trackId);
    }

    expect((await listTrackWork({ kind: "embed", limit: 5 })).length).toBe(5);
    expect(await countTrackWork({ kind: "embed" })).toBe(12);
  });

  it("counts the same predicate the page selects — an embedded track leaves both", async () => {
    const { countTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");
    await seedCatalogueTrack(db, { trackId: "cat2000000000000000000" });
    await withAudio("cat2000000000000000000", { embedding: true });

    expect(await countTrackWork({ kind: "embed" })).toBe(1);
  });

  it("honours the scope, so a run over one half reports that half's backlog", async () => {
    const { countTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");

    expect(await countTrackWork({ kind: "embed" })).toBe(2);
    expect(await countTrackWork({ kind: "embed", scope: "findings" })).toBe(1);
    expect(await countTrackWork({ kind: "embed", scope: "catalogue" })).toBe(1);
  });

  it("applies the SAME capture brake as the queue — it cannot advertise work the queue refuses", async () => {
    const { countTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withPriority("cat1000000000000000000", 3);

    expect(await countTrackWork({ kind: "capture", scope: "catalogue" })).toBe(0);
    expect(await countTrackWork({ kind: "capture" })).toBe(1);

    await openCaptureBudget();

    expect(await countTrackWork({ kind: "capture" })).toBe(2);
  });

  describe("dropping the un-read findings join changes no count", () => {
    async function joinedCount(
      kind: "analyze" | "capture" | "embed",
      scope: "all" | "catalogue" | "findings",
    ): Promise<number> {
      const { kindClause, scopeClause } = await import("./track-work");
      const kindWhere = kindClause(kind);
      const result = await db.execute({
        args: kindWhere.args,
        sql: `select count(*) as queued
              from tracks t
              left join findings f on f.track_id = t.track_id
              where ${scopeClause(scope)} and ${kindWhere.sql}`,
      });

      return Number(result.rows[0]?.queued ?? 0);
    }

    async function seedMixedArchive(): Promise<void> {
      const findingDone = "fdonennnnnnnnnnnnnnnnnn";
      await seedTrack(db, { logId: "004.7.2A", trackId: findingDone });
      await withAudio(findingDone, { analyzedFrom: "full", embedding: true });

      await seedTrack(db, { logId: "004.7.2B", trackId: "fnoaudionnnnnnnnnnnnnn" });

      const findingPreview = "fpreviewnnnnnnnnnnnnnn";
      await seedTrack(db, { logId: "004.7.2C", trackId: findingPreview });
      await withAudio(findingPreview, { analyzedFrom: "preview" });

      const catDone = "catdonennnnnnnnnnnnnnn";
      await seedCatalogueTrack(db, { trackId: catDone });
      await withAudio(catDone, { embedding: true });
      await withPriority(catDone, 3);

      const catRanked = "catrankednnnnnnnnnnnnn";
      await seedCatalogueTrack(db, { trackId: catRanked });
      await withPriority(catRanked, 2);

      const catVetoed = "catvetoednnnnnnnnnnnnn";
      await seedCatalogueTrack(db, { trackId: catVetoed });
      await withPriority(catVetoed, -1);

      await seedCatalogueTrack(db, { trackId: "catunrankednnnnnnnnnnn" });

      const catCaptured = "catcapturednnnnnnnnnnn";
      await seedCatalogueTrack(db, { trackId: catCaptured });
      await withAudio(catCaptured);
    }

    it("matches the always-joined count for every kind × scope on a mixed archive", async () => {
      const { countTrackWork } = await import("./track-work");

      await openCaptureBudget();
      await seedMixedArchive();

      const kinds = ["analyze", "capture", "embed"] as const;
      const scopes = ["all", "catalogue", "findings"] as const;

      for (const kind of kinds) {
        for (const scope of scopes) {
          expect(await countTrackWork({ kind, scope })).toBe(await joinedCount(kind, scope));
        }
      }

      expect(await countTrackWork({ kind: "embed", scope: "all" })).toBeGreaterThan(0);
      expect(await countTrackWork({ kind: "analyze", scope: "all" })).toBeGreaterThan(0);
      expect(await countTrackWork({ kind: "capture", scope: "findings" })).toBeGreaterThan(0);
      expect(await countTrackWork({ kind: "embed", scope: "catalogue" })).toBeGreaterThan(0);
    });
  });
});

describe("listTrackWork — the wrong-audio quarantine (docs/the-ear.md § Wrong audio)", () => {
  it("re-queues a wrong-audio row for capture, carrying its bad key, and keeps it out of embed/analyze", async () => {
    const { listTrackWork } = await import("./track-work");

    await openCaptureBudget();

    await seedCatalogueTrack(db, { title: "Find Your Love", trackId: "catwrong00000000000000" });
    await db.execute({
      args: ["catwrong00000000000000"],
      sql: `update tracks
            set capture_status = 'wrong-audio',
                capture_priority = 3,
                source_audio_key = 'catalogue/catwrong00000000000000/badbeef.webm'
            where track_id = ?`,
    });
    await seedEmbedding(db, "catwrong00000000000000", null);

    const capture = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(capture.map((item) => item.trackId)).toEqual(["catwrong00000000000000"]);
    expect(capture[0]?.sourceAudioKey).toBe("catalogue/catwrong00000000000000/badbeef.webm");

    expect(await listTrackWork({ kind: "embed", scope: "catalogue" })).toEqual([]);
    expect(await listTrackWork({ kind: "analyze", scope: "catalogue" })).toEqual([]);
  });

  it("a quarantine-cleared row leaves the capture queue and its kept audio re-embeds", async () => {
    const { listTrackWork } = await import("./track-work");

    await openCaptureBudget();

    await seedCatalogueTrack(db, { trackId: "catclear00000000000000" });
    await db.execute({
      args: ["catclear00000000000000"],
      sql: `update tracks
            set capture_status = 'quarantine-cleared',
                capture_priority = 3,
                source_audio_key = 'catalogue/catclear00000000000000/badbeef.webm'
            where track_id = ?`,
    });
    await seedEmbedding(db, "catclear00000000000000", null);

    expect(await listTrackWork({ kind: "capture", scope: "catalogue" })).toEqual([]);
    expect(
      (await listTrackWork({ kind: "embed", scope: "catalogue" })).map((item) => item.trackId),
    ).toEqual(["catclear00000000000000"]);
  });
});

async function withYoutubeProvenance(
  trackId: string,
  fields: { official?: null | number; verifiedAt?: null | string; videoId?: null | string },
): Promise<void> {
  await db.execute({
    args: [fields.videoId ?? null, fields.official ?? null, fields.verifiedAt ?? null, trackId],
    sql: `update tracks
          set youtube_video_id = ?, youtube_video_official = ?, youtube_verified_at = ?
          where track_id = ?`,
  });
}

describe("listTrackWork — the youtube-provenance backfill", () => {
  it("offers a CAPTURED row that holds no video id", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");

    expect(
      (await listTrackWork({ kind: "youtube-provenance" })).map((item) => item.trackId),
    ).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("never offers a row with NO captured audio — this is a backfill, not a second capture path", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });

    expect(await listTrackWork({ kind: "youtube-provenance" })).toEqual([]);
  });

  it("drops a row the moment it holds an id — fill-empty-only, expressed as a queue", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withYoutubeProvenance("aaaaaaaaaaaaaaaaaaaaaa", { videoId: "dQw4w9WgXcQ" });

    expect(await listTrackWork({ kind: "youtube-provenance" })).toEqual([]);
  });

  it("drops a row with banked SoundCloud evidence — its fingerprint proof is already settled", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await db.execute({
      args: ["soundcloud-preview-match", "aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks set source_verification = ? where track_id = ?`,
    });

    expect(await listTrackWork({ kind: "youtube-provenance" })).toEqual([]);
  });

  it("keeps a WRONG-AUDIO row out — its re-capture will report an id for free", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await db.execute({
      args: ["aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks set capture_status = 'wrong-audio' where track_id = ?`,
    });

    expect(await listTrackWork({ kind: "youtube-provenance" })).toEqual([]);
  });

  it("RETIRES A ROW AT THE CAN'T-CONCLUDE CAP — it is never re-served forever", async () => {
    const { listTrackWork, YOUTUBE_PROVENANCE_MAX_FAILURES } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await db.execute({
      args: [YOUTUBE_PROVENANCE_MAX_FAILURES - 1, "aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks set youtube_provenance_failures = ? where track_id = ?`,
    });

    expect(
      (await listTrackWork({ kind: "youtube-provenance" })).map((item) => item.trackId),
    ).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);

    await db.execute({
      args: [YOUTUBE_PROVENANCE_MAX_FAILURES, "aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks set youtube_provenance_failures = ? where track_id = ?`,
    });

    expect(await listTrackWork({ kind: "youtube-provenance" })).toEqual([]);
  });

  it("a NULL streak counts as zero, so nothing that never failed is retired by accident", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");

    expect(
      (await listTrackWork({ kind: "youtube-provenance" })).map((item) => item.trackId),
    ).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("HOLDS A RE-ASKED ROW OUT until the window is past — the ladder is not re-bought every tick", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withYoutubeProvenance("aaaaaaaaaaaaaaaaaaaaaa", {
      verifiedAt: new Date().toISOString(),
    });

    expect(await listTrackWork({ kind: "youtube-provenance" })).toEqual([]);
  });

  it("…and offers it again once the window HAS passed — a missing upload can appear later", async () => {
    const { listTrackWork, YOUTUBE_PROVENANCE_REASK_AFTER_DAYS } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withYoutubeProvenance("aaaaaaaaaaaaaaaaaaaaaa", {
      verifiedAt: new Date(
        Date.now() - (YOUTUBE_PROVENANCE_REASK_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    expect(
      (await listTrackWork({ kind: "youtube-provenance" })).map((item) => item.trackId),
    ).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("puts the FINDINGS ahead of the catalogue, newest first", async () => {
    const { listTrackWork } = await import("./track-work");

    await openCaptureBudget();
    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");
    await withPriority("cat1000000000000000000", 3);
    await seedTrack(db, {
      addedAt: "2026-06-01T00:00:00.000Z",
      logId: "004.7.2I",
      trackId: "oldfinding000000000000",
    });
    await withAudio("oldfinding000000000000");
    await seedTrack(db, {
      addedAt: "2026-07-01T00:00:00.000Z",
      logId: "005.7.2I",
      trackId: "newfinding000000000000",
    });
    await withAudio("newfinding000000000000");

    expect(
      (await listTrackWork({ kind: "youtube-provenance" })).map((item) => item.trackId),
    ).toEqual(["newfinding000000000000", "oldfinding000000000000", "cat1000000000000000000"]);
  });

  it("ANSWERS THE CAPTURE BRAKE — a shut budget serves no catalogue row here either", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");
    await withPriority("cat1000000000000000000", 3);
    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");

    expect(
      (await listTrackWork({ kind: "youtube-provenance", scope: "all" })).map(
        (item) => item.trackId,
      ),
    ).toEqual(["aaaaaaaaaaaaaaaaaaaaaa"]);
    expect(await listTrackWork({ kind: "youtube-provenance", scope: "catalogue" })).toEqual([]);
  });

  it("carries the ladder's trust + bad-audio-memory signals, because it runs that ladder", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");
    await withArtistYoutubeChannel("aaaaaaaaaaaaaaaaaaaaaa", "UCr8ocLOaApCXWLjL7vdsgw");
    await db.execute({
      args: ["aaaaaaaaaaaaaaaaaaaaaa"],
      sql: `update tracks
            set source_audio_rejected = '[{"videoId":"badId","sha256":"ff","reason":"fingerprint-mismatch","at":"2026-07-01T00:00:00.000Z"}]'
            where track_id = ?`,
    });

    const [item] = await listTrackWork({ kind: "youtube-provenance" });

    expect(item?.artistYoutubeChannelIds).toEqual(["UCr8ocLOaApCXWLjL7vdsgw"]);
    expect(item?.sourceAudioRejected).toContain("badId");

    expect(item?.bpm).toBeUndefined();
    expect(item?.analyzedFrom).toBeUndefined();
    expect(item?.sourceAudioFailures).toBeUndefined();
  });
});

describe("listTrackWork — the youtube-reverdict round-robin", () => {
  it("offers a row whose id was RULED 0, and one never ruled at all", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "refused000000000000000" });
    await withYoutubeProvenance("refused000000000000000", { official: 0, videoId: "vidA" });
    await seedTrack(db, { logId: "005.7.2I", trackId: "unchecked0000000000000" });
    await withYoutubeProvenance("unchecked0000000000000", { official: null, videoId: "vidB" });

    expect(
      (await listTrackWork({ kind: "youtube-reverdict" })).map((item) => item.trackId).sort(),
    ).toEqual(["refused000000000000000", "unchecked0000000000000"]);
  });

  it("NEVER offers a row already ruled OFFICIAL — the widening only says yes more often", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withYoutubeProvenance("aaaaaaaaaaaaaaaaaaaaaa", { official: 1, videoId: "vidA" });

    expect(await listTrackWork({ kind: "youtube-reverdict" })).toEqual([]);
  });

  it("never offers a row that holds no id — there is nothing to rule on", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");

    expect(await listTrackWork({ kind: "youtube-reverdict" })).toEqual([]);
  });

  it("orders OLDEST-RULED FIRST, with the never-ruled ahead of everything", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedTrack(db, { logId: "004.7.2I", trackId: "recent0000000000000000" });
    await withYoutubeProvenance("recent0000000000000000", {
      official: 0,
      verifiedAt: "2026-07-30T00:00:00.000Z",
      videoId: "vidA",
    });
    await seedTrack(db, { logId: "005.7.2I", trackId: "ancient000000000000000" });
    await withYoutubeProvenance("ancient000000000000000", {
      official: 0,
      verifiedAt: "2026-01-01T00:00:00.000Z",
      videoId: "vidB",
    });
    await seedTrack(db, { logId: "006.7.2I", trackId: "neverruled000000000000" });
    await withYoutubeProvenance("neverruled000000000000", { official: null, videoId: "vidC" });

    expect(
      (await listTrackWork({ kind: "youtube-reverdict" })).map((item) => item.trackId),
    ).toEqual(["neverruled000000000000", "ancient000000000000000", "recent0000000000000000"]);
  });

  it("carries NO brake — a keyless oEmbed read costs nothing to hold back", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withYoutubeProvenance("cat1000000000000000000", { official: 0, videoId: "vidA" });

    expect(
      (await listTrackWork({ kind: "youtube-reverdict", scope: "catalogue" })).map(
        (item) => item.trackId,
      ),
    ).toEqual(["cat1000000000000000000"]);
  });
});

describe("countTrackWork — the backfill queues report the same brake the page read applies", () => {
  it("counts the provenance backlog behind the SAME capture brake", async () => {
    const { countTrackWork } = await import("./track-work");

    await seedCatalogueTrack(db, { trackId: "cat1000000000000000000" });
    await withAudio("cat1000000000000000000");
    await withPriority("cat1000000000000000000", 3);
    await seedTrack(db, { logId: "004.7.2I", trackId: "aaaaaaaaaaaaaaaaaaaaaa" });
    await withAudio("aaaaaaaaaaaaaaaaaaaaaa");

    expect(await countTrackWork({ kind: "youtube-provenance", scope: "all" })).toBe(1);

    await openCaptureBudget();

    expect(await countTrackWork({ kind: "youtube-provenance", scope: "all" })).toBe(2);
  });
});
