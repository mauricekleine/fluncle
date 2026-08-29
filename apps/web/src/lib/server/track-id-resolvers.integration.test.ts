import { type Client, type InArgs, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMS } from "./embedding";
import {
  createIntegrationDb,
  seedCatalogueTrack,
  seedEmbedding,
  seedTrack,
  seedUser,
} from "./integration-db";
import { type PublicUser } from "./public-auth";

const getDbMock = vi.hoisted(() => vi.fn());

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: getDbMock };
});

import { mergeGalaxyProgress, saveFinding, saveSet } from "./account-data";
import { getPreviewArchiveMetadata } from "./preview-archive";
import { readIdentity } from "./identity-envelope";
import { saveRecSeed } from "./recommendations";
import {
  getLivePreviewTrack,
  getMixableTracks,
  getObservationProvenance,
  getSimilarFindings,
  getSourceAudioKey,
  getTrackByIdOrLogId,
  getTrackContextNote,
} from "./tracks";

type CapturedStatement = {
  args?: InArgs;
  sql: string;
};

const EQUIVALENT_TRACK_ID = "1111111111111111111111";
const EQUIVALENT_LOG_ID = "111.1.1A";
const COLLISION_TOKEN = "2222222222222222222222";
const PREFERRED_LOG_ID = "222.2.2B";
const LOG_OWNER_TRACK_ID = "3333333333333333333333";
const CANDIDATE_TRACK_ID = "4444444444444444444444";
const CANDIDATE_LOG_ID = "444.4.4D";
const CATALOGUE_TRACK_ID = "5555555555555555555555";
const CATALOGUE_COLLISION_TOKEN = "6666666666666666666666";
const CATALOGUE_COLLISION_LOG_OWNER_TRACK_ID = "7777777777777777777777";
const UNKNOWN_TOKEN = "9999999999999999999999";

let captured: CapturedStatement[];
let db: Client;

const user: PublicUser = {
  createdAt: new Date(0).toISOString(),
  email: "resolver@example.com",
  emailVerified: false,
  id: "resolver-user",
  name: "Resolver",
  username: "resolver",
};

function vector(a: number, b: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMS }, () => 0);
  values[0] = a;
  values[1] = b;

  return values;
}

