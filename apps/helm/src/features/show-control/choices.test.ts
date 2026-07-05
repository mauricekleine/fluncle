import { describe, expect, test } from "bun:test";

import { type MixtapeDTO, type RecordingDTO } from "@fluncle/contracts";

import { buildChoices, mixtapeToChoice, planToChoice } from "./choices";

// Minimal DTO builders — only the fields the picker mapping reads.
function recording(overrides: Partial<RecordingDTO>): RecordingDTO {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    hasVideo: false,
    id: "rec_1",
    title: "amber-drift-roller",
    tracklist: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function mixtape(overrides: Partial<MixtapeDTO>): MixtapeDTO {
  return {
    artists: ["Fluncle"],
    externalUrls: {},
    memberCount: 0,
    members: [],
    status: "published",
    title: "Mixtape One",
    type: "mixtape",
    ...overrides,
  };
}

const cue = { artists: ["x"], id: "cue_1", title: "y" };

describe("planToChoice", () => {
  test("a videoless recording maps to a plan raised by its galaxy-slug handle", () => {
    const choice = planToChoice(
      recording({
        hasVideo: false,
        plannedFor: "2026-07-10T20:00:00.000Z",
        title: "dark-aurora-roller",
        tracklist: [cue, cue, cue],
      }),
    );

    expect(choice).toEqual({
      count: 3,
      countLabel: "3 cues",
      handle: "dark-aurora-roller",
      kind: "plan",
      recordedAt: "2026-07-10T20:00:00.000Z",
      ref: "dark-aurora-roller",
      title: "dark-aurora-roller",
    });
  });

  test("one cue reads singular", () => {
    expect(planToChoice(recording({ tracklist: [cue] })).countLabel).toBe("1 cue");
  });
});

describe("mixtapeToChoice", () => {
  test("a published mixtape maps to a choice raised by its Log ID coordinate", () => {
    const choice = mixtapeToChoice(
      mixtape({ memberCount: 18, recordedAt: "2026-06-01T00:00:00.000Z", title: "Night Drive" }),
      "019.F.1A",
    );

    expect(choice).toEqual({
      count: 18,
      countLabel: "18 tracks",
      handle: "019.F.1A",
      kind: "mixtape",
      recordedAt: "2026-06-01T00:00:00.000Z",
      ref: "019.F.1A",
      title: "Night Drive",
    });
  });
});

describe("buildChoices", () => {
  test("groups plans → mixtapes → takes, newest-first within each group", () => {
    const recordings: RecordingDTO[] = [
      recording({ id: "p1", plannedFor: "2026-07-01T00:00:00.000Z", title: "older-plan" }),
      recording({ id: "p2", plannedFor: "2026-07-09T00:00:00.000Z", title: "newer-plan" }),
    ];
    const mixtapes: MixtapeDTO[] = [
      mixtape({ logId: "018.F.2B", recordedAt: "2026-05-01T00:00:00.000Z", title: "May set" }),
    ];

    expect(buildChoices(recordings, mixtapes).map((c) => `${c.kind}:${c.ref}`)).toEqual([
      "plan:newer-plan",
      "plan:older-plan",
      "mixtape:018.F.2B",
    ]);
  });

  test("a promoted take is represented by its mixtape, not listed twice", () => {
    const promotedTake = recording({
      hasVideo: true,
      id: "t1",
      logId: "019.F.1A",
      title: "Saturday set",
    });
    const itsMixtape = mixtape({ logId: "019.F.1A", memberCount: 12, title: "Saturday set" });

    const choices = buildChoices([promotedTake], [itsMixtape]);

    expect(choices).toHaveLength(1);
    expect(choices[0]?.kind).toBe("mixtape");
    expect(choices[0]?.ref).toBe("019.F.1A");
  });

  test("an un-promoted take (video, no coordinate) is not a raisable tracklist", () => {
    const rawTake = recording({ hasVideo: true, id: "t2", logId: undefined, title: "rolling set" });

    expect(buildChoices([rawTake], [])).toEqual([]);
  });

  test("a promoted take whose mixtape isn't in the list survives, raised by its Log ID", () => {
    const orphanPromoted = recording({
      hasVideo: true,
      id: "t3",
      logId: "020.F.3C",
      recordedAt: "2026-06-15T00:00:00.000Z",
      title: "Orphan take",
      tracklist: [cue, cue],
    });

    const choices = buildChoices([orphanPromoted], []);

    expect(choices).toEqual([
      {
        count: 2,
        countLabel: "2 cues",
        handle: "020.F.3C",
        kind: "take",
        recordedAt: "2026-06-15T00:00:00.000Z",
        ref: "020.F.3C",
        title: "Orphan take",
      },
    ]);
  });

  test("a mixtape with no Log ID is dropped — nothing to raise on", () => {
    expect(buildChoices([], [mixtape({ logId: undefined })])).toEqual([]);
  });
});
