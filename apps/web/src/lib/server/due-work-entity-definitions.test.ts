import { describe, expect, it } from "vitest";
import {
  DUE_WORK_KINDS,
  DUE_WORK_SOURCE_COLUMNS,
  evaluateAlbumBio,
  evaluateAlbumCoverMaster,
  evaluateArtistBio,
  evaluateArtistCoverMaster,
  evaluateArtistImage,
  evaluateFindingContext,
  evaluateFindingEnrich,
  evaluateFindingNote,
  evaluateFindingObserve,
  evaluateFindingRender,
  evaluateLabelBio,
  evaluateLabelImage,
  type DueWorkRow,
  type EntityBioSource,
  type FindingNoteSource,
  type FindingObserveSource,
  type FindingRenderSource,
} from "./due-work-entity-definitions";

const NOW = "2026-08-26T12:00:00.000Z";
const OLD = "2026-07-25T00:00:00.000Z";
const FINDING_BASE = {
  added_at: "2026-08-01T00:00:00.000Z",
  context_note: "a context note",
  context_status: "resolved",
  observation_audio_url: "https://example.test/observation.mp3",
  track_id: "track-1",
  video_url: "https://example.test/video.mp4",
};

function expectEligible(row: DueWorkRow | null, kind: string, entityId: string): void {
  expect(row).not.toBeNull();
  if (row === null) {
    throw new Error("Expected an eligible due-work row");
  }
  expect(row.kind).toBe(kind);
  expect(row.entityId).toBe(entityId);
  expect(row.nextDueAt).toBe(NOW);
  expect(row.orderKey).toMatch(/^[0-9a-f]+$/);
  expect(row.sourceVersion).toContain(kind);
}

function comparableEntitySource(overrides: Partial<EntityBioSource> = {}): EntityBioSource {
  return {
    bio: null,
    certified_finding_count: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    id: "entity-1",
    renderable_track_count: 3,
    ...overrides,
  };
}

