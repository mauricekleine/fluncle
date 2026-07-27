import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type ArtistRow,
  type Candidate,
  type CreditLookup,
  type LabelRow,
  type Side,
  type TrackRow,
  buildCandidates,
  edgeWriter,
  identifySide,
  localSignals,
  main,
  namesakeLabelSlugs,
  verdictFor,
} from "./find-conflated-artists";

// The detector is READ-ONLY, and these tests hold it to that: the stub records every statement, and
// the run must issue nothing but `select`s. The rest pins the classification — which is the part
// that must never guess, because its output is the input to a destructive repair.

process.env.PRUNE_OUT_DIR = mkdtempSync(join(tmpdir(), "find-conflated-"));

const MB_DNB = "b78f09e9-dnb";
const MB_JPOP = "1a7b4a25-jpop";

const track = (over: Partial<TrackRow> & { track_id: string }): TrackRow => ({
  artist_credits_backfilled_at: null,
  artist_edges_backfilled_at: null,
  artists_json: '["K"]',
  label: "Audio Couture",
  label_id: "L_AC",
  mb_recording_id: `rec-${over.track_id}`,
  title: "A Track",
  ...over,
});

const LABELS: LabelRow[] = [
  { id: "L_CE", name: "Cutting Edge", seed_state: "enabled", slug: "cutting-edge" },
  { id: "L_AC", name: "Audio Couture", seed_state: "enabled", slug: "audio-couture" },
  { id: "L_UN", name: "Some Undecided", seed_state: "undecided", slug: "some-undecided" },
];

const ARTISTS: ArtistRow[] = [{ id: "A_K", mbid: MB_DNB, name: "K", slug: "k" }];

/** The live shape: a J-pop act credited `K.` on Cutting Edge beside the DnB act `K`. */
const conflated = () => ({
  artists: ARTISTS,
  edges: [
    { artist_id: "A_K", track_id: "t_jpop1" },
    { artist_id: "A_K", track_id: "t_dnb1" },
  ],
  findingTrackIds: new Set<string>(),
  labels: LABELS,
  namesakeSlugs: new Set(["cutting-edge"]),
  tracks: [
    track({
      artist_edges_backfilled_at: "2026-07-26T15:05:00.000Z",
      artists_json: '["K."]',
      label: "Cutting Edge",
      label_id: "L_CE",
      title: "Shiny days",
      track_id: "t_jpop1",
    }),
    track({ title: "Bad Dream", track_id: "t_dnb1" }),
  ],
});

describe("namesakeLabelSlugs", () => {
  test("reads the impostor labels off the frontier's retirement notes", () => {
    expect(
      namesakeLabelSlugs([
        { label_slug: "radar-records" },
        { label_slug: "cutting-edge" },
        { label_slug: null },
      ]),
    ).toEqual(new Set(["radar-records", "cutting-edge"]));
  });
});

describe("edgeWriter", () => {
  test("the credit sweep's stamp wins — it is the mbid-keyed, homonym-refusing path", () => {
    expect(
      edgeWriter(
        track({
          artist_credits_backfilled_at: "2026-07-21T00:00:00.000Z",
          artist_edges_backfilled_at: "2026-07-20T00:00:00.000Z",
          track_id: "t",
        }),
      ),
    ).toBe("credit-sweep");
  });

  test("slice-0's stamp alone means the name FOLD wrote it", () => {
    expect(
      edgeWriter(track({ artist_edges_backfilled_at: "2026-07-26T00:00:00.000Z", track_id: "t" })),
    ).toBe("slice-0");
  });

  test("no stamp at all means the crawl-time name link wrote it", () => {
    expect(edgeWriter(track({ track_id: "t" }))).toBe("crawl-link");
  });
});

describe("buildCandidates", () => {
  test("an artist holding BOTH an impostor-label and a clean enabled-label track is a candidate", () => {
    const candidates = buildCandidates(conflated());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.impostor.tracks).toBe(1);
    expect(candidates[0]?.clean.tracks).toBe(1);
  });

  test("it records the DIVERGENT credit spellings that fingerprint the fold", () => {
    const candidates = buildCandidates(conflated());

    expect(candidates[0]?.impostor.creditSpellings).toEqual(["K."]);
    expect(candidates[0]?.clean.creditSpellings).toEqual(["K"]);
  });

  test("an artist with ONLY impostor tracks is NOT a candidate (that is the whole-artist case)", () => {
    const base = conflated();
    const candidates = buildCandidates({
      ...base,
      edges: [{ artist_id: "A_K", track_id: "t_jpop1" }],
    });

    expect(candidates).toEqual([]);
  });

  test("an artist with ONLY clean tracks is NOT a candidate", () => {
    const base = conflated();
    const candidates = buildCandidates({
      ...base,
      edges: [{ artist_id: "A_K", track_id: "t_dnb1" }],
    });

    expect(candidates).toEqual([]);
  });

  test("a FINDING is excluded from both sides — it can neither trigger nor be proposed", () => {
    const base = conflated();
    const candidates = buildCandidates({ ...base, findingTrackIds: new Set(["t_jpop1"]) });

    expect(candidates).toEqual([]);
  });

  test("a track on an UNDECIDED label counts toward neither side", () => {
    const base = conflated();
    const candidates = buildCandidates({
      ...base,
      edges: [...base.edges, { artist_id: "A_K", track_id: "t_un" }],
      tracks: [
        ...base.tracks,
        track({ label: "Some Undecided", label_id: "L_UN", track_id: "t_un" }),
      ],
    });

    expect(candidates[0]?.clean.tracks).toBe(1);
    expect(candidates[0]?.impostor.tracks).toBe(1);
  });
});

