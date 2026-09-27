import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import {
  catalogueTrackHiddenReason,
  catalogueTrackPublicWhere,
  isSpokenWordTitle,
  LONG_FORM_MS,
  REC_ELIGIBLE_WHERE,
  spokenWordTitleWhere,
} from "./catalogue-eligibility";
import {
  publicTrackHiddenReason,
  publicTrackOk,
  publicTrackWhere,
} from "../db/public-track-visibility";

const SPOKEN_WORD_TITLES = [
  "Had a Little Fight (Commentary)",
  "Volume 1 (Logistics remix) (commentary)",
  "Spoken (Commentary)",
  "Weightless [Commentary]",
  "Demons Theme - LTJ Bukem Commentary",
  "The Western - Mikes Ricochet Mix - LTJ Bukem Commentary",
  "Cheap Love - Commentary",
  "Outer Edges ∴ Live - Commentary (Noisia Radio S06E43)",
  "All Our Duty - DIVIDID team hang - Commentary track",
  "Cheap Love – Commentary",
  "Interview: Machinedrum & Holly",
  "Hold Ya (Interview)",
  "Hold Ya - Interview",
  "Hold Ya (Artist Interview)",
  "Rewind (Track by Track)",
  "Rewind (Track-by-Track)",
  "Rewind (TRACK BY TRACK)",
  "Rewind - Track-by-Track",
];

const MUSIC_TITLES = [
  "Commentary",
  "Interview",
  "Interview With The Vampire",
  "The Interview (VIP)",
  "Commentary Box",
  "Running Commentary (Original Mix)",
  "Track by Track",
  "Unspoken (Black Barrel remix)",
  "Spoken Word (Rude Kid remix)",
  "Client_03_progress_assessment_interview_part_01",
  "Bonus Audio Interview of DJ Starscream",
  "Commentary - Original Mix",
  "Interview With The Vampire - VIP",
];

describe("the spoken-word qualifier rule", () => {
  it.each(SPOKEN_WORD_TITLES)("reads %s as spoken word", (title) => {
    expect(isSpokenWordTitle(title)).toBe(true);
  });

  it.each(MUSIC_TITLES)("keeps %s as music because the word is not a qualifier", (title) => {
    expect(isSpokenWordTitle(title)).toBe(false);
  });

  it("agrees with its SQL spelling on every fixture title", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("create table titles (title text not null)");
      for (const title of [...SPOKEN_WORD_TITLES, ...MUSIC_TITLES]) {
        await client.execute({ args: [title], sql: "insert into titles (title) values (?)" });
      }
      const result = await client.execute(
        `select title, ${spokenWordTitleWhere("titles")} as spoken from titles`,
      );
      const bySql = Object.fromEntries(
        result.rows.map((row) => [
          typeof row.title === "string" ? row.title : "",
          Number(row.spoken) === 1,
        ]),
      );
      const byScript = Object.fromEntries(
        [...SPOKEN_WORD_TITLES, ...MUSIC_TITLES].map((title) => [title, isSpokenWordTitle(title)]),
      );

      expect(bySql).toEqual(byScript);
    } finally {
      client.close();
    }
  });
});

describe("the public catalogue track rule", () => {
  it("names why a catalogue recording is hidden", () => {
    expect(catalogueTrackHiddenReason({ durationMs: 270_000, title: "Rewind" })).toBeNull();
    expect(catalogueTrackHiddenReason({ durationMs: LONG_FORM_MS, title: "Rewind" })).toBe(
      "long_form",
    );
    expect(catalogueTrackHiddenReason({ durationMs: 270_000, title: "Rewind (Commentary)" })).toBe(
      "spoken_word",
    );
  });

  it("keeps every finding public whatever its duration or title", () => {
    const spoken = { durationMs: 270_000, title: "Rewind (Commentary)" };
    const long = { durationMs: LONG_FORM_MS, title: "Rewind" };

    expect(publicTrackOk(spoken, true)).toBe(true);
    expect(publicTrackOk(long, true)).toBe(true);
    expect(publicTrackHiddenReason(spoken, true)).toBeNull();
    expect(publicTrackOk(spoken, false)).toBe(false);
    expect(publicTrackOk(long, false)).toBe(false);
  });

  it("evaluates the SQL rule with the finding exemption on a real table", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.batch(
        [
          "create table tracks (track_id text primary key, title text not null, duration_ms integer not null)",
          "create table findings (track_id text primary key)",
          `insert into tracks values
            ('music', 'Rewind', 270000),
            ('song-named-interview', 'Interview With The Vampire', 270000),
            ('spoken', 'Rewind (Commentary)', 270000),
            ('long', 'Rewind', ${LONG_FORM_MS}),
            ('spoken-finding', 'Rewind (Interview)', 270000),
            ('long-finding', 'Rewind', ${LONG_FORM_MS})`,
          "insert into findings values ('spoken-finding'), ('long-finding')",
        ],
        "write",
      );

      const catalogue = await client.execute(
        `select track_id from tracks where ${catalogueTrackPublicWhere("tracks")} order by track_id`,
      );
      const visible = await client.execute(
        `select track_id from tracks t where ${publicTrackWhere("t")} order by track_id`,
      );

      expect(catalogue.rows.map((row) => row.track_id)).toEqual(["music", "song-named-interview"]);
      expect(visible.rows.map((row) => row.track_id)).toEqual([
        "long-finding",
        "music",
        "song-named-interview",
        "spoken-finding",
      ]);
    } finally {
      client.close();
    }
  });

  it("gates recommendation eligibility with the same rule", () => {
    expect(REC_ELIGIBLE_WHERE).toContain(catalogueTrackPublicWhere("t"));
  });
});
