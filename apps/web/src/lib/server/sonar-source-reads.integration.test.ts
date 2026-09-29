import { type Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_VECTOR_BYTES,
  artifactContract,
  listArtifactSnapshot,
  registerArtifactConsumer,
} from "./artifact-changes";
import { createIntegrationDb, seedEmbedding, seedTrack } from "./integration-db";
import {
  buildSonarCentroidDigestStatement,
  buildSonarTrackDigestStatement,
  listSonarCentroidDigests,
  listSonarCentroids,
  listSonarTrackDigests,
  listSonarTracks,
  sonarCentroidDigest,
} from "./sonar-source-reads";

type CentroidFixture = {
  artistId: string;
  blobBase64: string;
  digest: string;
  name: string;
};

const CENTROID_FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../../sonar/tests/fixtures/sonar-centroid-digests.json", import.meta.url),
    "utf8",
  ),
) as CentroidFixture[];

const SERVABLE_CENTROID_FIXTURES = CENTROID_FIXTURES.filter(
  (fixture) => atob(fixture.blobBase64).length === ARTIFACT_VECTOR_BYTES,
);

let db: Client;
let directory: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fluncle-sonar-source-"));
  db = await createIntegrationDb({ url: `file:${join(directory, "fixture.db")}` });
});

afterEach(async () => {
  db.close();

  if (directory !== undefined) {
    await rm(directory, { force: true, recursive: true });
    directory = undefined;
  }
});

async function seedTrackSource(ids: string[]): Promise<void> {
  for (const [index, trackId] of ids.entries()) {
    await seedTrack(db, { logId: `${index}.A.AA`, trackId });
    await seedEmbedding(
      db,
      trackId,
      Array.from({ length: 1024 }, () => index / 16),
    );
  }
}

async function seedCentroid(fixture: CentroidFixture): Promise<void> {
  await db.execute({
    args: [
      fixture.artistId,
      Uint8Array.from(atob(fixture.blobBase64), (char) => char.charCodeAt(0)),
    ],
    sql: `insert into artist_centroids
      (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
      values (?, ?, '2026-01-01', 'all', 1)`,
  });
}

