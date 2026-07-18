import { type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FrontierEditionTrackInput,
  frontierEditionInsertStatements,
} from "./frontier-editions";
import { type PublicUser } from "./public-auth";
import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE PER-USER RECOMMENDATION ENGINE, PROVEN — against the REAL schema, with
// vectors we control (the catalogue.integration.test.ts discipline). The engine
// promises a listener specific things: their seeds are theirs alone, the cap
// holds, an excluded row (duplicate / dismissed / long-form / un-anchored /
// certified / their own seed) never lands in the catalogue list, the findings
// slots carry Fluncle's voice (note + Log ID), the diversity decay spreads the
// page without rewriting a score, and an unverified email is a 403 — never a
// silent empty. Each is asserted here through the real SQL on a real libSQL
// engine built from the generated migrations.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const DIMS = 1024;

/** A unit vector pointing along one axis — an "artificial genre" we can aim tracks at. */
function axis(index: number): number[] {
  const vector = Array.from<number>({ length: DIMS }).fill(0);
  vector[index] = 1;

  return vector;
}

/** Normalize, so every fixture vector is unit-length like a real MuQ vector. */
function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return vector.map((value) => value / norm);
}

/** A vector `weight` of the way from `from` toward `toward` — a controlled near-neighbour. */
function blend(from: number[], toward: number[], weight: number): number[] {
  return unit(from.map((value, index) => value * (1 - weight) + (toward[index] ?? 0) * weight));
}

/** The write the embed pipeline performs: the validated JSON → ranked F32_BLOB. */
async function embed(trackId: string, vector: number[]): Promise<void> {
  await db.execute({
    args: [JSON.stringify(vector), trackId],
    sql: `update tracks set embedding_blob = vector32(?) where track_id = ?`,
  });
}

function publicUser(id: string, emailVerified = true): PublicUser {
  return {
    createdAt: new Date().toISOString(),
    email: `${id}@example.com`,
    emailVerified,
    id,
    name: id,
    username: id,
  };
}

type CatalogueSeedOptions = {
  artists?: string[];
  vector?: number[];
};

/** A catalogue track (no findings row), embedded when a vector is given. */
async function seedCatalogue(trackId: string, options: CatalogueSeedOptions = {}): Promise<void> {
  await seedCatalogueTrack(db, {
    artists: options.artists ?? ["Catalogue Artist"],
    title: `Catalogue ${trackId}`,
    trackId,
  });

  if (options.vector) {
    await embed(trackId, options.vector);
  }
}