describe("due-work entity definitions", () => {
  it("exports the exact 14 kinds and their source-column inventories", () => {
    expect(DUE_WORK_KINDS).toEqual([
      "finding.enrich",
      "finding.context",
      "finding.context.retry-empty",
      "finding.note",
      "finding.observe",
      "finding.render",
      "finding.render.requires-observation",
      "artist.bio",
      "album.bio",
      "label.bio",
      "artist.cover-master",
      "album.cover-master",
      "label.image",
      "artist.image",
    ]);
    expect(DUE_WORK_SOURCE_COLUMNS["finding.context.retry-empty"]).toEqual(
      DUE_WORK_SOURCE_COLUMNS["finding.context"],
    );
    expect(DUE_WORK_SOURCE_COLUMNS["finding.render.requires-observation"]).toContain(
      "observation_audio_url",
    );
    expect(DUE_WORK_SOURCE_COLUMNS["artist.cover-master"]).toContain("image_url");
    expect(DUE_WORK_SOURCE_COLUMNS["artist.image"]).toEqual([
      "id",
      "image_url",
      "spotify_artist_id",
      "image_state",
    ]);
  });

  it.each([
    [
      "finding.enrich",
      () =>
        evaluateFindingEnrich(
          {
            added_at: FINDING_BASE.added_at,
            enrichment_status: "pending",
            track_id: FINDING_BASE.track_id,
            updated_at: null,
          },
          NOW,
        ),
      "track-1",
    ],
    [
      "finding.context",
      () =>
        evaluateFindingContext(
          {
            added_at: FINDING_BASE.added_at,
            context_note: null,
            context_status: "failed",
            track_id: FINDING_BASE.track_id,
          },
          NOW,
        ),
      "track-1",
    ],
    [
      "finding.context.retry-empty",
      () =>
        evaluateFindingContext(
          {
            added_at: FINDING_BASE.added_at,
            context_note: null,
            context_status: "empty",
            track_id: FINDING_BASE.track_id,
          },
          NOW,
          true,
        ),
      "track-1",
    ],
    [
      "finding.note",
      () =>
        evaluateFindingNote(
          {
            ...FINDING_BASE,
            note: "",
          } as FindingNoteSource,
          NOW,
        ),
      "track-1",
    ],
    [
      "finding.observe",
      () =>
        evaluateFindingObserve(
          {
            ...FINDING_BASE,
            observation_audio_url: null,
          } as FindingObserveSource,
          NOW,
        ),
      "track-1",
    ],
    [
      "finding.render",
      () =>
        evaluateFindingRender(
          {
            ...FINDING_BASE,
            video_url: null,
          } as FindingRenderSource,
          NOW,
        ),
      "track-1",
    ],
    [
      "finding.render.requires-observation",
      () =>
        evaluateFindingRender(
          {
            ...FINDING_BASE,
            video_url: null,
          } as FindingRenderSource,
          NOW,
          true,
        ),
      "track-1",
    ],
    ["artist.bio", () => evaluateArtistBio(comparableEntitySource(), NOW), "entity-1"],
    ["album.bio", () => evaluateAlbumBio(comparableEntitySource(), NOW), "entity-1"],
    ["label.bio", () => evaluateLabelBio(comparableEntitySource(), NOW), "entity-1"],
    [
      "artist.cover-master",
      () =>
        evaluateArtistCoverMaster(
          {
            image_attempted_at: null,
            image_state: "pending",
            image_url: "https://example.test/artist.jpg",
            slug: "artist-1",
          },
          NOW,
        ),
      "artist-1",
    ],
    [
      "album.cover-master",
      () =>
        evaluateAlbumCoverMaster(
          {
            image_attempted_at: null,
            image_state: "pending",
            slug: "album-1",
          },
          NOW,
        ),
      "album-1",
    ],
    [
      "label.image",
      () =>
        evaluateLabelImage(
          {
            image_attempted_at: null,
            image_state: "pending",
            slug: "label-1",
          },
          NOW,
        ),
      "label-1",
    ],
    [
      "artist.image",
      () =>
        evaluateArtistImage(
          {
            id: "artist-1",
            image_state: "pending",
            image_url: null,
            spotify_artist_id: "spotify-1",
          },
          NOW,
        ),
      "artist-1",
    ],
  ] as const)("evaluates eligible %s work", (_kind, evaluate, entityId) => {
    expectEligible(evaluate(), _kind, entityId);
  });

  it("uses strict stale and cooldown boundaries", () => {
    const staleBoundary = "2026-08-26T11:30:00.000Z";
    expect(
      evaluateFindingEnrich(
        {
          added_at: FINDING_BASE.added_at,
          enrichment_status: "processing",
          track_id: FINDING_BASE.track_id,
          updated_at: staleBoundary,
        },
        NOW,
      )?.nextDueAt,
    ).toBe("2026-08-26T12:00:00.001Z");
    expect(
      evaluateFindingEnrich(
        {
          added_at: FINDING_BASE.added_at,
          enrichment_status: "processing",
          track_id: FINDING_BASE.track_id,
          updated_at: "2026-08-26T11:29:59.999Z",
        },
        NOW,
      )?.nextDueAt,
    ).toBe(NOW);

    const cooldownBoundary = "2026-08-26T06:00:00.000Z";
    const album = {
      image_attempted_at: cooldownBoundary,
      image_state: "pending",
      slug: "album-1",
    };
    expect(evaluateAlbumCoverMaster(album, NOW)?.nextDueAt).toBe("2026-08-26T12:00:00.001Z");
    expect(
      evaluateAlbumCoverMaster({ ...album, image_attempted_at: "2026-08-26T05:59:59.999Z" }, NOW),
    ).not.toBeNull();
  });

  it("preserves null, status, retry, failure, and terminal-state semantics", () => {
    expect(
      evaluateFindingEnrich(
        {
          added_at: FINDING_BASE.added_at,
          enrichment_status: null,
          track_id: FINDING_BASE.track_id,
          updated_at: null,
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      evaluateFindingEnrich(
        {
          added_at: FINDING_BASE.added_at,
          enrichment_status: "processing",
          track_id: FINDING_BASE.track_id,
          updated_at: null,
        },
        NOW,
      ),
    ).not.toBeNull();

    const context = {
      added_at: FINDING_BASE.added_at,
      context_note: null,
      context_status: "empty",
      track_id: FINDING_BASE.track_id,
    };
    expect(evaluateFindingContext(context, NOW)).toBeNull();
    expect(evaluateFindingContext(context, NOW, true)).not.toBeNull();
    expect(evaluateFindingContext({ ...context, context_note: "" }, NOW, true)).toBeNull();

    expect(
      evaluateFindingNote({ ...FINDING_BASE, note: "  " } as FindingNoteSource, NOW),
    ).not.toBeNull();
    expect(
      evaluateFindingNote({ ...FINDING_BASE, note: "\t" } as FindingNoteSource, NOW),
    ).toBeNull();
    expect(
      evaluateFindingObserve(
        {
          ...FINDING_BASE,
          context_note: null,
          observation_audio_url: null,
        } as FindingObserveSource,
        NOW,
      ),
    ).toBeNull();
    expect(
      evaluateFindingRender(
        {
          ...FINDING_BASE,
          video_url: "",
        } as FindingRenderSource,
        NOW,
      ),
    ).toBeNull();
    expect(
      evaluateFindingRender(
        {
          ...FINDING_BASE,
          observation_audio_url: null,
          video_url: null,
        } as FindingRenderSource,
        NOW,
        true,
      ),
    ).toBeNull();

    expect(
      evaluateArtistBio(comparableEntitySource({ bio: " ", certified_finding_count: 0 }), NOW),
    ).not.toBeNull();
    expect(
      evaluateArtistBio(comparableEntitySource({ bio: null, renderable_track_count: 2 }), NOW),
    ).toBeNull();
    expect(
      evaluateArtistBio(comparableEntitySource({ bio: "\t", certified_finding_count: 0 }), NOW),
    ).toBeNull();

    expect(
      evaluateAlbumCoverMaster(
        {
          image_attempted_at: null,
          image_failures: 99,
          image_state: "pending",
          slug: "album-1",
        },
        NOW,
      ),
    ).not.toBeNull();
    expect(
      evaluateAlbumCoverMaster(
        {
          image_attempted_at: null,
          image_state: "none",
          slug: "album-1",
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      evaluateArtistCoverMaster(
        {
          image_attempted_at: null,
          image_state: "pending",
          image_url: null,
          slug: "artist-1",
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      evaluateArtistImage(
        {
          id: "artist-1",
          image_state: "pending",
          image_url: "",
          spotify_artist_id: "spotify-1",
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      evaluateArtistImage(
        {
          id: "artist-1",
          image_state: "pending",
          image_url: null,
          spotify_artist_id: null,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps oldest-first order in the encoded keys", () => {
    const older = evaluateFindingEnrich(
      {
        added_at: OLD,
        enrichment_status: "pending",
        track_id: "track-z",
        updated_at: null,
      },
      NOW,
    );
    const newer = evaluateFindingEnrich(
      {
        added_at: FINDING_BASE.added_at,
        enrichment_status: "pending",
        track_id: "track-a",
        updated_at: null,
      },
      NOW,
    );
    if (older === null || newer === null) {
      throw new Error("Expected both findings to be eligible");
    }
    expect(older.orderKey < newer.orderKey).toBe(true);

    const slugA = evaluateLabelImage(
      {
        image_attempted_at: null,
        image_state: "pending",
        slug: "a-label",
      },
      NOW,
    );
    const slugZ = evaluateLabelImage(
      {
        image_attempted_at: null,
        image_state: "pending",
        slug: "z-label",
      },
      NOW,
    );
    if (slugA === null || slugZ === null) {
      throw new Error("Expected both labels to be eligible");
    }
    expect(slugA.orderKey < slugZ.orderKey).toBe(true);

    const entityA = evaluateArtistBio(
      comparableEntitySource({ created_at: NOW, id: "entity-a" }),
      NOW,
    );
    const entityZ = evaluateArtistBio(
      comparableEntitySource({ created_at: NOW, id: "entity-z" }),
      NOW,
    );
    if (entityA === null || entityZ === null) {
      throw new Error("Expected both entities to be eligible");
    }
    expect(entityA.orderKey < entityZ.orderKey).toBe(true);
  });

  it("versions only the selected eligibility and order fields", () => {
    const base = evaluateFindingEnrich(
      {
        added_at: FINDING_BASE.added_at,
        enrichment_status: "pending",
        track_id: FINDING_BASE.track_id,
        updated_at: null,
      },
      NOW,
    );
    const changedStatus = evaluateFindingEnrich(
      {
        added_at: FINDING_BASE.added_at,
        enrichment_status: "failed",
        track_id: FINDING_BASE.track_id,
        updated_at: null,
      },
      NOW,
    );
    if (base === null || changedStatus === null) {
      throw new Error("Expected both findings to be eligible");
    }
    expect(changedStatus.sourceVersion).not.toBe(base.sourceVersion);
    expect(changedStatus.orderKey).toBe(base.orderKey);
    expect(base.nextDueAt).toBe(NOW);
  });
});