describe("Sonar Worker source reads", () => {
  it("returns the exact fenced snapshot material and latest revision", async () => {
    await seedTrackSource(["track:a", "track:b", "track:c"]);
    await db.execute({
      args: [1, "track:a"],
      sql: `insert into artifact_change_revisions
        (content_digest, created_at, event_seq, producer, revision, stream, stream_version, subject_id, subject_type)
        values ('digest-1', '2026-01-01', ?, 'test', 1, 'sonar.track', 1, ?, 'track')`,
    });
    await db.execute({
      args: [2, "track:a"],
      sql: `insert into artifact_change_revisions
        (content_digest, created_at, event_seq, producer, revision, stream, stream_version, subject_id, subject_type)
        values ('digest-2', '2026-01-01', ?, 'test', 3, 'sonar.track', 1, ?, 'track')`,
    });
    await registerArtifactConsumer(db, {
      consumerId: "source-read-reference",
      contracts: [artifactContract("sonar.track")],
    });
    const reference = await listArtifactSnapshot(db, {
      consumerId: "source-read-reference",
      stream: "sonar.track",
      streamVersion: 1,
    });
    const digests = await listSonarTrackDigests(db, {});
    const selected = await listSonarTracks(db, {
      subjectIds: ["track:c", "track:missing", "track:a", "track:b"],
    });

    expect(digests.items).toEqual(
      reference.items.map((item) => ({
        payloadDigest: item.payloadDigest,
        revision: item.subjectId === "track:a" ? 3 : 0,
        subjectId: item.subjectId,
      })),
    );
    expect(selected.items).toEqual(
      reference.items.map((item) => ({ ...item, revision: item.subjectId === "track:a" ? 3 : 0 })),
    );
    expect(selected.absentIds).toEqual(["track:missing"]);
  });

  it("pages each track and centroid once and reports absent or invalid ids", async () => {
    await seedTrackSource(["track:a", "track:b", "track:c"]);
    await seedCentroid(CENTROID_FIXTURES[0] as CentroidFixture);
    await seedCentroid(CENTROID_FIXTURES[1] as CentroidFixture);
    await seedCentroid(CENTROID_FIXTURES[2] as CentroidFixture);
    const invalid = new Uint8Array(4096);
    new DataView(invalid.buffer).setFloat32(0, Number.NaN, true);
    await db.execute({
      args: ["artist:invalid", invalid],
      sql: `insert into artist_centroids
        (artist_id, centroid_blob, computed_at, rank_corpus, vector_count)
        values (?, ?, '2026-01-01', 'all', 1)`,
    });

    const trackIds: string[] = [];
    let trackAfter: string | undefined;

    for (;;) {
      const page = await listSonarTrackDigests(db, { after: trackAfter, limit: 1 });
      trackIds.push(...page.items.map((item) => item.subjectId));

      if (page.nextAfter === null) {
        break;
      }

      trackAfter = page.nextAfter;
    }

    const centroidIds: string[] = [];
    let centroidAfter: string | undefined;

    for (;;) {
      const page = await listSonarCentroidDigests(db, { after: centroidAfter, limit: 1 });
      centroidIds.push(...page.items.map((item) => item.artistId));

      if (page.nextAfter === null) {
        break;
      }

      centroidAfter = page.nextAfter;
    }

    expect(trackIds).toEqual(["track:a", "track:b", "track:c"]);
    expect(centroidIds).toEqual(
      SERVABLE_CENTROID_FIXTURES.map((fixture) => fixture.artistId).sort(),
    );
    const selected = await listSonarCentroids(db, {
      artistIds: ["artist:invalid", "artist:missing", ...centroidIds],
    });
    expect(selected.absentIds).toEqual(["artist:invalid", "artist:missing"]);
    expect(selected.items.map(({ artistId, digest }) => ({ artistId, digest }))).toEqual(
      SERVABLE_CENTROID_FIXTURES.map(({ artistId, digest }) => ({ artistId, digest })).sort(
        (a, b) => (a.artistId < b.artistId ? -1 : 1),
      ),
    );
  });

  it("matches the shared Rust centroid digest fixture", async () => {
    for (const fixture of CENTROID_FIXTURES) {
      const bytes = Uint8Array.from(atob(fixture.blobBase64), (char) => char.charCodeAt(0));
      expect(await sonarCentroidDigest(fixture.artistId, bytes), fixture.name).toBe(fixture.digest);
    }
  });

  it("reads a digest page larger than the fenced snapshot page", async () => {
    const ids = Array.from(
      { length: 201 },
      (_, index) => `track:${String(index).padStart(3, "0")}`,
    );
    await seedTrackSource(ids);
    const page = await listSonarTrackDigests(db, { limit: 2_000 });

    expect(page.items.map((item) => item.subjectId)).toEqual(ids);
    expect(page.nextAfter).toBeNull();
  });

  it("enforces page and selected-id limits", async () => {
    await expect(listSonarTrackDigests(db, { limit: 2_001 })).rejects.toThrow(RangeError);
    await expect(listSonarCentroidDigests(db, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(listSonarTracks(db, { subjectIds: ["duplicate", "duplicate"] })).rejects.toThrow(
      RangeError,
    );
    await expect(
      listSonarCentroids(db, { artistIds: Array.from({ length: 201 }, (_, index) => `${index}`) }),
    ).rejects.toThrow(RangeError);
  });

  it("uses indexed keyset and revision lookups", async () => {
    const trackPlan = await db.execute({
      ...buildSonarTrackDigestStatement("track:a", 10),
      sql: `explain query plan ${buildSonarTrackDigestStatement("track:a", 10).sql}`,
    });
    const centroidPlan = await db.execute({
      ...buildSonarCentroidDigestStatement("artist:a", 10),
      sql: `explain query plan ${buildSonarCentroidDigestStatement("artist:a", 10).sql}`,
    });
    const trackDetails = trackPlan.rows.map((row) => row.detail as string).join("\n");
    const centroidDetails = centroidPlan.rows.map((row) => row.detail as string).join("\n");

    expect(trackDetails).toMatch(/SEARCH t USING INDEX sqlite_autoindex_tracks_1/i);
    expect(trackDetails).toMatch(
      /SEARCH r USING COVERING INDEX sqlite_autoindex_artifact_change_revisions_1/i,
    );
    expect(trackDetails).not.toMatch(/SCAN r\b/i);
    expect(centroidDetails).toMatch(/SEARCH artist_centroids USING INDEX/i);
  });
});