async function seedResolverFixture(): Promise<void> {
  await seedTrack(db, {
    artists: ["Equivalent Artist"],
    logId: EQUIVALENT_LOG_ID,
    title: "Equivalent",
    trackId: EQUIVALENT_TRACK_ID,
  });
  await seedTrack(db, {
    artists: ["Preferred Artist"],
    logId: PREFERRED_LOG_ID,
    title: "Preferred",
    trackId: COLLISION_TOKEN,
  });
  await seedTrack(db, {
    artists: ["Log Owner Artist"],
    // This coordinate deliberately collides with another row's raw track PK.
    logId: COLLISION_TOKEN,
    title: "Log Owner",
    trackId: LOG_OWNER_TRACK_ID,
  });
  await seedTrack(db, {
    artists: ["Candidate Artist"],
    logId: CANDIDATE_LOG_ID,
    title: "Candidate",
    trackId: CANDIDATE_TRACK_ID,
  });
  await seedCatalogueTrack(db, {
    artists: ["Catalogue Artist"],
    title: "Catalogue",
    trackId: CATALOGUE_TRACK_ID,
  });
  await seedCatalogueTrack(db, {
    artists: ["Catalogue Collision Artist"],
    title: "Catalogue Collision",
    trackId: CATALOGUE_COLLISION_TOKEN,
  });
  await seedTrack(db, {
    artists: ["Catalogue Collision Log Owner Artist"],
    logId: CATALOGUE_COLLISION_TOKEN,
    title: "Catalogue Collision Log Owner",
    trackId: CATALOGUE_COLLISION_LOG_OWNER_TRACK_ID,
  });

  await db.batch(
    [
      {
        args: [
          "EQ-ISRC",
          "https://audio.example/equivalent.mp3",
          "source/equivalent.mp3",
          "equivalent/preview.mp3",
          "deezer:isrc",
          "audio/mpeg",
          "2026-08-26T00:00:00.000Z",
          "A minor",
          174,
          EQUIVALENT_TRACK_ID,
        ],
        sql: `update tracks set isrc = ?, preview_url = ?, source_audio_key = ?,
          preview_archive_key = ?, preview_archive_source = ?, preview_archive_mime = ?,
          preview_archived_at = ?, key = ?, bpm = ? where track_id = ?`,
      },
      {
        args: [
          "PREFERRED-ISRC",
          "https://audio.example/preferred.mp3",
          "source/preferred.mp3",
          "preferred/preview.mp3",
          "apple:isrc",
          "audio/mpeg",
          "2026-08-26T01:00:00.000Z",
          "A minor",
          174,
          COLLISION_TOKEN,
        ],
        sql: `update tracks set isrc = ?, preview_url = ?, source_audio_key = ?,
          preview_archive_key = ?, preview_archive_source = ?, preview_archive_mime = ?,
          preview_archived_at = ?, key = ?, bpm = ? where track_id = ?`,
      },
      {
        args: ["preferred context", "preferred observation", 7, COLLISION_TOKEN],
        sql: `update findings set context_note = ?, observation_script = ?,
          observation_prompt_version = ? where track_id = ?`,
      },
      {
        args: ["log owner context", "log owner observation", 11, LOG_OWNER_TRACK_ID],
        sql: `update findings set context_note = ?, observation_script = ?,
          observation_prompt_version = ? where track_id = ?`,
      },
      {
        args: [
          "catalogue collision log owner context",
          "catalogue collision log owner observation",
          13,
          CATALOGUE_COLLISION_LOG_OWNER_TRACK_ID,
        ],
        sql: `update findings set context_note = ?, observation_script = ?,
          observation_prompt_version = ? where track_id = ?`,
      },
      {
        args: [LOG_OWNER_TRACK_ID],
        sql: `update tracks set key = null, bpm = null where track_id = ?`,
      },
      {
        args: ["C major", 174, CANDIDATE_TRACK_ID],
        sql: `update tracks set key = ?, bpm = ? where track_id = ?`,
      },
      {
        args: ["source/catalogue.mp3", CATALOGUE_TRACK_ID],
        sql: `update tracks set source_audio_key = ? where track_id = ?`,
      },
      {
        args: ["source/catalogue-collision.mp3", CATALOGUE_COLLISION_TOKEN],
        sql: `update tracks set source_audio_key = ? where track_id = ?`,
      },
    ],
    "write",
  );

  await seedEmbedding(db, EQUIVALENT_TRACK_ID, vector(1, 0));
  await seedEmbedding(db, COLLISION_TOKEN, vector(1, 0));
  await seedEmbedding(db, CANDIDATE_TRACK_ID, vector(0.9, 0.1));
}

beforeEach(async () => {
  captured = [];
  db = await createIntegrationDb();
  getDbMock.mockImplementation(async () => ({
    batch: db.batch.bind(db),
    execute: async (statement: InStatement) => {
      if (typeof statement === "string") {
        return db.execute(statement);
      }

      captured.push({ args: statement.args, sql: statement.sql });

      return db.execute(statement);
    },
  }));
  await seedUser(db, {
    email: user.email,
    id: user.id,
    username: user.username,
  });
});

afterEach(() => {
  db.close();
  getDbMock.mockReset();
});

