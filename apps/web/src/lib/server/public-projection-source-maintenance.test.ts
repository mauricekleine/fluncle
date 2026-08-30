import { describe, expect, it } from "vitest";

import {
  markArtistQualificationRepairStatements,
  markPublicLabelSourceChangedStatements,
  markPublicProjectionSourceChangedFromSelectStatements,
  markPublicProjectionSourceChangedStatements,
  markPublicTrackSourceChangedStatements,
  PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID,
  type PublicProjectionStatement,
} from "./public-projection-source-maintenance";

const NOW = "2026-08-29T01:00:00.000Z";
const VERSION = "live-1";

/**
 * The four statement shapes this module emits, labelled by the table each one writes. The ORDER of
 * the returned array is the contract — every epoch statement reads `changes()` from the statement
 * immediately before it — so a test that only counted statements would miss a reordering.
 */
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

/** True when an epoch statement is admitted only by the preceding statement touching rows. */
function isConditional(statement: PublicProjectionStatement): boolean {
  return String(statement.sql).includes("where changes() > 0");
}

describe("markPublicProjectionSourceChangedStatements", () => {
  it("marks both projections for a track subject, in dependency order", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [{ subjectId: "track-1", subjectType: "track" }],
      VERSION,
      { now: NOW },
    );

    expect(shapes(statements)).toEqual([
      "public-aggregate-epoch",
      "public-aggregate-repairs",
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
  });

  it("marks only artist qualification for an artist or label subject", () => {
    for (const subjectType of ["artist", "label"] as const) {
      const statements = markPublicProjectionSourceChangedStatements(
        [{ subjectId: `${subjectType}-1`, subjectType }],
        VERSION,
        { now: NOW },
      );

      expect(shapes(statements)).toEqual([
        "artist-qualification-epoch",
        "artist-qualification-repairs",
      ]);
    }
  });

  it("holds the trailing epoch conditional even when the caller opted out of the leading one", () => {
    // The public-aggregate repairs insert sits between the two epochs, so the artist-qualification
    // epoch is always gated on THAT insert having touched rows — never on the caller's option.
    const statements = markPublicProjectionSourceChangedStatements(
      [{ subjectId: "track-1", subjectType: "track" }],
      VERSION,
      { now: NOW, onlyIfPreviousStatementChanged: false },
    );
    const [leadingEpoch, , trailingEpoch] = statements;

    expect(leadingEpoch && isConditional(leadingEpoch)).toBe(false);
    expect(trailingEpoch && isConditional(trailingEpoch)).toBe(true);
  });

  it("gates the leading epoch when the caller asks for it", () => {
    const [leadingEpoch] = markPublicProjectionSourceChangedStatements(
      [{ subjectId: "artist-1", subjectType: "artist" }],
      VERSION,
      { now: NOW, onlyIfPreviousStatementChanged: true },
    );

    expect(leadingEpoch && isConditional(leadingEpoch)).toBe(true);
  });

  it("drops album subjects — albums carry no public projection", () => {
    expect(
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "album-1", subjectType: "album" }],
        VERSION,
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it("drops the synthetic rank-corpus track subject", () => {
    // That id names the corpus fingerprint, not a row, so a repair keyed on it would never resolve.
    expect(
      markPublicProjectionSourceChangedStatements(
        [
          {
            subjectId: PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID,
            subjectType: "track",
          },
        ],
        VERSION,
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it("keeps a real track alongside a dropped synthetic one", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [
        { subjectId: PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID, subjectType: "track" },
        { subjectId: "track-1", subjectType: "track" },
      ],
      VERSION,
      { now: NOW },
    );
    const [, repairs] = statements;

    expect(shapes(statements)).toHaveLength(4);
    expect(repairs?.args).toEqual(["track", "track-1", VERSION, NOW, NOW, "tracks"]);
  });

  it("dedupes by subject type and id, and keeps one bind pair per surviving subject", () => {
    const statements = markPublicProjectionSourceChangedStatements(
      [
        { subjectId: "same", subjectType: "artist" },
        { subjectId: "same", subjectType: "artist" },
        { subjectId: "same", subjectType: "label" },
      ],
      VERSION,
      { now: NOW },
    );
    const [, repairs] = statements;

    // Same id, different type: two distinct subjects, so two `(?, ?)` rows — not one.
    expect(repairs?.args).toEqual([
      "artist",
      "same",
      "label",
      "same",
      VERSION,
      NOW,
      NOW,
      "artists",
    ]);
    expect((String(repairs?.sql).match(/\(\?, \?\)/g) ?? []).length).toBe(2);
  });

  it("rejects an empty source version and an empty subject id", () => {
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "track-1", subjectType: "track" }],
        "  ",
      ),
    ).toThrow(/source version/);
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: " ", subjectType: "track" }],
        VERSION,
      ),
    ).toThrow(/subject id/);
  });

  it("rejects an unparseable marker time", () => {
    expect(() =>
      markPublicProjectionSourceChangedStatements(
        [{ subjectId: "track-1", subjectType: "track" }],
        VERSION,
        { now: "not-a-timestamp" },
      ),
    ).toThrow(/valid timestamp/);
  });
});

