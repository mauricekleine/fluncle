import { describe, expect, it } from "vitest";

import {
  markArtistQualificationRepairStatements,
  markPublicLabelSourceChangedStatements,
  markPublicProjectionSourceChangedFromSelectStatements,
  markPublicProjectionSourceChangedStatements,
  markPublicTrackSourceChangedStatements,
  PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID,
  type PublicProjectionStatement,
  type PublicProjectionTarget,
} from "./public-projection-source-maintenance";

const NOW = "2026-08-29T01:00:00.000Z";
const VERSION = "live-1";
const AGGREGATES = ["public_aggregates"] as const;
const ARTISTS = ["artist_qualification"] as const;
const BOTH = ["public_aggregates", "artist_qualification"] as const;

/** The statement order is load-bearing because each epoch gate reads the preceding changes(). */
function shapes(statements: readonly PublicProjectionStatement[]): string[] {
  return statements.map((statement) => {
    const sql = String(statement.sql);
    if (sql.includes("insert into public_aggregate_state")) {
      return "public-aggregate-epoch";
    }
    if (sql.includes("insert into artist_qualification_state")) {
      return "artist-qualification-epoch";
    }
    if (sql.includes("'public_aggregates'")) {
      return "public-aggregate-repairs";
    }
    return "artist-qualification-repairs";
  });
}

function isConditional(statement: PublicProjectionStatement): boolean {
  return String(statement.sql).includes("where changes() > 0");
}

describe("markPublicProjectionSourceChangedStatements", () => {
  it("emits no public maintenance for an explicit empty target set", () => {
    expect(
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "album-1", subjectType: "album" }],
        "",
        [],
      ),
    ).toEqual([]);
  });

  it("emits aggregate-only maintenance for a track", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [{ subjectId: "track-1", subjectType: "track" }],
      VERSION,
      AGGREGATES,
      { now: NOW },
    );

    expect(shapes(statements)).toEqual(["public-aggregate-epoch", "public-aggregate-repairs"]);
    expect(statements[1]?.args).toEqual(["track", "track-1", VERSION, NOW, NOW, "tracks"]);
  });

  it("emits artist-only maintenance for track, artist, and label subjects", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [
        { subjectId: "track-1", subjectType: "track" },
        { subjectId: "artist-1", subjectType: "artist" },
        { subjectId: "label-1", subjectType: "label" },
      ],
      VERSION,
      ARTISTS,
      { now: NOW },
    );

    expect(shapes(statements)).toEqual([
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
    expect(statements[1]?.args).toEqual([
      "track",
      "track-1",
      "artist",
      "artist-1",
      "label",
      "label-1",
      VERSION,
      NOW,
      NOW,
      "artists",
    ]);
  });

  it("preserves aggregate-before-artist ordering for both targets", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [{ subjectId: "track-1", subjectType: "track" }],
      VERSION,
      BOTH,
      { now: NOW, onlyIfPreviousStatementChanged: false },
    );

    expect(shapes(statements)).toEqual([
      "public-aggregate-epoch",
      "public-aggregate-repairs",
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
    expect(statements[0] && isConditional(statements[0])).toBe(false);
    expect(statements[2] && isConditional(statements[2])).toBe(true);
  });

  it("gates the leading epoch when requested", () => {
    const [leadingEpoch] = markPublicProjectionSourceChangedStatements(
      [{ subjectId: "artist-1", subjectType: "artist" }],
      VERSION,
      ARTISTS,
      { now: NOW, onlyIfPreviousStatementChanged: true },
    );
    expect(leadingEpoch && isConditional(leadingEpoch)).toBe(true);
  });

  it("rejects incompatible, duplicate, and unknown targets", () => {
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "label-1", subjectType: "label" }],
        VERSION,
        AGGREGATES,
      ),
    ).toThrow(/only track subjects/);
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "album-1", subjectType: "album" }],
        VERSION,
        ARTISTS,
      ),
    ).toThrow(/does not accept album subjects/);
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "track-1", subjectType: "track" }],
        VERSION,
        ["public_aggregates", "public_aggregates"],
      ),
    ).toThrow(/duplicate public projection target/);
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "track-1", subjectType: "track" }],
        VERSION,
        ["unknown"] as unknown as readonly PublicProjectionTarget[],
      ),
    ).toThrow(/unknown public projection target/);
  });

  it("excludes the synthetic rank subject and keeps real tracks", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [
        { subjectId: PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID, subjectType: "track" },
        { subjectId: "track-1", subjectType: "track" },
      ],
      VERSION,
      BOTH,
      { now: NOW },
    );

    expect(shapes(statements)).toHaveLength(4);
    expect(statements[1]?.args).toEqual(["track", "track-1", VERSION, NOW, NOW, "tracks"]);
    expect(statements[3]?.args).toEqual(["track", "track-1", VERSION, NOW, NOW, "artists"]);
    expect(
      markPublicProjectionSourceChangedStatements(
        [
          {
            subjectId: PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID,
            subjectType: "track",
          },
        ],
        VERSION,
        BOTH,
      ),
    ).toEqual([]);
  });

  it("dedupes by subject type and id", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [
        { subjectId: "same", subjectType: "artist" },
        { subjectId: "same", subjectType: "artist" },
        { subjectId: "same", subjectType: "label" },
      ],
      VERSION,
      ARTISTS,
      { now: NOW },
    );
    expect(statements[1]?.args).toEqual([
      "artist",
      "same",
      "label",
      "same",
      VERSION,
      NOW,
      NOW,
      "artists",
    ]);
  });

  it("rejects invalid source metadata", () => {
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "track-1", subjectType: "track" }],
        " ",
        AGGREGATES,
      ),
    ).toThrow(/source version/);
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: " ", subjectType: "track" }],
        VERSION,
        AGGREGATES,
      ),
    ).toThrow(/subject id/);
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "track-1", subjectType: "track" }],
        VERSION,
        AGGREGATES,
        { now: "not-a-timestamp" },
      ),
    ).toThrow(/valid timestamp/);
  });
});