describe("track-id / Log-ID resolver equivalence and precedence", () => {
  it("keeps every direct track resolver equivalent and gives a colliding raw track id precedence", async () => {
    await seedResolverFixture();

    expect(await getLivePreviewTrack(EQUIVALENT_TRACK_ID)).toEqual(
      await getLivePreviewTrack(EQUIVALENT_LOG_ID),
    );
    expect(await getLivePreviewTrack(COLLISION_TOKEN)).toMatchObject({
      isrc: "PREFERRED-ISRC",
      title: "Preferred",
    });

    expect(await getTrackByIdOrLogId(EQUIVALENT_TRACK_ID)).toEqual(
      await getTrackByIdOrLogId(EQUIVALENT_LOG_ID),
    );
    expect(await getTrackByIdOrLogId(COLLISION_TOKEN)).toMatchObject({
      logId: PREFERRED_LOG_ID,
      title: "Preferred",
      trackId: COLLISION_TOKEN,
    });

    expect(await getSourceAudioKey(EQUIVALENT_TRACK_ID)).toBe(
      await getSourceAudioKey(EQUIVALENT_LOG_ID),
    );
    expect(await getSourceAudioKey(COLLISION_TOKEN)).toBe("source/preferred.mp3");
    expect(await getTrackContextNote(COLLISION_TOKEN)).toBe("preferred context");
    expect(await getObservationProvenance(COLLISION_TOKEN)).toEqual({
      promptVersion: 7,
      script: "preferred observation",
    });

    expect(await getPreviewArchiveMetadata(EQUIVALENT_TRACK_ID)).toEqual(
      await getPreviewArchiveMetadata(EQUIVALENT_LOG_ID),
    );
    expect(await getPreviewArchiveMetadata(COLLISION_TOKEN)).toMatchObject({
      key: "preferred/preview.mp3",
      logId: PREFERRED_LOG_ID,
      trackId: COLLISION_TOKEN,
    });

    const identityCollision = await readIdentity({
      idOrLogId: COLLISION_TOKEN,
      kind: "idOrLogId",
    });
    expect(
      identityCollision?.recordings.map(({ relation, trackId }) => ({ relation, trackId })),
    ).toEqual([
      { relation: "ambiguous", trackId: COLLISION_TOKEN },
      { relation: "ambiguous", trackId: LOG_OWNER_TRACK_ID },
    ]);
  });

  it("uses the same resolved target for similarity and mix rails", async () => {
    await seedResolverFixture();

    const similarByTrack = (await getSimilarFindings(EQUIVALENT_TRACK_ID)).map(
      ({ trackId }) => trackId,
    );
    const similarByLog = (await getSimilarFindings(EQUIVALENT_LOG_ID)).map(
      ({ trackId }) => trackId,
    );
    const similarCollision = (await getSimilarFindings(COLLISION_TOKEN)).map(
      ({ trackId }) => trackId,
    );
    const similarPreferred = (await getSimilarFindings(PREFERRED_LOG_ID)).map(
      ({ trackId }) => trackId,
    );

    expect(similarByTrack).toEqual(similarByLog);
    expect(similarCollision).toEqual(similarPreferred);
    expect(similarCollision.length).toBeGreaterThan(0);

    const mixByTrack = (await getMixableTracks(EQUIVALENT_TRACK_ID)).map(({ trackId }) => trackId);
    const mixByLog = (await getMixableTracks(EQUIVALENT_LOG_ID)).map(({ trackId }) => trackId);
    const mixCollision = (await getMixableTracks(COLLISION_TOKEN)).map(({ trackId }) => trackId);
    const mixPreferred = (await getMixableTracks(PREFERRED_LOG_ID)).map(({ trackId }) => trackId);

    expect(mixByTrack).toEqual(mixByLog);
    expect(mixCollision).toEqual(mixPreferred);
    expect(mixCollision.length).toBeGreaterThan(0);
  });

  it("preserves missing, null-metadata, and optional-versus-required finding behavior", async () => {
    await seedResolverFixture();

    expect(await getLivePreviewTrack(CATALOGUE_TRACK_ID)).toMatchObject({ title: "Catalogue" });
    expect(await getSourceAudioKey(CATALOGUE_TRACK_ID)).toBe("source/catalogue.mp3");
    expect(await getTrackByIdOrLogId(CATALOGUE_TRACK_ID)).toBeUndefined();
    expect(await getPreviewArchiveMetadata(CATALOGUE_TRACK_ID)).toBeUndefined();
    expect(await getPreviewArchiveMetadata(LOG_OWNER_TRACK_ID)).toEqual({
      archivedAt: "",
      key: "",
      logId: COLLISION_TOKEN,
      mime: "",
      source: "",
      trackId: LOG_OWNER_TRACK_ID,
    });

    // Optional-finding readers preserve raw-ID precedence for the catalogue row. Readers whose
    // contract requires a finding ignore that uncertified raw row and resolve the valid Log ID.
    expect(await getLivePreviewTrack(CATALOGUE_COLLISION_TOKEN)).toMatchObject({
      title: "Catalogue Collision",
    });
    expect(await getSourceAudioKey(CATALOGUE_COLLISION_TOKEN)).toBe(
      "source/catalogue-collision.mp3",
    );
    expect(await getTrackByIdOrLogId(CATALOGUE_COLLISION_TOKEN)).toMatchObject({
      logId: CATALOGUE_COLLISION_TOKEN,
      title: "Catalogue Collision Log Owner",
      trackId: CATALOGUE_COLLISION_LOG_OWNER_TRACK_ID,
    });
    expect(await getPreviewArchiveMetadata(CATALOGUE_COLLISION_TOKEN)).toMatchObject({
      logId: CATALOGUE_COLLISION_TOKEN,
      trackId: CATALOGUE_COLLISION_LOG_OWNER_TRACK_ID,
    });
    expect(await getTrackContextNote(CATALOGUE_COLLISION_TOKEN)).toBe(
      "catalogue collision log owner context",
    );
    expect(await getObservationProvenance(CATALOGUE_COLLISION_TOKEN)).toEqual({
      promptVersion: 13,
      script: "catalogue collision log owner observation",
    });

    expect(await getLivePreviewTrack(UNKNOWN_TOKEN)).toBeUndefined();
    expect(await getTrackByIdOrLogId(UNKNOWN_TOKEN)).toBeUndefined();
    expect(await getSourceAudioKey(UNKNOWN_TOKEN)).toBeNull();
    expect(await getPreviewArchiveMetadata(UNKNOWN_TOKEN)).toBeUndefined();
    expect(await getTrackContextNote(UNKNOWN_TOKEN)).toBeNull();
    expect(await getObservationProvenance(UNKNOWN_TOKEN)).toEqual({
      promptVersion: null,
      script: null,
    });
    expect(await getSimilarFindings(UNKNOWN_TOKEN)).toEqual([]);
    expect(await getMixableTracks(UNKNOWN_TOKEN)).toEqual([]);
  });

  it("preserves account resolver equivalence, collision precedence, and bulk dedupe", async () => {
    await seedResolverFixture();

    const savedByTrack = await saveFinding(user, { trackId: EQUIVALENT_TRACK_ID });
    const savedByLog = await saveFinding(user, { logId: EQUIVALENT_LOG_ID });
    const savedCollision = await saveFinding(user, { trackId: COLLISION_TOKEN });

    expect(savedByTrack).not.toBeInstanceOf(Response);
    expect(savedByLog).not.toBeInstanceOf(Response);
    expect(savedCollision).not.toBeInstanceOf(Response);
    expect(savedByTrack).toMatchObject({
      savedFinding: { logId: EQUIVALENT_LOG_ID, trackId: EQUIVALENT_TRACK_ID },
    });
    expect(savedByLog).toMatchObject({
      savedFinding: { logId: EQUIVALENT_LOG_ID, trackId: EQUIVALENT_TRACK_ID },
    });
    expect(savedCollision).toMatchObject({
      savedFinding: { logId: PREFERRED_LOG_ID, trackId: COLLISION_TOKEN },
    });

    expect(await saveRecSeed(user, { trackId: COLLISION_TOKEN })).toMatchObject({
      seed: { logId: PREFERRED_LOG_ID, trackId: COLLISION_TOKEN },
    });

    const setByTrack = await saveSet(user, { set: EQUIVALENT_TRACK_ID });
    const setByLog = await saveSet(user, { set: EQUIVALENT_LOG_ID });
    const setCollision = await saveSet(user, { set: COLLISION_TOKEN });

    expect(setByTrack).not.toBeInstanceOf(Response);
    expect(setByLog).not.toBeInstanceOf(Response);
    expect(setCollision).not.toBeInstanceOf(Response);
    expect(setByTrack).toMatchObject({
      savedSet: { name: expect.stringMatching(/^Equivalent ·/) },
    });
    expect(setByLog).toMatchObject({ savedSet: { name: expect.stringMatching(/^Equivalent ·/) } });
    expect(setCollision).toMatchObject({
      savedSet: { name: expect.stringMatching(/^Preferred ·/) },
    });

    const merged = await mergeGalaxyProgress(user, {
      collectedLogIds: [EQUIVALENT_TRACK_ID, EQUIVALENT_LOG_ID, COLLISION_TOKEN],
    });

    expect(merged).not.toBeInstanceOf(Response);
    expect(merged).toMatchObject({
      collectedLogIds: [EQUIVALENT_LOG_ID, PREFERRED_LOG_ID],
    });
  });
});