describe("identifySide", () => {
  const side = (trackIds: string[]): Side => ({
    creditSpellings: [],
    labels: [],
    sampleTitles: [],
    trackIds,
    tracks: trackIds.length,
    writers: [],
  });
  const tracks = new Map(conflated().tracks.map((t) => [t.track_id, t]));

  test("collects the MB artist ids MusicBrainz credits the side's recordings to", async () => {
    const lookup: CreditLookup = async (mbid) =>
      mbid === "rec-t_jpop1" ? { ids: [MB_JPOP], names: ["K."] } : null;

    expect(await identifySide(side(["t_jpop1"]), tracks, lookup, 2)).toEqual({
      ids: [MB_JPOP],
      names: ["K."],
      sampled: 1,
    });
  });

  test("stops at the sample cap rather than walking a 200-track side", async () => {
    let calls = 0;
    const lookup: CreditLookup = async () => {
      calls += 1;

      return { ids: ["x"], names: ["X"] };
    };
    await identifySide(side(["t_jpop1", "t_dnb1"]), tracks, lookup, 1);

    expect(calls).toBe(1);
  });

  test("a track with no MB recording id is skipped without spending a sample", async () => {
    const noId = new Map([["t_x", track({ mb_recording_id: null, track_id: "t_x" })]]);
    let calls = 0;
    const lookup: CreditLookup = async () => {
      calls += 1;

      return null;
    };

    expect(await identifySide(side(["t_x"]), noId, lookup, 2)).toEqual({
      ids: [],
      names: [],
      sampled: 0,
    });
    expect(calls).toBe(0);
  });
});

describe("verdictFor", () => {
  const id = (ids: string[]) => ({ ids, names: [], sampled: ids.length });

  test("DISJOINT MusicBrainz identities prove a conflation", () => {
    expect(verdictFor(id([MB_JPOP]), id([MB_DNB]))).toBe("CONFLATION (proven)");
  });

  test("a SHARED identity proves a genuine crossover", () => {
    expect(verdictFor(id([MB_DNB]), id([MB_DNB]))).toBe("crossover (proven)");
  });

  test("an overlap among several credits still reads as a crossover", () => {
    expect(verdictFor(id([MB_DNB, "other"]), id([MB_DNB]))).toBe("crossover (proven)");
  });

  test("either side unanswered is UNSURE — it never guesses", () => {
    expect(verdictFor(id([]), id([MB_DNB]))).toBe("unsure");
    expect(verdictFor(id([MB_JPOP]), id([]))).toBe("unsure");
  });
});

describe("localSignals", () => {
  const candidate = (impostor: Partial<Side>, clean: Partial<Side>): Candidate => ({
    artist: ARTISTS[0] as ArtistRow,
    clean: {
      creditSpellings: [],
      labels: [],
      sampleTitles: [],
      trackIds: [],
      tracks: 0,
      writers: [],
      ...clean,
    },
    impostor: {
      creditSpellings: [],
      labels: [],
      sampleTitles: [],
      trackIds: [],
      tracks: 0,
      writers: [],
      ...impostor,
    },
  });

  test("an impostor side written ONLY by the credit sweep reads as a probable crossover", () => {
    const signals = localSignals(candidate({ writers: ["credit-sweep"] }, {}));

    expect(signals.join(" ")).toContain("REAL crossover");
  });

  test("a name-only writer is named as such", () => {
    const signals = localSignals(candidate({ writers: ["crawl-link", "credit-sweep"] }, {}));

    expect(signals.join(" ")).toContain("crawl-link");
    expect(signals.join(" ")).not.toContain("REAL crossover");
  });

  test("divergent credit spellings surface the punctuation-fold fingerprint", () => {
    const signals = localSignals(
      candidate({ creditSpellings: ["K."] }, { creditSpellings: ["K"] }),
    );

    expect(signals.join(" ")).toContain("DIVERGES");
  });
});

describe("the run is READ-ONLY", () => {
  test("every statement it issues is a select, and it writes only its report file", async () => {
    const executed: string[] = [];
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map((a) => String(a)).join(" "));

    try {
      const code = await main(["--no-musicbrainz"], {
        load: async () => {
          executed.push("select …");

          return conflated();
        },
        lookup: async () => null,
      });

      expect(code).toBe(0);
      expect(executed.every((sql) => /^\s*select/i.test(sql))).toBe(true);
      expect(lines.join("\n")).toContain("Nothing was written to prod");
    } finally {
      console.log = original;
    }
  });

  test("no impostor labels at all is a clean no-op, not an empty sweep", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map((a) => String(a)).join(" "));

    try {
      const code = await main(["--no-musicbrainz"], {
        load: async () => ({ ...conflated(), namesakeSlugs: new Set<string>() }),
      });

      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("No impostor-walk labels found");
    } finally {
      console.log = original;
    }
  });

  test("--labels overrides the frontier-derived set", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map((a) => String(a)).join(" "));

    try {
      let received: string[] | undefined;
      await main(["--no-musicbrainz", "--labels", "radar-records|Cutting Edge"], {
        load: async (override) => {
          received = override;

          return conflated();
        },
      });

      expect(received).toEqual(["radar-records", "Cutting Edge"]);
    } finally {
      console.log = original;
    }
  });
});