/** A certified finding, embedded when a vector is given, with an optional note. */
async function seedFinding(
  trackId: string,
  options: CatalogueSeedOptions & { logId?: string; note?: string } = {},
): Promise<void> {
  await seedTrack(db, {
    artists: options.artists ?? ["Finding Artist"],
    logId: options.logId ?? `00${trackId.slice(-1)}.1.1A`,
    title: `Finding ${trackId}`,
    trackId,
  });

  if (options.note) {
    await db.execute({
      args: [options.note, trackId],
      sql: `update findings set note = ? where track_id = ?`,
    });
  }

  if (options.vector) {
    await embed(trackId, options.vector);
  }
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

// ── The seed set: CRUD, the cap, the scoping ─────────────────────────────────

describe("rec seeds (real SQL)", () => {
  it("saves by trackId AND by Log ID, lists hydrated newest-first, and only a finding carries a logId", async () => {
    const { listRecSeeds, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");

    await seedFinding("finding-1", { logId: "001.1.1A" });
    await seedCatalogue("catalogue-1");

    // By Log ID (the finding), then by trackId (the catalogue row — it HAS no Log ID).
    const first = await saveRecSeed(user, { logId: "001.1.1A" });
    const second = await saveRecSeed(user, { trackId: "catalogue-1" });

    expect(first).not.toBeInstanceOf(Response);
    expect(second).not.toBeInstanceOf(Response);

    if (!(first instanceof Response)) {
      expect(first.seed.trackId).toBe("finding-1");
      expect(first.seed.logId).toBe("001.1.1A");
    }

    const list = await listRecSeeds(user);

    expect(list.seeds.map((seed) => seed.trackId)).toEqual(["catalogue-1", "finding-1"]);

    const catalogueSeed = list.seeds.find((seed) => seed.trackId === "catalogue-1");
    const findingSeed = list.seeds.find((seed) => seed.trackId === "finding-1");

    // Hydrated for recognition; the catalogue seed stays coordinate-less.
    expect(catalogueSeed?.title).toBe("Catalogue catalogue-1");
    expect(catalogueSeed?.artists).toEqual(["Catalogue Artist"]);
    expect(catalogueSeed?.logId).toBeUndefined();
    expect(findingSeed?.logId).toBe("001.1.1A");
  });

  it("rejects an unknown track with 404 and a junk body with 400", async () => {
    const { saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");

    const missing = await saveRecSeed(user, { trackId: "never-seen" });

    expect(missing).toBeInstanceOf(Response);

    if (missing instanceof Response) {
      expect(missing.status).toBe(404);
    }

    const junk = await saveRecSeed(user, "not-an-object");

    expect(junk).toBeInstanceOf(Response);

    if (junk instanceof Response) {
      expect(junk.status).toBe(400);
    }
  });

  it("enforces the 12-seed cap with a 409, while re-adding an existing seed stays allowed", async () => {
    const { listRecSeeds, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");

    for (let index = 0; index < 13; index += 1) {
      await seedCatalogue(`cat-${index}`);
    }

    for (let index = 0; index < 12; index += 1) {
      const saved = await saveRecSeed(user, { trackId: `cat-${index}` });

      expect(saved).not.toBeInstanceOf(Response);
    }

    // The 13th NEW seed breaks the cap.
    const thirteenth = await saveRecSeed(user, { trackId: "cat-12" });

    expect(thirteenth).toBeInstanceOf(Response);

    if (thirteenth instanceof Response) {
      expect(thirteenth.status).toBe(409);

      const body = (await thirteenth.json()) as { code: string };

      expect(body.code).toBe("seed_limit");
    }

    // Re-adding an EXISTING seed at the cap is a refresh, never a breach.
    const refreshed = await saveRecSeed(user, { trackId: "cat-3" });

    expect(refreshed).not.toBeInstanceOf(Response);
    expect((await listRecSeeds(user)).seeds).toHaveLength(12);
  });

  it("deletes by trackId, 404s an unknown track, and no-ops a never-seeded one", async () => {
    const { deleteRecSeed, listRecSeeds, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");

    await seedCatalogue("cat-1");
    await seedCatalogue("cat-2");
    await saveRecSeed(user, { trackId: "cat-1" });

    const removed = await deleteRecSeed(user, "cat-1");

    expect(removed).not.toBeInstanceOf(Response);
    expect((await listRecSeeds(user)).seeds).toHaveLength(0);

    // A real track that was never a seed: a quiet { ok: true }, the unsave discipline.
    const noop = await deleteRecSeed(user, "cat-2");

    expect(noop).not.toBeInstanceOf(Response);

    // A track that does not exist at all: 404.
    const missing = await deleteRecSeed(user, "never-seen");

    expect(missing).toBeInstanceOf(Response);

    if (missing instanceof Response) {
      expect(missing.status).toBe(404);
    }
  });

  it("scopes seeds per user: A's seeds are invisible to B, and B's delete cannot touch A's row", async () => {
    const { deleteRecSeed, listRecSeeds, saveRecSeed } = await import("./recommendations");
    const userA = publicUser("user-A");
    const userB = publicUser("user-B");

    await seedCatalogue("cat-1");
    await saveRecSeed(userA, { trackId: "cat-1" });

    expect((await listRecSeeds(userB)).seeds).toHaveLength(0);

    // B "removes" the track — a no-op on B's empty set, and A's seed survives.
    await deleteRecSeed(userB, "cat-1");

    expect((await listRecSeeds(userA)).seeds).toHaveLength(1);
  });
});

// ── The engine: the gate, the exclusions, the blend, the decay ───────────────

describe("listRecommendations (real SQL)", () => {
  it("403s an unverified email with the email_unverified code — the learning-cohort gate", async () => {
    const { listRecommendations } = await import("./recommendations");

    const result = await listRecommendations(publicUser("user-A", false));

    expect(result).toBeInstanceOf(Response);

    if (result instanceof Response) {
      expect(result.status).toBe(403);

      const body = (await result.json()) as { code: string };

      expect(body.code).toBe("email_unverified");
    }
  });

  it("never recommends an excluded row: duplicate, dismissed, long-form, un-anchored, certified, or the seed itself", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    // The seed: a catalogue track the user picked, embedded at the home axis.
    await seedCatalogue("seed-1", { vector: home });
    await saveRecSeed(user, { trackId: "seed-1" });

    // Every candidate sits NEAR the seed — close enough to win a slot on
    // similarity alone — so an absence below is the exclusion working, never
    // the ranking losing them.
    await seedCatalogue("good-1", { vector: blend(home, axis(1), 0.1) });
    await seedCatalogue("dup-1", { vector: blend(home, axis(2), 0.1) });
    await seedCatalogue("dismissed-1", { vector: blend(home, axis(3), 0.1) });
    await seedCatalogue("longform-1", { vector: blend(home, axis(4), 0.1) });
    await seedCatalogue("unanchored-1", { vector: blend(home, axis(5), 0.1) });
    await seedFinding("finding-1", { logId: "001.1.1A", vector: blend(home, axis(6), 0.1) });

    await db.execute(
      `update tracks set duplicate_of_track_id = 'finding-1' where track_id = 'dup-1'`,
    );
    await db.execute(
      `update tracks set dismissed_at = '2026-01-01T00:00:00.000Z' where track_id = 'dismissed-1'`,
    );
    // LONG_FORM_MS is 15 minutes; sit the mix just past it.
    await db.execute(`update tracks set duration_ms = 900000 where track_id = 'longform-1'`);
    await db.execute(`update tracks set spotify_uri = null where track_id = 'unanchored-1'`);

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    const catalogueIds = result.catalogue.map((row) => row.trackId);

    // The one clean candidate is recommended; every excluded class is absent.
    expect(catalogueIds).toEqual(["good-1"]);
    // The certified finding never rides the catalogue list — it is a labeled slot.
    expect(result.findings.map((row) => row.trackId)).toEqual(["finding-1"]);
    // And the user's own seed is in neither half.
    expect(catalogueIds).not.toContain("seed-1");
  });

  it("carries the findings slots with note + logId (Fluncle's voice) and the catalogue rows with nothing editorial", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    await seedCatalogue("seed-1", { vector: home });
    await saveRecSeed(user, { trackId: "seed-1" });

    // Four findings at staggered distances: the slots take the nearest 3.
    await seedFinding("find-1", {
      logId: "001.1.1A",
      note: "this one goes off",
      vector: blend(home, axis(1), 0.05),
    });
    await seedFinding("find-2", { logId: "002.1.1A", vector: blend(home, axis(1), 0.1) });
    await seedFinding("find-3", { logId: "003.1.1A", vector: blend(home, axis(1), 0.15) });
    await seedFinding("find-4", { logId: "004.1.1A", vector: blend(home, axis(1), 0.2) });

    await seedCatalogue("cat-1", { vector: blend(home, axis(2), 0.1) });

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    // 3 slots, nearest first, the farthest finding cut.
    expect(result.findings.map((row) => row.trackId)).toEqual(["find-1", "find-2", "find-3"]);

    const nearest = result.findings[0];

    expect(nearest?.logId).toBe("001.1.1A");
    expect(nearest?.note).toBe("this one goes off");
    expect(nearest?.similarity).toBeGreaterThan(0.9);

    // A finding without a note still carries its coordinate; note is simply absent.
    expect(result.findings[1]?.logId).toBe("002.1.1A");
    expect(result.findings[1]?.note).toBeUndefined();

    // The instrument register: a catalogue row carries NO editorial field at all.
    const catalogueRow = result.catalogue[0] as unknown as Record<string, unknown>;

    expect(catalogueRow.trackId).toBe("cat-1");
    expect(catalogueRow).not.toHaveProperty("note");
    expect(catalogueRow).not.toHaveProperty("logId");
  });

  it("carries the instrument readout (bpm/durationMs/key/year) onto BOTH registers, and omits a field the row cannot back", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    await seedCatalogue("seed-1", { vector: home });
    await saveRecSeed(user, { trackId: "seed-1" });

    // A finding and a catalogue row, each near the seed so both win a slot, each carrying the
    // full readout in the DB (duration_ms is the fixture default, 270_000ms → 4:30).
    await seedFinding("find-1", { logId: "001.1.1A", vector: blend(home, axis(1), 0.05) });
    await seedCatalogue("cat-1", { vector: blend(home, axis(2), 0.05) });

    await db.execute(
      `update tracks set bpm = 174, key = 'A minor', release_date = '2014-06-01'
        where track_id = 'find-1'`,
    );
    // The catalogue row carries no release_date — its year must come back UNDEFINED (honest
    // absence, The Readout Rule), while its bpm/key/duration still land.
    await db.execute(
      `update tracks set bpm = 172, key = 'F minor', release_date = null where track_id = 'cat-1'`,
    );

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    const finding = result.findings.find((row) => row.trackId === "find-1");
    const catalogue = result.catalogue.find((row) => row.trackId === "cat-1");

    // The findings register — every chip plus the year.
    expect(finding?.bpm).toBe(174);
    expect(finding?.durationMs).toBe(270_000);
    expect(finding?.key).toBe("A minor");
    expect(finding?.year).toBe("2014");

    // The catalogue register — chips land; the missing release_date drops the year, never fakes it.
    expect(catalogue?.bpm).toBe(172);
    expect(catalogue?.durationMs).toBe(270_000);
    expect(catalogue?.key).toBe("F minor");
    expect(catalogue?.year).toBeUndefined();
  });

  it("applies the diversity decay: two same-artist clones don't both outrank a fresh artist, and the DISPLAYED score stays the true similarity", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    await seedCatalogue("seed-1", { vector: home });
    await saveRecSeed(user, { trackId: "seed-1" });

    // Raw similarity order: clone-1 (~.9986) > clone-2 (~.9939) > fresh-1 (~.9848).
    // After one same-artist pick, clone-2 decays ×0.97 (~.964) — below fresh-1 —
    // so the page reads clone-1, fresh-1, clone-2.
    await seedCatalogue("clone-1", {
      artists: ["Same Artist"],
      vector: blend(home, axis(1), 0.05),
    });
    await seedCatalogue("clone-2", { artists: ["Same Artist"], vector: blend(home, axis(1), 0.1) });
    await seedCatalogue("fresh-1", {
      artists: ["Fresh Artist"],
      vector: blend(home, axis(1), 0.15),
    });

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.catalogue.map((row) => row.trackId)).toEqual(["clone-1", "fresh-1", "clone-2"]);

    // The decay re-orders, never rewrites: clone-2 still DISPLAYS its true
    // (higher) similarity even though it now sits below fresh-1.
    const clone2 = result.catalogue.find((row) => row.trackId === "clone-2");
    const fresh1 = result.catalogue.find((row) => row.trackId === "fresh-1");

    expect(clone2 && fresh1 && clone2.similarity > fresh1.similarity).toBe(true);
  });

  it("ranks the catalogue by MAX-similarity across the seed set, never a centroid", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");

    // Two seeds on ORTHOGONAL axes — a bimodal taste, the operator's own shape.
    await seedCatalogue("seed-a", { vector: axis(0) });
    await seedCatalogue("seed-b", { vector: axis(1) });
    await saveRecSeed(user, { trackId: "seed-a" });
    await saveRecSeed(user, { trackId: "seed-b" });

    // A dead ringer for seed B alone, and a mediocre middle-of-the-road blend.
    // Under max-similarity the ringer wins (~1.0 to B); under a centroid the
    // middler would (it hugs the mean of A and B).
    await seedCatalogue("ringer-b", { artists: ["Ringer"], vector: blend(axis(1), axis(2), 0.02) });
    await seedCatalogue("middler", {
      artists: ["Middler"],
      vector: unit(axis(0).map((value, index) => value + (axis(1)[index] ?? 0))),
    });

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.catalogue[0]?.trackId).toBe("ringer-b");
    expect(result.seedsUsed).toBe(2);
  });

  it("skips a vectorless seed HONESTLY (named in seedsSkipped), and returns empty lists when no seed has a vector", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    // One measured seed, one whose audio was never captured.
    await seedCatalogue("seed-1", { vector: home });
    await seedCatalogue("seed-2");
    await saveRecSeed(user, { trackId: "seed-1" });
    await saveRecSeed(user, { trackId: "seed-2" });

    await seedCatalogue("cat-1", { vector: blend(home, axis(1), 0.1) });

    const result = await listRecommendations(user);

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    expect(result.seedsUsed).toBe(1);
    expect(result.seedsSkipped).toEqual(["seed-2"]);
    expect(result.catalogue.map((row) => row.trackId)).toEqual(["cat-1"]);

    // A user whose EVERY seed is unmeasured gets the honest empty, never a 500.
    const userB = publicUser("user-B");

    await seedCatalogue("seed-3");
    await saveRecSeed(userB, { trackId: "seed-3" });

    const emptyResult = await listRecommendations(userB);

    expect(emptyResult).not.toBeInstanceOf(Response);

    if (emptyResult instanceof Response) {
      return;
    }

    expect(emptyResult.catalogue).toEqual([]);
    expect(emptyResult.findings).toEqual([]);
    expect(emptyResult.seedsUsed).toBe(0);
    expect(emptyResult.seedsSkipped).toEqual(["seed-3"]);
  });

  it("computes recommendations from the requesting user's OWN seeds only", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const userA = publicUser("user-A");
    const userB = publicUser("user-B");

    // A seeds axis 0; B seeds axis 1. One candidate near each axis.
    await seedCatalogue("seed-a", { vector: axis(0) });
    await seedCatalogue("seed-b", { vector: axis(1) });
    await saveRecSeed(userA, { trackId: "seed-a" });
    await saveRecSeed(userB, { trackId: "seed-b" });

    await seedCatalogue("near-a", { artists: ["Near A"], vector: blend(axis(0), axis(2), 0.05) });
    await seedCatalogue("near-b", { artists: ["Near B"], vector: blend(axis(1), axis(2), 0.05) });

    const resultA = await listRecommendations(userA);
    const resultB = await listRecommendations(userB);

    if (resultA instanceof Response || resultB instanceof Response) {
      expect.unreachable("both users are verified — neither read may fail");

      return;
    }

    // Each user's page leads with the candidate near THEIR axis — the seed sets
    // never bleed across accounts.
    expect(resultA.catalogue[0]?.trackId).toBe("near-a");
    expect(resultB.catalogue[0]?.trackId).toBe("near-b");
  });
});