describe("markPublicProjectionSourceChangedFromSelectStatements", () => {
  it("threads the selection binds ahead of the marker binds", () => {
    const statements = markPublicProjectionSourceChangedFromSelectStatements(
      "label",
      { args: ["hospital"], sql: "select label_id as subject_id from labels where slug = ?" },
      VERSION,
      { now: NOW },
    );
    const [, repairs] = statements;

    expect(shapes(statements)).toEqual([
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
    expect(repairs?.args).toEqual(["hospital", VERSION, NOW, NOW, "artists"]);
  });

  it("excludes the synthetic subject in SQL for a track selection, and only for a track", () => {
    // A bounded selection cannot be filtered in TypeScript, so the guard has to ride the query.
    const trackRepairs = markPublicProjectionSourceChangedFromSelectStatements(
      "track",
      { sql: "select track_id as subject_id from tracks" },
      VERSION,
      { now: NOW },
    )[1];
    const artistRepairs = markPublicProjectionSourceChangedFromSelectStatements(
      "artist",
      { sql: "select artist_id as subject_id from artists" },
      VERSION,
      { now: NOW },
    )[1];

    expect(String(trackRepairs?.sql)).toMatch(/and source\.subject_id <> \?/);
    expect(trackRepairs?.args).toEqual([
      VERSION,
      NOW,
      NOW,
      "tracks",
      PUBLIC_PROJECTION_SYNTHETIC_TRACK_SUBJECT_ID,
    ]);
    expect(String(artistRepairs?.sql)).not.toMatch(/and source\.subject_id <> \?/);
    expect(artistRepairs?.args).toEqual([VERSION, NOW, NOW, "artists"]);
  });

  it("keeps every epoch conditional — an empty selection can never advance public state", () => {
    const statements = markPublicProjectionSourceChangedFromSelectStatements(
      "track",
      { sql: "select track_id as subject_id from tracks where 0" },
      VERSION,
      { now: NOW },
    );

    expect(shapes(statements)).toEqual([
      "public-aggregate-epoch",
      "public-aggregate-repairs",
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
    for (const statement of statements.filter((candidate) =>
      shapes([candidate])[0]?.endsWith("epoch"),
    )) {
      expect(isConditional(statement)).toBe(true);
    }
  });

  it("drops an album selection before it validates anything else", () => {
    expect(markPublicProjectionSourceChangedFromSelectStatements("album", { sql: "" }, "")).toEqual(
      [],
    );
  });

  it("rejects an empty selection for a projected subject type", () => {
    expect(() =>
      markPublicProjectionSourceChangedFromSelectStatements("track", { sql: "  " }, VERSION),
    ).toThrow(/selection/);
  });
});

describe("the single-subject wrappers", () => {
  it("gate the leading epoch by default", () => {
    const wrapped = [
      markPublicTrackSourceChangedStatements("track-1", VERSION, { now: NOW }),
      markPublicLabelSourceChangedStatements("label-1", VERSION, { now: NOW }),
      markArtistQualificationRepairStatements("artist-1", VERSION, { now: NOW }),
    ];

    for (const statements of wrapped) {
      expect(statements[0] && isConditional(statements[0])).toBe(true);
    }
  });

  it("let an explicit `false` open the leading epoch", () => {
    const [leadingEpoch] = markPublicTrackSourceChangedStatements("track-1", VERSION, {
      now: NOW,
      onlyIfPreviousStatementChanged: false,
    });

    expect(leadingEpoch && isConditional(leadingEpoch)).toBe(false);
  });

  it("mark the projections their subject owns", () => {
    expect(
      shapes(markPublicTrackSourceChangedStatements("track-1", VERSION, { now: NOW })),
    ).toEqual([
      "public-aggregate-epoch",
      "public-aggregate-repairs",
      "artist-qualification-epoch",
      "artist-qualification-repairs",
    ]);
    expect(
      shapes(markPublicLabelSourceChangedStatements("label-1", VERSION, { now: NOW })),
    ).toEqual(["artist-qualification-epoch", "artist-qualification-repairs"]);
    expect(
      shapes(markArtistQualificationRepairStatements("artist-1", VERSION, { now: NOW })),
    ).toEqual(["artist-qualification-epoch", "artist-qualification-repairs"]);
  });
});