describe("markPublicProjectionSourceChangedFromSelectStatements", () => {
  it("threads selection binds through an artist-only marker", () => {
    const statements = markPublicProjectionSourceChangedFromSelectStatements(
      "label",
      { args: ["hospital"], sql: "select label_id as subject_id from labels where slug = ?" },
      VERSION,
      ARTISTS,
      { now: NOW },
    );
    expect(shapes(statements)).toEqual([
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
    expect(statements[1]?.args).toEqual(["hospital", VERSION, NOW, NOW, "artists"]);
  });

  it("preserves both-target ordering and synthetic track guards", () => {
    const statements = markPublicProjectionSourceChangedFromSelectStatements(
      "track",
      { sql: "select track_id as subject_id from tracks" },
      VERSION,
      BOTH,
      { now: NOW },
    );
    expect(shapes(statements)).toEqual([
      "public-aggregate-epoch",
      "public-aggregate-repairs",
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
    for (const statement of [statements[1], statements[3]]) {
      expect(String(statement?.sql)).toContain("source.subject_id <> ?");
      const args = statement?.args;
      expect(Array.isArray(args) ? args.at(-1) : undefined).toBe(
        PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID,
      );
    }
    for (const statement of [statements[0], statements[2]]) {
      expect(statement && isConditional(statement)).toBe(true);
    }
  });

  it("emits no statements for no targets and rejects incompatible selections", () => {
    expect(
      markPublicProjectionSourceChangedFromSelectStatements("album", { sql: "" }, "", []),
    ).toEqual([]);
    expect(() =>
      markPublicProjectionSourceChangedFromSelectStatements(
        "label",
        { sql: "select id as subject_id from labels" },
        VERSION,
        AGGREGATES,
      ),
    ).toThrow(/only track selections/);
    expect(() =>
      markPublicProjectionSourceChangedFromSelectStatements(
        "album",
        { sql: "select id as subject_id from albums" },
        VERSION,
        ARTISTS,
      ),
    ).toThrow(/album selections/);
  });

  it("rejects an empty selection for a targeted projection", () => {
    expect(() =>
      markPublicProjectionSourceChangedFromSelectStatements(
        "track",
        { sql: " " },
        VERSION,
        AGGREGATES,
      ),
    ).toThrow(/selection/);
  });
});

describe("single-subject wrappers", () => {
  it("gate the leading epoch and encode one exact dependency", () => {
    const aggregate = markPublicTrackSourceChangedStatements("track-1", VERSION, { now: NOW });
    const label = markPublicLabelSourceChangedStatements("label-1", VERSION, { now: NOW });
    const artist = markArtistQualificationRepairStatements("artist-1", VERSION, { now: NOW });

    expect(shapes(aggregate)).toEqual(["public-aggregate-epoch", "public-aggregate-repairs"]);
    expect(shapes(label)).toEqual(["artist-qualification-epoch", "artist-qualification-repairs"]);
    expect(shapes(artist)).toEqual(["artist-qualification-epoch", "artist-qualification-repairs"]);
    for (const statements of [aggregate, label, artist]) {
      expect(statements[0] && isConditional(statements[0])).toBe(true);
    }
  });

  it("allows an explicit unconditional aggregate audit marker", () => {
    const [leadingEpoch] = markPublicTrackSourceChangedStatements("track-1", VERSION, {
      now: NOW,
      onlyIfPreviousStatementChanged: false,
    });
    expect(leadingEpoch && isConditional(leadingEpoch)).toBe(false);
  });
});