// ── Frontier novelty: the excludeRecent flag over the editions ledger ─────────

describe("listRecommendations excludeRecent (real SQL)", () => {
  /** Freeze an edition holding the given track ids — the exact builder A2 uses. */
  async function insertEdition(
    userId: string,
    trackIds: Array<{ slot?: "catalogue" | "finding"; trackId: string }>,
  ): Promise<void> {
    const tracks: FrontierEditionTrackInput[] = trackIds.map((entry, index) => ({
      artists: ["Frozen Artist"],
      position: index + 1,
      slot: entry.slot ?? "catalogue",
      title: `Frozen ${entry.trackId}`,
      trackId: entry.trackId,
    }));

    await db.batch(
      frontierEditionInsertStatements({
        createdAt: new Date().toISOString(),
        editionId: randomUUID(),
        tracks,
        userId,
      }),
      "write",
    );
  }

  it("default (and explicit false) is byte-identical to today — editions present are ignored", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    await seedCatalogue("seed-1", { vector: home });
    await saveRecSeed(user, { trackId: "seed-1" });
    await seedCatalogue("cat-1", { vector: blend(home, axis(1), 0.1) });

    // The behaviour BEFORE any edition exists.
    const baseline = await listRecommendations(user);

    // Freeze an edition that holds the candidate — this WOULD exclude it if novelty were on.
    await insertEdition("user-A", [{ trackId: "cat-1" }]);

    const withDefault = await listRecommendations(user);
    const withExplicitFalse = await listRecommendations(user, { excludeRecent: false });

    // Neither the default nor an explicit false consults the ledger: both equal the
    // pre-edition baseline byte-for-byte, and the candidate is still recommended.
    expect(withDefault).toEqual(baseline);
    expect(withExplicitFalse).toEqual(baseline);

    if (withDefault instanceof Response) {
      expect.unreachable("a verified user's read never faults");

      return;
    }

    expect(withDefault.catalogue.map((row) => row.trackId)).toContain("cat-1");
  });

  it("excludeRecent:true drops every track in the last editions from BOTH registers", async () => {
    const { listRecommendations, saveRecSeed } = await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    await seedCatalogue("seed-1", { vector: home });
    await saveRecSeed(user, { trackId: "seed-1" });

    // Two catalogue + two finding candidates, all near the seed so all would win a slot.
    await seedCatalogue("cat-recent", { vector: blend(home, axis(1), 0.05) });
    await seedCatalogue("cat-clean", { vector: blend(home, axis(2), 0.05) });
    await seedFinding("find-recent", { logId: "001.1.1A", vector: blend(home, axis(3), 0.05) });
    await seedFinding("find-clean", { logId: "002.1.1A", vector: blend(home, axis(4), 0.05) });

    // A recent edition froze one of each — the novelty window must drop both.
    await insertEdition("user-A", [
      { trackId: "cat-recent" },
      { slot: "finding", trackId: "find-recent" },
    ]);

    const result = await listRecommendations(user, { excludeRecent: true });

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    const catalogueIds = result.catalogue.map((row) => row.trackId);
    const findingIds = result.findings.map((row) => row.trackId);

    expect(catalogueIds).not.toContain("cat-recent");
    expect(findingIds).not.toContain("find-recent");
    // The clean candidates — in no edition — still ride.
    expect(catalogueIds).toContain("cat-clean");
    expect(findingIds).toContain("find-clean");
  });

  it("only the last FRONTIER_NOVELTY_WINDOW editions exclude — an older one no longer does", async () => {
    const { FRONTIER_NOVELTY_WINDOW, listRecommendations, saveRecSeed } =
      await import("./recommendations");
    const user = publicUser("user-A");
    const home = axis(0);

    await seedCatalogue("seed-1", { vector: home });
    await saveRecSeed(user, { trackId: "seed-1" });
    await seedCatalogue("cat-old", { vector: blend(home, axis(1), 0.05) });
    await seedCatalogue("cat-recent", { vector: blend(home, axis(2), 0.05) });

    // The oldest edition holds cat-old...
    await insertEdition("user-A", [{ trackId: "cat-old" }]);

    // ...then exactly FRONTIER_NOVELTY_WINDOW newer filler editions push it out of the window.
    for (let index = 0; index < FRONTIER_NOVELTY_WINDOW - 1; index += 1) {
      await insertEdition("user-A", [{ trackId: `filler-${index}` }]);
    }

    // The newest edition (the window's leading edge) holds cat-recent.
    await insertEdition("user-A", [{ trackId: "cat-recent" }]);

    const result = await listRecommendations(user, { excludeRecent: true });

    expect(result).not.toBeInstanceOf(Response);

    if (result instanceof Response) {
      return;
    }

    const catalogueIds = result.catalogue.map((row) => row.trackId);

    // cat-old aged out of the window, so it returns; cat-recent is still inside it.
    expect(catalogueIds).toContain("cat-old");
    expect(catalogueIds).not.toContain("cat-recent");
  });
});