async function capturedResolver(
  name: string,
  marker: "resolved_track" | "resolved_tracks",
  invoke: () => Promise<unknown>,
): Promise<CapturedStatement> {
  captured = [];
  await invoke();

  const statements = captured.filter(({ sql }) => sql.includes(`${marker}(`));

  expect(statements, `${name} must resolve in one statement`).toHaveLength(1);
  const statement = statements[0];

  expect(statement, `${name} did not emit its resolver statement`).toBeDefined();

  if (!statement) {
    throw new Error(`${name} did not emit its resolver statement`);
  }

  expect(statement.sql.toLowerCase()).toContain("union all");

  return statement;
}

async function expectIndexedPlan(name: string, statement: CapturedStatement): Promise<void> {
  const plan = await db.execute({
    args: statement.args,
    sql: `explain query plan ${statement.sql}`,
  });
  const details = plan.rows.flatMap((row) =>
    typeof row.detail === "string" ? [row.detail.toLowerCase()] : [],
  );
  const searchesTrackPk = details.some(
    (detail) =>
      /\bsearch\s+(?:table\s+)?(?:tracks|preferred_track)\b/.test(detail) &&
      /(track_id|primary key|sqlite_autoindex_tracks)/.test(detail),
  );
  const searchesFindingLogId = details.some(
    (detail) =>
      /\bsearch\s+(?:table\s+)?findings\b/.test(detail) &&
      /(log_id|findings_log_id_unique)/.test(detail),
  );
  const growingTableScans = details.filter((detail) =>
    /\bscan\s+(?:table\s+)?(?:tracks|findings|preferred_track|preferred_finding)\b/.test(detail),
  );

  expect(searchesTrackPk, `${name} plan missed the tracks PK:\n${details.join("\n")}`).toBe(true);
  expect(
    searchesFindingLogId,
    `${name} plan missed findings.log_id unique:\n${details.join("\n")}`,
  ).toBe(true);
  expect(growingTableScans, `${name} plan scanned a growing table:\n${details.join("\n")}`).toEqual(
    [],
  );
}

