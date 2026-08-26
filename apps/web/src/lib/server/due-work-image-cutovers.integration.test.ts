import { type DiscogsLabelCandidate } from "@fluncle/contracts/orpc";
import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";
import { upsertDueWork, type DueWorkProjection, type DueWorkSubjectType } from "./due-work";
import { encodeDueWorkOrder } from "./due-work-order";
import { deleteSetting, setSetting } from "./settings";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillArtistImages } from "./backfill-artist-images";
import { resolveCoverMasters } from "./cover-masters";
import { TRACK_WORK_DUE_CUTOVER_ENABLED_KEY } from "./due-work-cutover";
import { resolveLabelImages } from "./label-images";

let db: Client;

const NOW = "2026-01-01T00:00:00.000Z";

function fakeBucket(): Pick<R2Bucket, "put"> {
  return {
    put: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as Pick<R2Bucket, "put">;
}

function textOrder(value: string): string {
  return encodeDueWorkOrder([{ direction: "asc", kind: "text", value }]);
}

async function project(
  workKind: string,
  subjectType: DueWorkSubjectType,
  subjectId: string,
): Promise<void> {
  const projection: DueWorkProjection<string> = {
    nextDueAt: NOW,
    sortKey: textOrder(subjectId),
    sourceVersion: `test:${workKind}:${subjectId}`,
    state: "scheduled",
    subjectId,
    subjectType,
    workKind,
  };
  await upsertDueWork(db, projection, { now: NOW });
}

async function seedAlbum(slug: string): Promise<void> {
  await db.execute({
    args: [`album-${slug}`, slug, slug, NOW, NOW],
    sql: `insert into albums (id, name, slug, created_at, updated_at)
          values (?, ?, ?, ?, ?)`,
  });
}

async function seedArtist(
  id: string,
  slug: string,
  options: { imageUrl?: string; spotifyArtistId?: string } = {},
): Promise<void> {
  await db.execute({
    args: [id, slug, slug, options.imageUrl ?? null, options.spotifyArtistId ?? null, NOW, NOW],
    sql: `insert into artists
            (id, name, slug, image_url, spotify_artist_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function seedLabel(slug: string): Promise<void> {
  await db.execute({
    args: [`label-${slug}`, slug, slug, NOW, NOW],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, 'undecided', ?, ?)`,
  });
}

function discogsCandidate(slug: string): DiscogsLabelCandidate {
  return {
    detail: { id: 1, images: [] },
    discogsLabelId: 1,
    slug,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

afterEach(() => {
  db.close();
});

describe("Goal C cover and image selector cutovers", () => {
  it("keeps the default-off album selector, then promotes, bounds, orders, and resumes the projection", async () => {
    await seedAlbum("legacy-only");
    await seedAlbum("alpha");
    await seedAlbum("beta");
    await project("album.cover-master", "album", "beta");
    await project("album.cover-master", "album", "alpha");

    const bucket = fakeBucket();
    const legacy = await resolveCoverMasters(bucket, "album", 10, true);
    expect(legacy.resolved).toEqual(["alpha", "beta", "legacy-only"]);

    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");
    const execute = vi.spyOn(db, "execute");
    const first = await resolveCoverMasters(bucket, "album", 1, true);
    expect(first.resolved).toEqual(["alpha"]);
    expect(first.nextCursor).toBe("alpha");

    const hydration = execute.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (statement): statement is { args?: unknown[]; sql: string } =>
          typeof statement === "object" &&
          statement !== null &&
          "sql" in statement &&
          typeof statement.sql === "string" &&
          statement.sql.includes("from albums") &&
          statement.sql.includes("slug in (?)"),
      );
    expect(hydration?.args).toEqual(["alpha"]);

    const second = await resolveCoverMasters(bucket, "album", 1, true, "alpha");
    expect(second.resolved).toEqual(["beta"]);
    expect(second.nextCursor).toBe("beta");
    expect(second.resolved).not.toContain("legacy-only");

    await deleteSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY);
  });

  it("hydrates artist cover masters only from their projected slug page", async () => {
    await seedArtist("artist-z", "zulu", { imageUrl: "https://i.scdn.co/image/zulu" });
    await seedArtist("artist-a", "alpha", { imageUrl: "https://i.scdn.co/image/alpha" });
    await project("artist.cover-master", "artist", "zulu");
    await project("artist.cover-master", "artist", "alpha");
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    const result = await resolveCoverMasters(fakeBucket(), "artist", 1, true);
    expect(result.resolved).toEqual(["alpha"]);
    expect(result.nextCursor).toBe("alpha");
  });

  it("intersects supplied label evidence with projection order and keeps its cursor ignored", async () => {
    await seedLabel("alpha");
    await seedLabel("beta");
    await seedLabel("not-projected");
    await project("label.image", "label", "beta");
    await project("label.image", "label", "alpha");
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    const result = await resolveLabelImages(fakeBucket(), 4, true, "zulu", {
      discogsCandidates: [discogsCandidate("beta"), discogsCandidate("not-projected")],
    });

    expect(result.resolved).toEqual(["beta"]);
    expect(result.nextCursor).toBeNull();
  });

  it("dry-runs artist images from a bounded ID projection while retaining exact corpus depth", async () => {
    await seedArtist("artist-z", "zulu", { spotifyArtistId: "spotify-z" });
    await seedArtist("artist-a", "alpha", { spotifyArtistId: "spotify-a" });
    await seedArtist("artist-unprojected", "unprojected", {
      spotifyArtistId: "spotify-unprojected",
    });
    await project("artist.image", "artist", "artist-z");
    await project("artist.image", "artist", "artist-a");
    await setSetting(TRACK_WORK_DUE_CUTOVER_ENABLED_KEY, "true");

    const result = await backfillArtistImages(1, true);
    expect(result.filled).toEqual(["artist-a"]);
    expect(result.checkedCount).toBe(1);
    expect(result.nextCursor).toBe("artist-a");
    expect(result.queueDepth).toBe(3);

    const finalFullPage = await backfillArtistImages(1, true, "artist-a");
    expect(finalFullPage.filled).toEqual(["artist-z"]);
    expect(finalFullPage.nextCursor).toBe("artist-z");
  });
});