describe("track-id / Log-ID resolver query plans", () => {
  const cases: Array<{
    invoke: () => Promise<unknown>;
    marker: "resolved_track" | "resolved_tracks";
    name: string;
  }> = [
    {
      invoke: () => getLivePreviewTrack(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getLivePreviewTrack",
    },
    {
      invoke: () => getTrackByIdOrLogId(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getTrackByIdOrLogId",
    },
    {
      invoke: () => getSourceAudioKey(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getSourceAudioKey",
    },
    {
      invoke: () => getSimilarFindings(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getSimilarFindings target",
    },
    {
      invoke: () => getMixableTracks(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getMixableTracks target",
    },
    {
      invoke: () => getPreviewArchiveMetadata(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getPreviewArchiveMetadata",
    },
    {
      invoke: () => getTrackContextNote(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getTrackContextNote",
    },
    {
      invoke: () => getObservationProvenance(UNKNOWN_TOKEN),
      marker: "resolved_track",
      name: "getObservationProvenance",
    },
    {
      invoke: () => saveFinding(user, { trackId: UNKNOWN_TOKEN }),
      marker: "resolved_track",
      name: "findTrackByTrackOrLog",
    },
    {
      invoke: () => saveSet(user, { set: UNKNOWN_TOKEN }),
      marker: "resolved_track",
      name: "defaultSetName",
    },
    {
      invoke: () => saveRecSeed(user, { trackId: UNKNOWN_TOKEN }),
      marker: "resolved_track",
      name: "findSeedTrack",
    },
    {
      invoke: () => mergeGalaxyProgress(user, { collectedLogIds: [UNKNOWN_TOKEN] }),
      marker: "resolved_tracks",
      name: "collectLogIds batch",
    },
    {
      invoke: () => readIdentity({ idOrLogId: UNKNOWN_TOKEN, kind: "idOrLogId" }),
      marker: "resolved_tracks",
      name: "readIdentity reference",
    },
  ];

  for (const resolverCase of cases) {
    it(`${resolverCase.name} seeks both identities without scanning tracks`, async () => {
      const statement = await capturedResolver(
        resolverCase.name,
        resolverCase.marker,
        resolverCase.invoke,
      );

      await expectIndexedPlan(resolverCase.name, statement);
    });
  }
});
