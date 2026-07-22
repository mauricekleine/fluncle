import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedCatalogueTrack, seedTrack } from "./integration-db";

// THE EAR'S RANKING, PROVEN — against the REAL schema, with vectors we control.
//
// The claim The Ear makes to the operator is a specific one: "this track is close to THAT
// finding." A ranking nobody verified is a ranking nobody can trust, and the SQL that
// produces it (a cross join through `vector_distance_cos`, a window function picking each
// candidate's single nearest finding) cannot be checked by reading it. So these cases seed
// catalogue tracks whose embeddings are PERTURBATIONS of specific findings' embeddings, run
// the sweep, and assert it picks the finding we know is nearest.
//
// The load-bearing case is `it("ranks by max-similarity to ANY finding, never to a centroid")`.
// Everything else could pass with a centroid ranking; that one cannot. It is the whole
// design decision, executable.
//
// Runs on the in-memory libSQL database built from the generated migrations, so the vector
// SQL under test (`vector32`, `vector_distance_cos`, `row_number() over (partition by …)`)
// is executed by a real engine against the real DDL — not a mock.

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

/** The write the agent-tier `update_track` path performs: the validated JSON → ranked F32_BLOB. */
async function embed(trackId: string, vector: number[]): Promise<void> {
  await db.execute({
    args: [JSON.stringify(vector), trackId],
    sql: `update tracks set embedding_blob = vector32(?) where track_id = ?`,
  });
}

type SeedOptions = {
  artists?: string[];
  isrc?: string;
  key?: string;
  label?: string;
  releaseDate?: string;
  title?: string;
  vector?: number[];
};

/** A certified finding, optionally embedded / labelled / ISRC-stamped. */
async function seedFinding(trackId: string, options: SeedOptions = {}): Promise<void> {
  await seedTrack(db, {
    artists: options.artists ?? ["Finding Artist"],
    logId: `00${trackId.slice(-1)}.1.1A`,
    title: options.title ?? `Finding ${trackId}`,
    trackId,
  });

  await applySeedOptions(trackId, options);
}

/** A catalogue track: a `tracks` row with NO `findings` row. Optionally embedded / stamped. */
async function seedCatalogue(trackId: string, options: SeedOptions = {}): Promise<void> {
  await seedCatalogueTrack(db, {
    artists: options.artists ?? ["Catalogue Artist"],
    title: options.title ?? `Catalogue ${trackId}`,
    trackId,
  });

  await applySeedOptions(trackId, options);
}

async function applySeedOptions(trackId: string, options: SeedOptions): Promise<void> {
  if (options.label) {
    await db.execute({ args: [options.label, trackId], sql: labelSql });
  }

  if (options.isrc) {
    await db.execute({ args: [options.isrc, trackId], sql: isrcSql });
  }

  if (options.releaseDate) {
    await db.execute({
      args: [options.releaseDate, trackId],
      sql: "update tracks set release_date = ? where track_id = ?",
    });
  }

  if (options.key) {
    await db.execute({
      args: [options.key, trackId],
      sql: 'update tracks set "key" = ? where track_id = ?',
    });
  }

  if (options.vector) {
    await embed(trackId, options.vector);
  }
}

const labelSql = `update tracks set label = ? where track_id = ?`;
const isrcSql = `update tracks set isrc = ? where track_id = ?`;

// ── The artist graph + label rulings, for AUTHORIZATION (RFC artist-primary-capture, slice 1) ──
// Capture authorization is artist-driven: a track may be bought iff a credited artist is QUALIFIED
// (an identity edge in `track_artists`, either to an artist with a certified finding or one with a
// weighted release count ≥ 3 on enabled labels) OR its label is `enabled`. These helpers seed that
// graph so the sweep's real SQL — not a mock — decides.

/** Insert an `artists` row (the qualification set is keyed on `artists.id`). */
async function seedArtistRow(id: string, name: string, slug: string): Promise<void> {
  await db.execute({
    args: [id, name, slug],
    sql: `insert into artists (id, name, slug, created_at, updated_at)
          values (?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

/** Insert a `track_artists` edge — the identity link authorization reads. */
async function edge(
  trackId: string,
  artistId: string,
  position = 0,
  role: null | "remixer" = null,
): Promise<void> {
  await db.execute({
    args: [trackId, artistId, position, role],
    sql: `insert into track_artists (track_id, artist_id, position, role) values (?, ?, ?, ?)`,
  });
}

/** Point a track at a label entity (`tracks.label_id`) — the weighted-count join reads it. */
async function linkLabel(trackId: string, labelId: string): Promise<void> {
  await db.execute({
    args: [labelId, trackId],
    sql: `update tracks set label_id = ? where track_id = ?`,
  });
}

/** Insert a `labels` row with a `seed_state` ruling (enabled seeds discovery AND authorizes). */
async function ruleLabel(
  id: string,
  name: string,
  slug: string,
  seedState: "disabled" | "enabled" | "undecided",
): Promise<void> {
  await db.execute({
    args: [id, name, slug, seedState],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  });
}

/** Read a catalogue row's stored ranking columns straight from the table. */
async function rankingOf(trackId: string): Promise<{
  capture_priority: number | null;
  catalogue_rank_corpus: string | null;
  catalogue_ranked_at: string | null;
  duplicate_of_track_id: string | null;
  nearest_finding_score: number | null;
  nearest_finding_track_id: string | null;
}> {
  const result = await db.execute({
    args: [trackId],
    sql: `select nearest_finding_track_id, nearest_finding_score, capture_priority,
                 catalogue_rank_corpus, catalogue_ranked_at, duplicate_of_track_id
          from tracks where track_id = ?`,
  });
  const row = result.rows[0];

  return row as unknown as Awaited<ReturnType<typeof rankingOf>>;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("the ranking — the sweep picks the finding we know is nearest", () => {
  it("matches each catalogue track to the finding its vector was perturbed from", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // Three findings, mutually orthogonal — three "regions" of the operator's taste.
    await seedFinding("finding-liquid", { title: "Liquid Finding", vector: axis(0) });
    await seedFinding("finding-neuro", { title: "Neuro Finding", vector: axis(1) });
    await seedFinding("finding-jungle", { title: "Jungle Finding", vector: axis(2) });

    // Three catalogue tracks, each pulled 15% of the way from one finding toward another.
    // Every one is unambiguously nearest the finding it started at.
    await seedCatalogue("cat-liquid", { vector: blend(axis(0), axis(1), 0.15) });
    await seedCatalogue("cat-neuro", { vector: blend(axis(1), axis(2), 0.15) });
    await seedCatalogue("cat-jungle", { vector: blend(axis(2), axis(0), 0.15) });

    const summary = await rankCatalogue();

    expect(summary.scored).toBe(3);
    expect(summary.embeddedFindings).toBe(3);
    expect(summary.remaining).toBe(0);

    expect((await rankingOf("cat-liquid")).nearest_finding_track_id).toBe("finding-liquid");
    expect((await rankingOf("cat-neuro")).nearest_finding_track_id).toBe("finding-neuro");
    expect((await rankingOf("cat-jungle")).nearest_finding_track_id).toBe("finding-jungle");
  });

  it("stores a cosine SIMILARITY (higher is nearer), matching the vectors we chose", async () => {
    const { cosineSimilarity } = await import("./embedding");
    const { rankCatalogue } = await import("./catalogue");

    const near = blend(axis(0), axis(1), 0.05);
    const far = blend(axis(0), axis(1), 0.45);

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-near", { vector: near });
    await seedCatalogue("cat-far", { vector: far });

    await rankCatalogue();

    const nearScore = (await rankingOf("cat-near")).nearest_finding_score;
    const farScore = (await rankingOf("cat-far")).nearest_finding_score;

    // The SQL's `1 - vector_distance_cos` agrees with the pure cosine, to float32 precision
    // (the blob stores float32; the JS math is float64).
    expect(nearScore).toBeCloseTo(cosineSimilarity(near, axis(0)), 4);
    expect(farScore).toBeCloseTo(cosineSimilarity(far, axis(0)), 4);
    // And the nearer track scores HIGHER — the column sorts DESC, so this is the direction
    // the whole surface depends on.
    expect(nearScore ?? 0).toBeGreaterThan(farScore ?? 1);
  });

  it("ranks by max-similarity to ANY finding, never to a centroid", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // THE DESIGN DECISION, MADE EXECUTABLE. The operator's taste is multi-modal: here it is
    // eight findings crowded on one axis and ONE lonely finding on another. The mean of that
    // corpus sits almost exactly on the crowd — a place none of his taste actually lives.
    for (let index = 0; index < 8; index += 1) {
      await seedFinding(`finding-crowd-${index}`, {
        vector: blend(axis(0), axis(index + 10), 0.02),
      });
    }
    await seedFinding("finding-lonely", { vector: axis(5) });

    // A catalogue track that is a DEAD RINGER for the lonely finding (cos ≈ 0.995) — and
    // essentially orthogonal to the crowd, so its similarity to the CENTROID is ~0.1.
    await seedCatalogue("cat-near-lonely", { vector: blend(axis(5), axis(6), 0.07) });
    // A catalogue track that is a mediocre match for the crowd (cos ≈ 0.83) — but the crowd
    // IS the centroid, so a centroid ranking would put this one on top.
    await seedCatalogue("cat-mid-crowd", { vector: blend(axis(0), axis(7), 0.4) });

    await rankCatalogue();

    const lonely = await rankingOf("cat-near-lonely");
    const crowd = await rankingOf("cat-mid-crowd");

    // Max-similarity: the dead ringer matched the LONELY finding, and beats the mediocre
    // crowd-match. Under a centroid ranking this assertion inverts — which is the point.
    expect(lonely.nearest_finding_track_id).toBe("finding-lonely");
    expect(lonely.nearest_finding_score ?? 0).toBeGreaterThan(0.99);
    expect(crowd.nearest_finding_score ?? 0).toBeLessThan(0.9);
    expect(lonely.nearest_finding_score ?? 0).toBeGreaterThan(crowd.nearest_finding_score ?? 1);
  });

  it("never ranks a finding — the sweep's columns stay null on the certification half", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedFinding("finding-b", { vector: axis(1) });
    await seedCatalogue("cat-a", { vector: blend(axis(0), axis(1), 0.1) });

    const summary = await rankCatalogue();

    // Only the ONE catalogue row was a candidate; the two findings were anti-joined out.
    expect(summary.scored).toBe(1);

    for (const findingId of ["finding-a", "finding-b"]) {
      const ranking = await rankingOf(findingId);

      expect(ranking.nearest_finding_score).toBeNull();
      expect(ranking.nearest_finding_track_id).toBeNull();
      expect(ranking.capture_priority).toBeNull();
      expect(ranking.catalogue_rank_corpus).toBeNull();
    }
  });
});

describe("the sweep — batching, staleness, and self-healing", () => {
  it("is a no-op on an unchanged archive, and re-ranks after a finding lands", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-a", { vector: blend(axis(0), axis(1), 0.3) });

    const first = await rankCatalogue();
    expect(first.scored).toBe(1);
    expect(first.corpus).toBe("v4:1:1:0:0:0");
    expect((await rankingOf("cat-a")).nearest_finding_track_id).toBe("finding-a");

    // Nothing changed: the fingerprint matches, so there is no candidate at all.
    const second = await rankCatalogue();
    expect(second.scored).toBe(0);
    expect(second.prioritized).toBe(0);
    expect(second.remaining).toBe(0);

    // A new finding lands, and it is a BETTER match for the catalogue track (closer than
    // finding-a, but not a near-1.0 same-master — that would be wrong-audio territory). The
    // fingerprint moves, the row goes stale on its own, and the next tick re-points it — no
    // invalidation call from the publish path, which is the whole point of the fingerprint.
    await seedFinding("finding-b", { vector: blend(axis(0), axis(1), 0.4) });

    const third = await rankCatalogue();
    expect(third.corpus).toBe("v4:2:2:0:0:0");
    expect(third.scored).toBe(1);
    expect(third.quarantined).toBe(0);
    expect((await rankingOf("cat-a")).nearest_finding_track_id).toBe("finding-b");
    // Closer than finding-a's ~0.92, but comfortably below the wrong-audio line.
    expect((await rankingOf("cat-a")).nearest_finding_score ?? 0).toBeGreaterThan(0.95);
  });

  it("drains a backlog in batches, reporting what is left", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    for (let index = 0; index < 5; index += 1) {
      await seedCatalogue(`cat-${index}`, { vector: blend(axis(0), axis(index + 1), 0.2) });
    }

    const first = await rankCatalogue(2);
    expect(first.scored).toBe(2);
    expect(first.remaining).toBe(3);

    const second = await rankCatalogue(2);
    expect(second.scored).toBe(2);
    expect(second.remaining).toBe(1);

    const third = await rankCatalogue(2);
    expect(third.scored).toBe(1);
    expect(third.remaining).toBe(0);
  });

  it("COUNTS what is left rather than assuming zero — a limit of 0 must not report 'drained'", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-a", { vector: blend(axis(0), axis(1), 0.2) });

    // An empty BATCH is not an empty BACKLOG. A cron that trusted an assumed `remaining: 0`
    // here would stop calling while the row was still stale.
    const summary = await rankCatalogue(0);

    expect(summary.scored).toBe(0);
    expect(summary.remaining).toBe(1);
  });

  it("re-scores a row whose OWN vector arrived after it was ranked (capture → embed)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // The real lifecycle, in order: the crawler mints a vectorless row, the ranking sweep
    // gives it a pre-audio capture tier, THEN the capture+embed pipeline gives it a vector.
    // Neither corpus number moved, so the fingerprint alone would leave it on the ladder
    // forever — the bug the 58 first-ever catalogue embeds hit. The scoring path always
    // nulls `capture_priority`, so tier-still-set + vector-present is the stale signal.
    await seedArtistRow("art-fa", "Finding Artist", "finding-artist");
    await seedFinding("finding-a", { artists: ["Finding Artist"], vector: axis(0) });
    await edge("finding-a", "art-fa"); // certifies the artist qualified
    await seedCatalogue("cat-a", { artists: ["Finding Artist"] });
    await edge("cat-a", "art-fa"); // the row credits the qualified artist by identity

    const first = await rankCatalogue();
    expect(first.prioritized).toBe(1);
    expect((await rankingOf("cat-a")).capture_priority).toBe(3);

    // The capture+embed side-channel lands the vector; the corpus is untouched.
    await embed("cat-a", blend(axis(0), axis(1), 0.2));

    const second = await rankCatalogue();
    expect(second.corpus).toBe(first.corpus);
    expect(second.scored).toBe(1);
    expect(second.remaining).toBe(0);

    const ranking = await rankingOf("cat-a");
    expect(ranking.nearest_finding_track_id).toBe("finding-a");
    expect(ranking.nearest_finding_score ?? 0).toBeGreaterThan(0.9);
    // The tier is cleared by the scoring write, so the row has LEFT the stale set — a third
    // tick must be a clean no-op (no re-pick loop).
    expect(ranking.capture_priority).toBeNull();
    const third = await rankCatalogue();
    expect(third.scored).toBe(0);
    expect(third.remaining).toBe(0);
  });

  it("stamps a row it cannot score, so a hopeless row is never re-picked forever", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // No finding is embedded, so nothing can be a nearest neighbour.
    await seedFinding("finding-a");
    await seedCatalogue("cat-a", { vector: axis(0) });

    const summary = await rankCatalogue();

    expect(summary.embeddedFindings).toBe(0);
    expect(summary.scored).toBe(1);
    // Stamped, with an honest null score — not left stale to be re-picked every tick.
    const ranking = await rankingOf("cat-a");
    expect(ranking.nearest_finding_score).toBeNull();
    expect(ranking.catalogue_rank_corpus).toBe("v4:1:0:0:0:0");
    expect(summary.remaining).toBe(0);
  });
});

describe("the capture queue — authorization, then the priority ladder", () => {
  beforeEach(async () => {
    // A QUALIFIED artist (Krakota): an artists row + a certified finding crediting it by identity.
    await seedArtistRow("art-krakota", "Krakota", "krakota");
    await seedFinding("finding-a", {
      artists: ["Krakota"],
      label: "Hospital Records",
      vector: axis(0),
    });
    await edge("finding-a", "art-krakota");
    // Hospital Records: ENABLED (authorizes) AND carries a finding (the tier-2 hint).
    await ruleLabel("lbl-hospital", "Hospital Records", "hospital-records", "enabled");
    // Critical Music: ENABLED, nothing certified on it yet (the tier-1 rung).
    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    // The veto's real shape: a label the operator ruled OUT that nonetheless CARRIES a finding —
    // a crossover remix. All 8 disabled labels in the live archive look like this.
    await seedFinding("finding-crossover", { artists: ["Above & Beyond"], label: "Anjunabeats" });
    await ruleLabel("lbl-out", "Anjunabeats", "anjunabeats", "disabled");
    // Atlantic UK: NOT enabled, but CARRIES a finding — the label-mate counter-example.
    await seedFinding("finding-atlantic", { artists: ["A Crossover"], label: "Atlantic UK" });
  });

  it("tiers AUTHORIZED tracks by the priority ladder, and SINKS the unauthorized", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // No vectors on any of these — they have never been captured, which is exactly why the
    // Ear cannot rank them and this ladder has to.
    // A qualified artist (by identity edge) on an UNDECIDED label — authorized, tier 3.
    await seedCatalogue("cat-artist", { artists: ["Krakota"], label: "Some Other Label" });
    await edge("cat-artist", "art-krakota");
    // Authorized via its ENABLED label, which also carries a finding — the tier-2 hint (via fold).
    await seedCatalogue("cat-label", { artists: ["Nobody"], label: "hospital records." });
    // Authorized via its enabled label, nothing certified yet — tier 1.
    await seedCatalogue("cat-seed", { artists: ["Nobody"], label: "Critical Music" });
    // No qualified artist, label not enabled — UNAUTHORIZED (the new negative tier).
    await seedCatalogue("cat-unauth", { artists: ["Nobody"], label: "Nobody's Imprint" });
    // The veto, on real archive shape: Anjunabeats CARRIES a finding and is RULED OUT. Checked
    // before authorization — a qualified artist (edge) still sinks to −1.
    await seedCatalogue("cat-vetoed", { artists: ["Krakota"], label: "Anjunabeats" });
    await edge("cat-vetoed", "art-krakota");

    const summary = await rankCatalogue();

    expect(summary.prioritized).toBe(5);
    expect(summary.scored).toBe(0);

    // 3 — a credited artist is qualified (identity). Capture follows the artist, even onto an
    // undecided label the operator has not ruled on.
    expect((await rankingOf("cat-artist")).capture_priority).toBe(3);
    // 2 — authorized via its enabled label, which also carries a finding. Note the fold:
    // `hospital records.` and `Hospital Records` are one label everywhere else in the archive.
    expect((await rankingOf("cat-label")).capture_priority).toBe(2);
    // 1 — in-lane but unproven: an enabled label, nothing certified on it yet.
    expect((await rankingOf("cat-seed")).capture_priority).toBe(1);
    // −3 — UNAUTHORIZED. No qualified artist, and its label is not enabled. Metadata welcome,
    // money withheld — excluded from the capture queue by the existing `capture_priority >= 0`.
    expect((await rankingOf("cat-unauth")).capture_priority).toBe(-3);
    // −1 — VETOED, checked FIRST. A qualified artist on a ruled-out label still sinks; his ruling
    // beats the strongest signal. The veto has its own tier, distinct from `unauthorized` (−3).
    expect((await rankingOf("cat-vetoed")).capture_priority).toBe(-1);
  });

  it("authorizes an EDGE-LESS track via its enabled label (the pre-backfill common case)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // ~2/3 of catalogue rows carry no graph edges until slice 0 drains. This one has none, and an
    // unknown artist name — but its label is enabled, so it is authorized and captureable.
    await seedCatalogue("cat-edgeless", { artists: ["Unknown Name"], label: "Critical Music" });

    await rankCatalogue();

    expect((await rankingOf("cat-edgeless")).capture_priority).toBe(1);
  });

  it("does NOT authorize a label-mate off a finding on a NON-enabled label (Atlantic-UK pin)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // Atlantic UK carries a finding but is not enabled. A crawled label-mate with no qualified
    // artist must NOT ride that lone finding into the budget — the exact overshoot this rule ends.
    await seedCatalogue("cat-atlantic", { artists: ["Nobody"], label: "Atlantic UK" });

    await rankCatalogue();

    expect((await rankingOf("cat-atlantic")).capture_priority).toBe(-3);
  });

  it("qualifies an artist by WEIGHTED release count ≥ 3 on enabled labels (no finding needed)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // An artist with no certified finding, but three primary credits on enabled labels — weighted
    // 3.0, exactly the threshold. He qualifies, so a catalogue row crediting him is authorized.
    await seedArtistRow("art-worker", "Session Worker", "session-worker");

    for (const index of [0, 1, 2]) {
      await seedCatalogue(`rel-${index}`, { artists: ["Session Worker"], label: "Critical Music" });
      await linkLabel(`rel-${index}`, "lbl-seed");
      await edge(`rel-${index}`, "art-worker");
    }

    await seedCatalogue("cat-worker", { artists: ["Session Worker"], label: "Undecided Imprint" });
    await edge("cat-worker", "art-worker");

    await rankCatalogue();

    expect((await rankingOf("cat-worker")).capture_priority).toBe(3);
  });

  it("holds the WEIGHTED arity guard — 2 primary + 1 remixer is 2.5, below the threshold", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // The weighting is load-bearing: primary credit 1.0, remixer 0.5. Two primaries and one remix
    // sum to 2.5 — NOT qualified — so a row crediting this artist on an undecided label sinks.
    await seedArtistRow("art-light", "Light Credit", "light-credit");
    await seedCatalogue("rel-p0", { artists: ["Light Credit"], label: "Critical Music" });
    await linkLabel("rel-p0", "lbl-seed");
    await edge("rel-p0", "art-light");
    await seedCatalogue("rel-p1", { artists: ["Light Credit"], label: "Critical Music" });
    await linkLabel("rel-p1", "lbl-seed");
    await edge("rel-p1", "art-light");
    await seedCatalogue("rel-r0", { artists: ["Light Credit"], label: "Critical Music" });
    await linkLabel("rel-r0", "lbl-seed");
    await edge("rel-r0", "art-light", 0, "remixer");

    await seedCatalogue("cat-light", { artists: ["Light Credit"], label: "Undecided Imprint" });
    await edge("cat-light", "art-light");

    await rankCatalogue();

    // 2.5 < 3 → not qualified, and the undecided label does not authorize → unauthorized.
    expect((await rankingOf("cat-light")).capture_priority).toBe(-3);
  });

  it("re-ranks an old row when the ARTIST GRAPH grows — the gate reaches rows ranked before it", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // The load-bearing self-healing property (RFC slice 1): slice 0's backfill adds edges, and the
    // corpus fingerprint must MOVE so a row ranked before its edge existed re-derives its tier.
    await seedArtistRow("art-late", "Late Edge", "late-edge");
    await seedFinding("finding-late", { artists: ["Late Edge"], label: "Some Label" });
    await edge("finding-late", "art-late"); // Late Edge is qualified
    // A catalogue row that credits Late Edge but has NO edge yet (pre-backfill) on an undecided label.
    await seedCatalogue("cat-late", { artists: ["Late Edge"], label: "Undecided Imprint" });

    await rankCatalogue();
    // Edge-less + undecided label → unauthorized, exactly as the strict identity rule requires.
    expect((await rankingOf("cat-late")).capture_priority).toBe(-3);

    // Slice 0 folds the name onto the real artist row: the edge lands.
    await edge("cat-late", "art-late");

    // The fingerprint moved (the track_artists count grew), so the row re-ranks and authorizes.
    await rankCatalogue();
    expect((await rankingOf("cat-late")).capture_priority).toBe(3);
  });

  it("keeps the two lenses disjoint — a track with audio leaves the capture queue", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedCatalogue("cat-hungry", { artists: ["Krakota"] });
    await edge("cat-hungry", "art-krakota");
    await seedCatalogue("cat-fed", { artists: ["Krakota"], vector: blend(axis(0), axis(1), 0.2) });
    await edge("cat-fed", "art-krakota");

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    const capture = await listCatalogueTracks("capture");

    // The embedded one is in The Ear and NOT in the capture queue (it has already been
    // captured — capturing it again is the one thing the queue must never ask for).
    expect(ear.map((track) => track.trackId)).toEqual(["cat-fed"]);
    expect(capture.map((track) => track.trackId)).toEqual(["cat-hungry"]);
    expect((await rankingOf("cat-fed")).capture_priority).toBeNull();
  });
});

describe("the read — the ranked page, and the WHY on every row", () => {
  it("orders The Ear by score, DESC, and carries the finding each row matched", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-krakota", {
      artists: ["Krakota"],
      title: "See For Miles",
      vector: axis(0),
    });
    await seedFinding("finding-nutone", {
      artists: ["Nu:Tone"],
      title: "Heaven's Gate",
      vector: axis(1),
    });

    // cat-best stays BELOW the duplicate display band (≥ 0.995 never ranks — the
    // operator's 2026-07-15 ruling): a strong find, not a copy.
    await seedCatalogue("cat-best", { vector: blend(axis(1), axis(2), 0.15) });
    await seedCatalogue("cat-mid", { vector: blend(axis(0), axis(2), 0.25) });
    await seedCatalogue("cat-worst", { vector: blend(axis(0), axis(2), 0.5) });

    await rankCatalogue();

    const page = await listCatalogueTracks("ear");

    expect(page.map((track) => track.trackId)).toEqual(["cat-best", "cat-mid", "cat-worst"]);

    // THE WHY. Not a bare score: the row names the finding it matched, hydrated with the
    // title, the artists, and the coordinate — the sentence the operator actually reads.
    const best = page[0];
    expect(best?.nearestFinding?.trackId).toBe("finding-nutone");
    expect(best?.nearestFinding?.title).toBe("Heaven's Gate");
    expect(best?.nearestFinding?.artists).toEqual(["Nu:Tone"]);
    expect(best?.nearestFinding?.logId).toBeTruthy();
    expect(best?.nearestFindingScore ?? 0).toBeGreaterThan(0.98);

    expect(page[1]?.nearestFinding?.trackId).toBe("finding-krakota");
  });

  it("orders the capture queue by priority, DESC, and carries the reason for each rung", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-krakota", "Krakota", "krakota");
    await seedFinding("finding-a", { artists: ["Krakota"], label: "Hospital Records" });
    await edge("finding-a", "art-krakota");
    await ruleLabel("lbl-hospital", "Hospital Records", "hospital-records", "enabled");
    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    // A qualified artist (edge) — tier 3. Authorized via its enabled label + a finding — tier 2.
    // Authorized via its enabled label alone — tier 1.
    await seedCatalogue("cat-seed", { artists: ["Nobody"], label: "Critical Music" });
    await seedCatalogue("cat-artist", { artists: ["Krakota"] });
    await edge("cat-artist", "art-krakota");
    await seedCatalogue("cat-label", { artists: ["Nobody"], label: "Hospital Records" });

    await rankCatalogue();

    const page = await listCatalogueTracks("capture");

    expect(page.map((track) => track.trackId)).toEqual(["cat-artist", "cat-label", "cat-seed"]);
    // The ladder rung is re-derived through the SAME pure function the sweep used to WRITE
    // the tier, so the sort key and the explanation cannot drift apart.
    expect(page[0]?.captureReason).toEqual({ kind: "artist", name: "Krakota" });
    expect(page[1]?.captureReason).toEqual({ kind: "label", name: "Hospital Records" });
    expect(page[2]?.captureReason).toEqual({ kind: "seed-label", name: "Critical Music" });
  });

  it("shows nothing at all when the catalogue is empty — the honest state today", async () => {
    const { getCatalogueSummary, listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    const summary = await rankCatalogue();
    expect(summary.scored).toBe(0);
    expect(summary.prioritized).toBe(0);

    expect(await listCatalogueTracks("ear")).toEqual([]);
    expect(await listCatalogueTracks("capture")).toEqual([]);
    expect(await listCatalogueTracks("quarantine")).toEqual([]);
    expect(await getCatalogueSummary()).toEqual({
      awaitingCapture: 0,
      awaitingRank: 0,
      // The counts are now cached with a freshness stamp (the rank sweep wrote them); the six
      // numbers are still exact, and `computedAt` is the ISO stamp of when the sweep computed them.
      computedAt: expect.any(String),
      dismissed: 0,
      quarantined: 0,
      ranked: 0,
      total: 0,
    });
  });

  it("counts the catalogue's shape without scanning it", async () => {
    const { getCatalogueSummary, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-scored", { vector: blend(axis(0), axis(1), 0.2) });
    await seedCatalogue("cat-hungry");
    await seedCatalogue("cat-unranked");

    await rankCatalogue(2);

    const summary = await getCatalogueSummary();

    expect(summary.total).toBe(3);
    expect(summary.ranked).toBe(1);
    expect(summary.awaitingCapture).toBe(1);
    // The third row never made it into the batch of 2 — it has no fingerprint at all.
    expect(summary.awaitingRank).toBe(1);
  });

  it("the pure bucket classifier agrees with the SQL aggregate, bucket-for-bucket (the delta drift guard)", async () => {
    // THE DRIFT GUARD. The operator mutations keep the cached summary honest with a single-row ±1
    // DELTA, driven by the pure `bucketsForRow` classifier — never the full recompute. That is only
    // safe if the classifier agrees, arm for arm, with `computeCatalogueCounts`'s SQL CASE arms. So
    // seed rows in every bucket (and every NULL edge case), then assert a TALLY of the classifier
    // over those rows equals the SQL aggregate exactly. If either side drifts, this trips.
    const { WRONG_AUDIO_STATUS, bucketsForRow, computeCatalogueCounts, readRowBuckets } =
      await import("./catalogue");

    // Set a catalogue row's summary-relevant columns directly, so each fixture lands in a KNOWN set
    // of buckets. `undefined` leaves the seeded default (duration 270_000, everything else null).
    const setCols = async (
      trackId: string,
      cols: {
        capturePriority?: null | number;
        captureStatus?: null | string;
        corpus?: null | string;
        dismissedAt?: null | string;
        duplicateOf?: null | string;
        durationMs?: null | number;
        score?: null | number;
      },
    ): Promise<void> => {
      await db.execute({
        args: [
          cols.capturePriority ?? null,
          cols.captureStatus ?? null,
          cols.corpus ?? null,
          cols.dismissedAt ?? null,
          cols.duplicateOf ?? null,
          cols.durationMs === undefined ? 270_000 : cols.durationMs,
          cols.score ?? null,
          trackId,
        ],
        sql: `update tracks
              set capture_priority = ?, capture_status = ?, catalogue_rank_corpus = ?,
                  dismissed_at = ?, duplicate_of_track_id = ?, duration_ms = ?,
                  nearest_finding_score = ?
              where track_id = ?`,
      });
    };

    const corpus = "v4:1:1:0:0:0";
    const ids = [
      "b-awaiting-rank",
      "b-ranked",
      "b-awaiting-capture",
      "b-quarantined",
      "b-dismissed",
      "b-duplicate",
      "b-long-form",
      "b-null-duration",
      "b-null-status",
      "b-multi",
    ];

    for (const id of ids) {
      await seedCatalogue(id);
    }

    await setCols("b-awaiting-rank", { corpus: null }); // {total, awaitingRank}
    await setCols("b-ranked", { corpus, score: 0.9 }); // {total, ranked}
    await setCols("b-awaiting-capture", { capturePriority: 3, captureStatus: "pending", corpus }); // {total, awaitingCapture}
    await setCols("b-quarantined", { captureStatus: WRONG_AUDIO_STATUS, corpus }); // {total, quarantined}
    await setCols("b-dismissed", { dismissedAt: "2026-07-22T00:00:00.000Z" }); // {dismissed}
    await setCols("b-duplicate", { corpus, duplicateOf: "finding-x", score: 0.99 }); // {total} — scored but a stored duplicate
    await setCols("b-long-form", { corpus, durationMs: 20 * 60_000, score: 0.9 }); // {total} — scored but over the long-form line
    await setCols("b-null-duration", {
      capturePriority: 3,
      captureStatus: "pending",
      corpus,
      durationMs: null,
    }); // {total} — a NULL duration fails the awaiting-capture window
    await setCols("b-null-status", { capturePriority: 3, captureStatus: null, corpus }); // {total} — a NULL status fails `<> wrong-audio`
    await setCols("b-multi", { capturePriority: 3, captureStatus: "pending", corpus: null }); // {total, awaitingCapture, awaitingRank}

    // The SQL aggregate (the authority) vs a tally of the pure classifier over the SAME rows.
    const sql = await computeCatalogueCounts();
    const tally = {
      awaitingCapture: 0,
      awaitingRank: 0,
      dismissed: 0,
      quarantined: 0,
      ranked: 0,
      total: 0,
    };

    for (const id of ids) {
      for (const bucket of await readRowBuckets(id)) {
        tally[bucket] += 1;
      }
    }

    expect(tally).toEqual(sql);
    // Pin the expected shape too, so a change that drifts BOTH sides in lockstep still trips.
    expect(sql).toEqual({
      awaitingCapture: 2,
      awaitingRank: 2,
      dismissed: 1,
      quarantined: 1,
      ranked: 1,
      total: 9,
    });

    // And the pure classifier directly, on constructed rows — the two NULL edge cases explicitly.
    const base = {
      capturePriority: 3,
      catalogueRankCorpus: corpus,
      dismissedAt: null,
      duplicateOfTrackId: null,
      durationMs: 270_000,
      nearestFindingScore: null,
    } as const;
    expect([...bucketsForRow({ ...base, captureStatus: null })]).toEqual(["total"]); // NULL status ⇒ not awaiting-capture
    expect([...bucketsForRow({ ...base, captureStatus: "pending", durationMs: null })]).toEqual([
      "total",
    ]); // NULL duration ⇒ not awaiting-capture
    expect([...(await readRowBuckets("b-multi"))].sort()).toEqual([
      "awaitingCapture",
      "awaitingRank",
      "total",
    ]);
  });
});

describe("duplicates — a crawled copy of a finding is flagged, never bought", () => {
  it("flags a pre-audio ISRC duplicate: tier −2, the finding STORED, still on the board with its WHY", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    // THE REAL EVENT, in fixtures. The crawler pulled in a copy of a track already logged — same
    // ISRC, cosmetically different formatting (hyphens/case), the shape a raw equality would miss.
    await seedFinding("finding-owned", { isrc: "GBAYE1234567", title: "Infinity" });
    await seedCatalogue("cat-dupe", { isrc: "gb-aye-12-34567", title: "Infinity (copy)" });
    // A genuine candidate with no clash, on an ENABLED label so it is authorized — the queue must
    // still hand THIS one out.
    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    await seedCatalogue("cat-real", {
      artists: ["Nobody"],
      label: "Critical Music",
      title: "A Real Candidate",
    });

    const summary = await rankCatalogue();
    expect(summary.prioritized).toBe(2);

    // −2, strictly below the label veto's −1, and the finding it duplicates is stored so the
    // board can NAME it (never a silent disappearance).
    const dupe = await rankingOf("cat-dupe");
    expect(dupe.capture_priority).toBe(-2);
    expect(dupe.duplicate_of_track_id).toBe("finding-owned");
    expect(dupe.nearest_finding_score).toBeNull();

    // Still visible on the capture board, ordered LAST, carrying the finding as its WHY.
    const capture = await listCatalogueTracks("capture");
    expect(capture.map((track) => track.trackId)).toEqual(["cat-real", "cat-dupe"]);
    const dupeItem = capture.find((track) => track.trackId === "cat-dupe");
    expect(dupeItem?.duplicateOf?.trackId).toBe("finding-owned");
    expect(dupeItem?.duplicateOf?.title).toBe("Infinity");
    expect(capture.find((track) => track.trackId === "cat-real")?.duplicateOf).toBeNull();
  });

  it("a display-band [0.995, 0.9995) duplicate never occupies a ranked ear slot — and nothing is stored", async () => {
    const { DUPLICATE_SIMILARITY, listCatalogueTracks, rankCatalogue, WRONG_AUDIO_QUARANTINE } =
      await import("./catalogue");

    await seedFinding("finding-owned", { title: "Infinity", vector: axis(0) });
    // An ALTERNATE master lands in the display band: above DUPLICATE_SIMILARITY (a near-dup), but
    // below WRONG_AUDIO_QUARANTINE — a genuinely different recording, so never vetoed. The
    // operator's ruling (2026-07-15, the Anwius "Trust" case): a known duplicate is not a
    // discovery, so the EAR ranking excludes it — its perfect score would sit above every
    // real find.
    await seedCatalogue("cat-identical", {
      title: "Infinity (copy)",
      vector: blend(axis(0), axis(1), 0.06),
    });
    // A genuine near-neighbour — close, but a different recording, and clearly below threshold.
    await seedCatalogue("cat-near", { vector: blend(axis(0), axis(1), 0.2) });

    await rankCatalogue();

    // The ear page carries ONLY the real discovery; the display-band duplicate is filtered out.
    const ear = await listCatalogueTracks("ear");
    expect(ear.map((track) => track.trackId)).toEqual(["cat-near"]);
    expect(ear[0]?.duplicateOf).toBeNull();

    // The exclusion fired on the display band, not arbitrarily: the raw ranking proves the
    // row scored into [DUPLICATE_SIMILARITY, WRONG_AUDIO_QUARANTINE).
    const stored = await rankingOf("cat-identical");
    expect(stored.nearest_finding_score ?? 0).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY);
    expect(stored.nearest_finding_score ?? 1).toBeLessThan(WRONG_AUDIO_QUARANTINE);

    // And the similarity half stays DISPLAY-ONLY: nothing written to `duplicate_of_track_id`,
    // no capture-ladder involvement — the row simply does not rank.
    expect(stored.duplicate_of_track_id).toBeNull();
    expect(stored.capture_priority).toBeNull();
  });

  it("converges: a pre-audio duplicate is stamped and not re-picked, and CLEARS if its finding goes", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-owned", { isrc: "GBAYE1234567" });
    await seedCatalogue("cat-dupe", { isrc: "GBAYE1234567" });

    const first = await rankCatalogue();
    expect(first.prioritized).toBe(1);
    expect((await rankingOf("cat-dupe")).duplicate_of_track_id).toBe("finding-owned");

    // The row is stamped with the live fingerprint, so it is NOT stale — the next tick is a
    // no-op and it is never re-picked (no loop).
    const second = await rankCatalogue();
    expect(second.prioritized).toBe(0);
    expect(second.scored).toBe(0);
    expect(second.remaining).toBe(0);

    // Delete the finding it duplicated: the corpus fingerprint moves (findings count drops), so
    // the row goes stale on its own and re-ranks — and the stale marker clears, because there is
    // no longer anything it is a duplicate of. Self-healing, with no invalidation call.
    await db.execute({ args: ["finding-owned"], sql: `delete from findings where track_id = ?` });

    await rankCatalogue();
    const cleared = await rankingOf("cat-dupe");
    expect(cleared.duplicate_of_track_id).toBeNull();
    // It falls back to the ordinary ladder — no qualified artist and no enabled label in the (now
    // empty) archive, so it is UNAUTHORIZED: metadata welcome, money withheld.
    expect(cleared.capture_priority).toBe(-3);
  });
});

// ── The matchKey-vs-findings detector — a logged track's twin (the 2026-07-15 "Drifting Away" ruling)
// A crawled catalogue row whose folded title+artist `matchKey` equals a certified finding's is that
// same song — a DUPLICATE regardless of ISRC (a YouTube rip carries none) and regardless of embedding
// score (the rip scored a merely-0.94 twin of the finding it copies). The ISRC-only pre-audio detector
// and the ≥0.995 post-embed detector both missed it. This detector fires on BOTH sides of the audio
// boundary — the pre-audio ladder and the scored path — stamping the −2 duplicate tier + the finding.
describe("matchKey duplicate — a logged track's twin is flagged, ISRC-blind and score-blind", () => {
  /** Stamp a catalogue row with the operator's force-capture sentinel, the way `forceCapture` would. */
  async function markCleared(trackId: string): Promise<void> {
    await db.execute({
      args: [trackId],
      sql: `update tracks set capture_status = 'duplicate-cleared' where track_id = ?`,
    });
  }

  it("pre-audio: a no-ISRC row with the same folded title+artist as a finding is tier −2, finding stored, last on the board", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    // THE LIVE CASE. The crawler pulled a YouTube-rip copy of a logged track — NO ISRC — with a
    // cosmetically different formatting (reversed artist order, lowercase, a hyphen for the space).
    // The folded `matchKey` sees through all of it: same recording.
    await seedFinding("finding-drifting", {
      artists: ["BOP", "Unquote"],
      title: "Drifting Away",
    });
    await seedCatalogue("cat-twin", {
      artists: ["unquote", "bop"],
      title: "DRIFTING-AWAY",
    });
    // A genuine candidate with no clash, on an ENABLED label so it is authorized — the queue must
    // still hand THIS one out first.
    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    await seedCatalogue("cat-real", {
      artists: ["Nobody"],
      label: "Critical Music",
      title: "A Real Candidate",
    });

    const summary = await rankCatalogue();
    expect(summary.prioritized).toBe(2);

    // −2, strictly below the label veto's −1, the finding STORED so the board can name it — even
    // though there is no ISRC anywhere and no vector to score against.
    const twin = await rankingOf("cat-twin");
    expect(twin.capture_priority).toBe(-2);
    expect(twin.duplicate_of_track_id).toBe("finding-drifting");
    expect(twin.nearest_finding_score).toBeNull();

    // Still on the capture board, ordered LAST behind the real candidate, carrying its WHY.
    const capture = await listCatalogueTracks("capture");
    expect(capture.map((track) => track.trackId)).toEqual(["cat-real", "cat-twin"]);
    expect(capture.find((track) => track.trackId === "cat-twin")?.duplicateOf?.trackId).toBe(
      "finding-drifting",
    );
  });

  it("scored: a 0.94 twin (well below 0.995) is stamped −2, KEEPS its score, and never occupies an ear slot", async () => {
    const { DUPLICATE_SIMILARITY, listCatalogueTracks, rankCatalogue } =
      await import("./catalogue");

    // The exact defect: a rip of the logged "Drifting Away" embedded to a merely-0.94 twin of the
    // finding — far below the 0.995 post-embed band, so the old detectors sailed past it and it
    // ranked as a top discovery. The title+artist identity catches it regardless of the score.
    await seedFinding("finding-drifting", {
      artists: ["BOP", "Unquote"],
      title: "Drifting Away",
      vector: axis(0),
    });
    await seedCatalogue("cat-twin", {
      artists: ["BOP", "Unquote"],
      title: "Drifting Away (copy)",
      vector: blend(axis(0), axis(1), 0.25),
    });
    // A genuine discovery so the ear lens is not trivially empty.
    await seedCatalogue("cat-disco", { vector: blend(axis(0), axis(2), 0.3) });

    await rankCatalogue();

    const twin = await rankingOf("cat-twin");
    expect(twin.duplicate_of_track_id).toBe("finding-drifting");
    expect(twin.capture_priority).toBe(-2);
    // It KEEPS its score — the honest WHY of the number — and that score is genuinely below the
    // near-identical band, proving the detector is score-blind, not a re-labelled 0.995 marker.
    expect(twin.nearest_finding_score ?? 0).toBeGreaterThan(0.85);
    expect(twin.nearest_finding_score ?? 1).toBeLessThan(DUPLICATE_SIMILARITY);

    // And it never occupies a ranked ear slot — a known copy is not a discovery.
    const ear = await listCatalogueTracks("ear");
    const earIds = ear.map((track) => track.trackId);
    expect(earIds).toContain("cat-disco");
    expect(earIds).not.toContain("cat-twin");
  });

  it("a VIP or a different artist is a DIFFERENT identity — not a duplicate, still ranks", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // A VIP is a different recording — its descriptor is part of the identity, so an original of a
    // logged VIP (or a VIP of a logged original) is a real discovery, never a duplicate.
    await seedFinding("finding-dribble", {
      artists: ["Enei"],
      title: "Dribble",
      vector: axis(0),
    });
    await seedCatalogue("cat-vip", {
      artists: ["Enei"],
      title: "Dribble - VIP",
      vector: blend(axis(0), axis(1), 0.2),
    });
    // Same title, DIFFERENT artist — also a different identity, also a real discovery.
    await seedFinding("finding-shared", {
      artists: ["Artist A"],
      title: "Shared Title",
      vector: axis(3),
    });
    await seedCatalogue("cat-other-artist", {
      artists: ["Artist B"],
      title: "Shared Title",
      vector: blend(axis(3), axis(4), 0.2),
    });

    await rankCatalogue();

    // Neither is stamped a duplicate; both keep an ordinary scored ranking (tier cleared, score kept).
    for (const id of ["cat-vip", "cat-other-artist"]) {
      const row = await rankingOf(id);
      expect(row.duplicate_of_track_id).toBeNull();
      expect(row.capture_priority).toBeNull();
      expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.9);
    }
  });

  it("the force-capture sentinel is respected: a `duplicate-cleared` twin is NOT re-stamped, either side of the boundary", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-known", "Known", "known");
    await seedFinding("finding-twin", {
      artists: ["Known"],
      title: "The Same Song",
      vector: axis(0),
    });
    await edge("finding-twin", "art-known"); // Known is a qualified artist
    // Pre-audio (no vector): a matchKey twin the operator already forced past the veto.
    await seedCatalogue("cat-preaudio", { artists: ["Known"], title: "The Same Song" });
    await edge("cat-preaudio", "art-known");
    await markCleared("cat-preaudio");
    // Scored (a vector): same identity, also force-cleared.
    await seedCatalogue("cat-scored", {
      artists: ["Known"],
      title: "The Same Song",
      vector: blend(axis(0), axis(1), 0.25),
    });
    await markCleared("cat-scored");

    await rankCatalogue();

    // Pre-audio: NOT re-vetoed to −2 — it lands on its HONEST tier (artist "Known" is on the finding
    // → 3) and re-enters the capture queue.
    const preaudio = await rankingOf("cat-preaudio");
    expect(preaudio.duplicate_of_track_id).toBeNull();
    expect(preaudio.capture_priority).toBe(3);

    // Scored: NOT re-stamped either — it ranks on its own merits (tier cleared, score kept).
    const scored = await rankingOf("cat-scored");
    expect(scored.duplicate_of_track_id).toBeNull();
    expect(scored.capture_priority).toBeNull();
    expect(scored.nearest_finding_score ?? 0).toBeGreaterThan(0.85);
  });
});

describe("wrong audio — a cross-title near-1.0 capture is quarantined, never trusted (docs/the-ear.md § Wrong audio)", () => {
  /** Give a catalogue row a captured-audio key, the way a real capture would. */
  async function withSourceKey(trackId: string, key: string): Promise<void> {
    await db.execute({
      args: [key, trackId],
      sql: `update tracks set source_audio_key = ? where track_id = ?`,
    });
  }

  /** Read the capture side-channel columns the quarantine touches. */
  async function stateOf(trackId: string): Promise<{
    capture_status: null | string;
    embedding_blob: unknown;
    source_audio_key: null | string;
  }> {
    const result = await db.execute({
      args: [trackId],
      sql: `select capture_status, embedding_blob, source_audio_key from tracks where track_id = ?`,
    });

    return result.rows[0] as unknown as Awaited<ReturnType<typeof stateOf>>;
  }

  it("quarantines a CROSS-TITLE near-1.0 row: the vector is dropped, the bad key kept, the row re-queued", async () => {
    const { WRONG_AUDIO_STATUS, rankCatalogue } = await import("./catalogue");

    // The audit's real case: Flowidus "Find Your Love" captured the audio of the SAME artist's
    // already-logged "Shelter", so its vector is identical to Shelter's under a different title.
    await seedArtistRow("art-flowidus", "Flowidus", "flowidus");
    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await edge("finding-shelter", "art-flowidus"); // Flowidus is a qualified artist
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    await edge("cat-fyl", "art-flowidus");
    await withSourceKey("cat-fyl", "catalogue/cat-fyl/badbeef.webm");

    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(1);
    // A quarantined row is no longer a scored find — it never reaches the top of the ear lens.
    expect(summary.scored).toBe(0);

    const row = await rankingOf("cat-fyl");
    // Rewound to the pre-audio ladder: no score, the restored capture tier (artist Flowidus is on
    // a finding → 3), and the collided finding KEPT as the WHY.
    expect(row.nearest_finding_score).toBeNull();
    expect(row.nearest_finding_track_id).toBe("finding-shelter");
    expect(row.capture_priority).toBe(3);

    // The vector is nulled (it was a lie), the bad key is KEPT (the re-capture's bad-audio memory),
    // and the status marks it quarantined.
    const state = await stateOf("cat-fyl");
    expect(state.capture_status).toBe(WRONG_AUDIO_STATUS);
    expect(state.embedding_blob).toBeNull();
    expect(state.source_audio_key).toBe("catalogue/cat-fyl/badbeef.webm");
  });

  it("does NOT quarantine a SAME-TITLE near-1.0 row — it is a true duplicate (tier −2, finding stored, vector kept)", async () => {
    const { DUPLICATE_CAPTURE_TIER, rankCatalogue } = await import("./catalogue");

    // Same artist AND same title → the crawler re-found a logged track, with the RIGHT audio.
    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await seedCatalogue("cat-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });

    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(0);

    const row = await rankingOf("cat-shelter");
    // The #545 duplicate handling: named, tier −2, and it KEEPS its vector + score (not quarantined).
    expect(row.duplicate_of_track_id).toBe("finding-shelter");
    expect(row.capture_priority).toBe(DUPLICATE_CAPTURE_TIER);
    expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.99);

    const state = await stateOf("cat-shelter");
    expect(state.capture_status).not.toBe("wrong-audio");
    expect(state.embedding_blob).not.toBeNull();
  });

  it("converges: a quarantined row and a −2 true duplicate are both stable on the next tick — no re-pick loop", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    await seedCatalogue("cat-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });

    const first = await rankCatalogue();
    expect(first.quarantined).toBe(1);

    // The next tick is a NO-OP: the quarantined row (vector nulled, corpus stamped) and the −2 true
    // duplicate (a deliberate negative tier the staleness `>= 0` clause leaves stable) are neither
    // re-scored nor re-quarantined.
    const second = await rankCatalogue();
    expect(second.quarantined).toBe(0);
    expect(second.scored).toBe(0);
    expect(second.prioritized).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it("the operator force-clear is sticky: a cleared row re-ranks normally and is never re-quarantined", async () => {
    const { clearWrongAudio, QUARANTINE_CLEARED, rankCatalogue } = await import("./catalogue");

    await seedArtistRow("art-flowidus", "Flowidus", "flowidus");
    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await edge("finding-shelter", "art-flowidus"); // Flowidus is a qualified artist
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    await edge("cat-fyl", "art-flowidus");
    await withSourceKey("cat-fyl", "catalogue/cat-fyl/badbeef.webm");

    await rankCatalogue();
    expect((await stateOf("cat-fyl")).capture_status).toBe("wrong-audio");

    // The operator overrules the verdict — "this capture is fine".
    expect(await clearWrongAudio("cat-fyl")).toBe(true);
    expect((await stateOf("cat-fyl")).capture_status).toBe(QUARANTINE_CLEARED);

    // Its kept audio re-embeds (simulate the embed cron), then a re-rank scores it NORMALLY — the
    // near-1.0 does NOT re-quarantine, because the operator's override is sticky.
    await embed("cat-fyl", axis(0));
    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(0);

    const row = await rankingOf("cat-fyl");
    expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.99);
    expect((await stateOf("cat-fyl")).capture_status).toBe(QUARANTINE_CLEARED);

    // A second force-clear is a no-op — the row is not quarantined anymore.
    expect(await clearWrongAudio("cat-fyl")).toBe(false);
  });

  it("the operator flag rewinds a FINDING: vector out, provenance reset, bad key kept; findings-only", async () => {
    const { flagWrongAudio, WRONG_AUDIO_STATUS } = await import("./catalogue");

    // The audit's real case, other side: the FINDING "Down With Your Love" captured Infinity's
    // audio — the sweep can only accuse the catalogue side, so the operator flags the finding.
    await seedFinding("finding-dwyl", {
      artists: ["Freaks & Geeks"],
      title: "Down With Your Love",
      vector: axis(1),
    });
    await withSourceKey("finding-dwyl", "005.9.9L/badbeef.webm");
    await db.execute({
      args: ["finding-dwyl"],
      sql: `update tracks set analyzed_from = 'full', capture_status = 'done' where track_id = ?`,
    });

    expect(await flagWrongAudio("finding-dwyl")).toBe(true);

    const state = await stateOf("finding-dwyl");
    expect(state.capture_status).toBe(WRONG_AUDIO_STATUS);
    // The poisoned vector leaves the ranking corpus immediately…
    expect(state.embedding_blob).toBeNull();
    // …the bad bytes' key is KEPT (the sha memory the capture sweep hash-rejects)…
    expect(state.source_audio_key).toBe("005.9.9L/badbeef.webm");
    // …and the analysis provenance resets, so the post-re-capture sweep re-enriches
    // (shouldReenrichAfterCapture keys off exactly this).
    const provenance = await db.execute({
      args: ["finding-dwyl"],
      sql: `select analyzed_from from tracks where track_id = ?`,
    });
    expect(provenance.rows[0]?.analyzed_from ?? null).toBeNull();

    // Idempotent: a second flag reports honestly that nothing changed.
    expect(await flagWrongAudio("finding-dwyl")).toBe(false);

    // The guard mirror of clearWrongAudio's: a CATALOGUE row is never flaggable — that side of
    // the collision belongs to the sweep's own quarantine.
    await seedCatalogue("cat-inf", {
      artists: ["Freaks & Geeks"],
      title: "Infinity",
      vector: axis(1),
    });
    await withSourceKey("cat-inf", "catalogue/cat-inf/cafef00d.webm");
    expect(await flagWrongAudio("cat-inf")).toBe(false);
  });
});

describe("the operator's actions — dismiss/restore, and the deterministic-duplicate exclusion", () => {
  it("a dismissed row leaves the ear + capture lenses and the sweep; restore puts it back", async () => {
    const { listCatalogueTracks, rankCatalogue, setTrackDismissed } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    // One scored (ear-lens) row and one cold (capture-lens) row.
    await seedCatalogue("cat-scored", { vector: blend(axis(0), axis(1), 0.2) });
    await seedCatalogue("cat-cold");
    await rankCatalogue();

    // Both are present before dismissal.
    expect((await listCatalogueTracks("ear")).map((t) => t.trackId)).toContain("cat-scored");
    expect((await listCatalogueTracks("capture")).map((t) => t.trackId)).toContain("cat-cold");

    expect(await setTrackDismissed("cat-scored", true)).toBe(true);
    expect(await setTrackDismissed("cat-cold", true)).toBe(true);

    // Gone from the working lenses, present in the restore pile.
    expect((await listCatalogueTracks("ear")).map((t) => t.trackId)).not.toContain("cat-scored");
    expect((await listCatalogueTracks("capture")).map((t) => t.trackId)).not.toContain("cat-cold");
    expect((await listCatalogueTracks("dismissed")).map((t) => t.trackId).sort()).toEqual([
      "cat-cold",
      "cat-scored",
    ]);

    // The sweep does not spend on a dismissed row: with both out, a fresh corpus leaves them stale
    // to nobody — the candidate query excludes them, so the tick reports nothing prioritized/scored.
    await seedFinding("finding-b", { vector: axis(2) }); // moves the corpus fingerprint
    const tick = await rankCatalogue();
    expect(tick.scored).toBe(0);
    expect(tick.prioritized).toBe(0);

    // Restore re-includes: the row is a candidate again and re-ranks on the next tick.
    expect(await setTrackDismissed("cat-scored", false)).toBe(true);
    await rankCatalogue();
    expect((await listCatalogueTracks("ear")).map((t) => t.trackId)).toContain("cat-scored");
  });

  it("excludes a dismissed catalogue row from the capture WORK queue (the metered ladder)", async () => {
    const { rankCatalogue, setTrackDismissed } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    // The capture budget ships default-deny (paused), which narrows the queue to the findings.
    // Open it so the catalogue half is actually served — that is what makes the exclusion visible.
    await setCatalogueCapturePaused(false);

    await seedArtistRow("art-known", "Known", "known");
    await seedFinding("finding-a", { artists: ["Known"], vector: axis(0) });
    await edge("finding-a", "art-known"); // Known is a qualified artist
    // A cold catalogue row crediting the qualified artist → capture tier 3, so it WOULD be captured.
    await seedCatalogue("cat-hot", { artists: ["Known"] });
    await edge("cat-hot", "art-known");
    await rankCatalogue();

    const before = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(before.map((w) => w.trackId)).toContain("cat-hot");

    await setTrackDismissed("cat-hot", true);

    const after = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(after.map((w) => w.trackId)).not.toContain("cat-hot");
  });

  it("a deterministic duplicate (duplicate_of_track_id set) never occupies an ear-lens slot", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    // A same-title near-1.0 vectored row is a TRUE duplicate: the sweep stores duplicate_of_track_id
    // AND keeps its score. Maurice's ruling: an ISRC/identity match is nothing to validate, so it
    // must not sit in "Closest to a finding" — even though it carries a score.
    await seedFinding("finding-owned", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-dupe", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    // A genuine discovery in the same region, so the lens is not simply empty.
    await seedCatalogue("cat-real", { vector: blend(axis(0), axis(1), 0.2) });
    await rankCatalogue();

    // The duplicate IS scored and stored (it is not deleted) …
    const stored = await rankingOf("cat-dupe");
    expect(stored.duplicate_of_track_id).toBe("finding-owned");
    expect(stored.nearest_finding_score ?? 0).toBeGreaterThan(0.99);

    // … but it does NOT appear on the ear lens; the real discovery does.
    const ear = (await listCatalogueTracks("ear")).map((t) => t.trackId);
    expect(ear).not.toContain("cat-dupe");
    expect(ear).toContain("cat-real");
  });

  it("keeps the summary consistent with the lenses via the mutation DELTA (dismiss, then restore)", async () => {
    const { getCatalogueSummary, rankCatalogue, setTrackDismissed } = await import("./catalogue");

    await seedFinding("finding-owned", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-dupe", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-real", { vector: blend(axis(0), axis(1), 0.2) });
    await seedCatalogue("cat-dismissed", { vector: blend(axis(0), axis(1), 0.3) });
    await rankCatalogue();

    // After the rank tick, the cache is: 3 live, 2 ranked (cat-real + cat-dismissed; the dupe is
    // excluded), 0 dismissed.
    const afterRank = await getCatalogueSummary();
    expect(afterRank.total).toBe(3);
    expect(afterRank.ranked).toBe(2);
    expect(afterRank.dismissed).toBe(0);

    // The dismiss applies a single-row ±1 delta — NOT a full recompute — moving cat-dismissed out of
    // {total, ranked} into {dismissed}. The summary reflects it immediately from the cache.
    await setTrackDismissed("cat-dismissed", true);
    const afterDismiss = await getCatalogueSummary();
    expect(afterDismiss.ranked).toBe(1); // exactly the ear lens now: cat-real only
    expect(afterDismiss.dismissed).toBe(1);
    expect(afterDismiss.total).toBe(2); // the dismissed row is out of the live working set

    // The restore delta is the exact inverse — the cache returns to the post-rank shape without a
    // sweep in between, so the delta is honest in both directions.
    await setTrackDismissed("cat-dismissed", false);
    const afterRestore = await getCatalogueSummary();
    expect(afterRestore.ranked).toBe(2);
    expect(afterRestore.dismissed).toBe(0);
    expect(afterRestore.total).toBe(3);
  });

  it("never touches a finding — setTrackDismissed on a certified track is a no-op", async () => {
    const { setTrackDismissed } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });

    expect(await setTrackDismissed("finding-a", true)).toBe(false);
    const row = await db.execute({
      args: ["finding-a"],
      sql: "select dismissed_at from tracks where track_id = ?",
    });
    expect(row.rows[0]?.dismissed_at).toBeNull();
  });
});

// ── Catalogue-internal duplicate detection ────────────────────────────────────────────────
// The crawler walks MusicBrainz, which carries a distinct recording MBID per release, so ONE
// song enters `tracks` as several rows and each is captured + embedded separately. The sweep
// must name one canonical sibling and veto the rest off both the capture queue (the money) and
// the ear lens (the telescope), reusing `duplicate_of_track_id` + the −2 tier — never a second
// mechanism, and never merging a remix (whose `matchKey` descriptor differs from the base).
describe("catalogue-internal duplicates — one master, one row", () => {
  /** Mark a catalogue row as CAPTURED (an R2 key on file), optionally with an ISRC. */
  async function capture(trackId: string, isrc?: string): Promise<void> {
    await db.execute({
      args: [`catalogue/${trackId}/x.webm`, trackId],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
    if (isrc) {
      await db.execute({ args: [isrc, trackId], sql: isrcSql });
    }
  }

  it("marks an already-captured sibling as a duplicate of the canonical (min id, kept vector)", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // Same title + artists under two MBIDs, both captured + embedded with the same vector.
    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-a" });
    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-b" });
    await capture("cat-a");
    await capture("cat-b");
    await embed("cat-a", unit(axis(3)));
    await embed("cat-b", unit(axis(3)));

    const summary = await rankCatalogue();

    expect(summary.catalogueDuplicates).toBe(1);
    // cat-a (smaller id) is canonical and untouched; cat-b points at it, tiered −2, off the lens.
    expect((await rankingOf("cat-a")).duplicate_of_track_id).toBeNull();
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBe("cat-a");
    expect((await rankingOf("cat-b")).capture_priority).toBe(-2);
    // The duplicate KEEPS its vector — it still reads "already in the archive" on the board.
    const kept = await db.execute({
      args: ["cat-b"],
      sql: "select embedding_blob from tracks where track_id = ?",
    });
    expect(kept.rows[0]?.embedding_blob).not.toBeNull();
  });

  it("vetoes an UNcaptured sibling off the capture queue before a byte is bought", async () => {
    const { rankCatalogue } = await import("./catalogue");

    // One captured sibling, one still awaiting capture — the real spend saver.
    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-have" });
    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-want" });
    await capture("cat-have");

    await rankCatalogue();

    // cat-want has no audio → the pre-audio branch sees the captured sibling and vetoes it.
    expect((await rankingOf("cat-want")).duplicate_of_track_id).toBe("cat-have");
    expect((await rankingOf("cat-want")).capture_priority).toBe(-2);
    // The captured canonical is never marked a duplicate of itself.
    expect((await rankingOf("cat-have")).duplicate_of_track_id).toBeNull();
  });

  it("matches on an exact ISRC even when the titles drift between MBIDs", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogueTrack(db, {
      artists: ["Archangel"],
      title: "Obsession",
      trackId: "cat-isrc-x",
    });
    await seedCatalogueTrack(db, {
      artists: ["Archangel"],
      title: "Obsession (Remastered)",
      trackId: "cat-isrc-y",
    });
    await capture("cat-isrc-x", "GBTEST0000001");
    // A different title (a remaster tag) means matchKey differs, so ONLY the shared ISRC links them.
    await db.execute({
      args: ["catalogue/cat-isrc-y/x.webm", "cat-isrc-y"],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
    await db.execute({ args: ["GBTEST0000001", "cat-isrc-y"], sql: isrcSql });
    await embed("cat-isrc-x", unit(axis(4)));
    await embed("cat-isrc-y", unit(axis(4)));

    await rankCatalogue();

    expect((await rankingOf("cat-isrc-y")).duplicate_of_track_id).toBe("cat-isrc-x");
  });

  it("does NOT merge a remix — a different version descriptor is a different recording", async () => {
    const { rankCatalogue } = await import("./catalogue");

    await seedCatalogueTrack(db, { artists: ["J-Cut"], title: "Deep End", trackId: "cat-orig" });
    await seedCatalogueTrack(db, {
      artists: ["J-Cut"],
      title: "Deep End (VIP)",
      trackId: "cat-vip",
    });
    await capture("cat-orig");
    await capture("cat-vip");
    await embed("cat-orig", unit(axis(6)));
    await embed("cat-vip", unit(axis(7)));

    const summary = await rankCatalogue();

    expect(summary.catalogueDuplicates).toBe(0);
    expect((await rankingOf("cat-orig")).duplicate_of_track_id).toBeNull();
    expect((await rankingOf("cat-vip")).duplicate_of_track_id).toBeNull();
  });
});

// ── The dupe-veto escape hatch — force_capture ────────────────────────────────────────────────
// A duplicate veto (`duplicate_of_track_id` + the −2 tier) can be WRONG in rare cases — a shared or
// mis-assigned ISRC, a `matchKey` collision on a genuinely different recording — and it is
// self-sealing: an uncaptured vetoed row is excluded from capture forever, so the post-audio check
// that would exonerate it never runs. `forceCapture` is the only exit. It stamps a STICKY
// `capture_status` sentinel all three duplicate detectors respect, so the self-healing re-rank never
// re-marks the row (docs/the-ear.md § Duplicates). It bypasses the DUPLICATE veto, never the
// VERIFICATION gate — wrong audio still quarantines.
describe("the dupe-veto escape hatch — force_capture", () => {
  /** Read one row's capture_status (the sticky-override sentinel lives here). */
  async function statusOf(trackId: string): Promise<null | string> {
    const result = await db.execute({
      args: [trackId],
      sql: `select capture_status from tracks where track_id = ?`,
    });

    return (result.rows[0]?.capture_status as null | string) ?? null;
  }

  /** Mark a catalogue row CAPTURED (an R2 key on file), the way a real capture would. */
  async function capture(trackId: string): Promise<void> {
    await db.execute({
      args: [`catalogue/${trackId}/x.webm`, trackId],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
  }

  it("lifts a catalogue-internal duplicate veto and SURVIVES a re-rank — the forced row is never re-marked", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");

    // Two captured siblings, same identity → cat-b is marked a duplicate of cat-a (the min-id
    // canonical). This is the RFC's `matchKey`-collision case: the operator says they are NOT one
    // recording.
    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-a" });
    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-b" });
    await capture("cat-a");
    await capture("cat-b");
    await embed("cat-a", unit(axis(3)));
    await embed("cat-b", unit(axis(3)));
    await rankCatalogue();
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBe("cat-a");

    // The operator overrules the veto.
    expect(await forceCapture("cat-b")).toBe(true);
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBeNull();
    expect(await statusOf("cat-b")).toBe("duplicate-cleared");

    // A second force is an idempotent no-op — the row is no longer vetoed.
    expect(await forceCapture("cat-b")).toBe(false);

    // THE CORE PROOF: a re-rank re-stamps duplicates on every tick as the corpus moves, but the
    // sticky override means it MUST NOT re-mark the forced row.
    const summary = await rankCatalogue();
    expect(summary.catalogueDuplicates).toBe(0);
    expect((await rankingOf("cat-b")).duplicate_of_track_id).toBeNull();
    expect(await statusOf("cat-b")).toBe("duplicate-cleared");
    // The canonical is untouched, and it never becomes a duplicate of the forced row either.
    expect((await rankingOf("cat-a")).duplicate_of_track_id).toBeNull();
  });

  it("puts an uncaptured pre-audio ISRC duplicate back on the capture ladder at its HONEST tier, and into the capture queue", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    // Open the catalogue budget so the capture work queue actually serves catalogue rows.
    await setCatalogueCapturePaused(false);

    // A finding and an UNCAPTURED catalogue row share an ISRC (a mis-assigned one) → the pre-audio
    // ISRC veto marks the catalogue row a duplicate at tier −2, so it is never bought. The artist is
    // also on the finding, so its HONEST ladder tier is 3 (artist).
    await seedArtistRow("art-known", "Known", "known");
    await seedFinding("finding-owned", {
      artists: ["Known"],
      isrc: "GBTEST0000009",
      vector: axis(0),
    });
    await edge("finding-owned", "art-known"); // Known is a qualified artist
    await seedCatalogue("cat-wrongisrc", { artists: ["Known"], isrc: "GBTEST0000009" });
    await edge("cat-wrongisrc", "art-known");
    await rankCatalogue();
    expect((await rankingOf("cat-wrongisrc")).duplicate_of_track_id).toBe("finding-owned");
    expect((await rankingOf("cat-wrongisrc")).capture_priority).toBe(-2);

    // The operator forces it — the shared ISRC is wrong; this is a different recording.
    expect(await forceCapture("cat-wrongisrc")).toBe(true);

    // A re-rank lands it back on the ladder at its honest tier (3), NOT re-vetoed to −2.
    await rankCatalogue();
    const row = await rankingOf("cat-wrongisrc");
    expect(row.duplicate_of_track_id).toBeNull();
    expect(row.capture_priority).toBe(3);

    // And it is now capture-eligible: the next open-budget tick buys it.
    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(work.map((w) => w.trackId)).toContain("cat-wrongisrc");
  });

  it("a forced SAME-title near-1.0 row ranks on its own merits instead of being re-marked a finding duplicate", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-owned", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await seedCatalogue("cat-dupe", { artists: ["Dupe"], title: "Infinity", vector: axis(0) });
    await rankCatalogue();
    // A same-title near-1.0 vectored row is stamped a TRUE duplicate (tier −2, finding stored).
    expect((await rankingOf("cat-dupe")).duplicate_of_track_id).toBe("finding-owned");

    expect(await forceCapture("cat-dupe")).toBe(true);

    // A re-rank scores it normally (near-1.0) and does NOT re-stamp the duplicate; it is NOT
    // quarantined either (same title is never wrong audio), and the override stays sticky.
    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(0);
    const row = await rankingOf("cat-dupe");
    expect(row.duplicate_of_track_id).toBeNull();
    expect(row.nearest_finding_score ?? 0).toBeGreaterThan(0.99);
    expect(await statusOf("cat-dupe")).toBe("duplicate-cleared");
  });

  it("still quarantines WRONG AUDIO on a duplicate-cleared row — bypasses the DUPLICATE veto, never the VERIFICATION gate", async () => {
    const { WRONG_AUDIO_STATUS, rankCatalogue } = await import("./catalogue");

    // A forced row that then captures the WRONG audio (a cross-title near-1.0 to a DIFFERENT-titled
    // finding) must still quarantine — the escape hatch never lets bad bytes through.
    await seedFinding("finding-shelter", {
      artists: ["Flowidus"],
      title: "Shelter",
      vector: axis(0),
    });
    await seedCatalogue("cat-fyl", {
      artists: ["Flowidus"],
      title: "Find Your Love",
      vector: axis(0),
    });
    // Simulate the row's post-capture state carrying the sticky override.
    await db.execute({
      args: ["cat-fyl"],
      sql: `update tracks
            set capture_status = 'duplicate-cleared', source_audio_key = 'catalogue/cat-fyl/x.webm'
            where track_id = ?`,
    });

    const summary = await rankCatalogue();
    expect(summary.quarantined).toBe(1);
    expect(await statusOf("cat-fyl")).toBe(WRONG_AUDIO_STATUS);
  });

  it("refuses a finding and a non-duplicate row — an honest no-op success", async () => {
    const { forceCapture } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogue("cat-plain");

    // A finding is never a duplicate row → refused (the findings guard).
    expect(await forceCapture("finding-a")).toBe(false);
    // A catalogue row that is not vetoed as a duplicate → nothing to force.
    expect(await forceCapture("cat-plain")).toBe(false);
    // A row that does not exist → false.
    expect(await forceCapture("nope")).toBe(false);
  });

  // ── The sentinel survives the capture it enables (the ruling guard, track-update.ts) ─────
  // The forced row is EXPECTED to be captured, and the capture sweep's terminal PATCH
  // (`captureStatus: 'done'`) would erase the sentinel at exactly the moment it must hold — the
  // post-embed re-rank would then re-mark the row a duplicate, silently reversing the ruling
  // right after the capture the operator paid for. These cases run the FULL arc through the SAME
  // generic update path the box sweep PATCHes, so the guard is exercised for real.

  it("FULL ARC: force → capture done (real update path) → embed → re-rank — the ruling is never reversed", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");
    const { updateTrack } = await import("./track-update");

    // A corpus finding so the scored path has something to rank against.
    await seedFinding("finding-x", { vector: axis(5) });
    // The canonical captured+embedded sibling, and the uncaptured row the sweep vetoes as its
    // duplicate — the matchKey-collision case the operator overrules.
    await seedCatalogueTrack(db, { artists: ["Whiney"], title: "Nightfall", trackId: "cat-can" });
    await seedCatalogueTrack(db, {
      artists: ["Whiney"],
      title: "Nightfall",
      trackId: "cat-forced",
    });
    await capture("cat-can");
    await embed("cat-can", unit(axis(3)));
    await rankCatalogue();
    expect((await rankingOf("cat-forced")).duplicate_of_track_id).toBe("cat-can");

    // Force, then re-rank onto the honest ladder (nothing ties it to the archive → tier 0).
    expect(await forceCapture("cat-forced")).toBe(true);
    await rankCatalogue();
    expect((await rankingOf("cat-forced")).capture_priority).toBe(0);

    // THE CAPTURE SUCCEEDS — through the generic update path, with the exact PATCH shape the box
    // sweep sends on success. The ruling guard must keep the sentinel standing while every other
    // capture column lands normally.
    const now = new Date().toISOString();
    await updateTrack(
      "cat-forced",
      {
        captureStatus: "done",
        sourceAudioAttemptedAt: now,
        sourceAudioBytes: 1234,
        sourceAudioCapturedAt: now,
        sourceAudioKey: "catalogue/cat-forced/fresh.webm",
      },
      { writer: "agent" },
    );
    expect(await statusOf("cat-forced")).toBe("duplicate-cleared");
    const captured = await db.execute({
      args: ["cat-forced"],
      sql: `select source_audio_key from tracks where track_id = ?`,
    });
    expect(captured.rows[0]?.source_audio_key).toBe("catalogue/cat-forced/fresh.webm");

    // The fresh audio embeds; the row-half staleness re-picks it (vector + non-negative tier).
    // Its identity STILL collides with cat-can — without the surviving sentinel this is the tick
    // that would silently re-mark it −2. With it: scored normally, ruling intact.
    await embed("cat-forced", unit(axis(3)));
    const summary = await rankCatalogue();
    expect(summary.catalogueDuplicates).toBe(0);
    const row = await rankingOf("cat-forced");
    expect(row.duplicate_of_track_id).toBeNull();
    expect(row.nearest_finding_score).not.toBeNull();
    expect(row.capture_priority).toBeNull();
    expect(await statusOf("cat-forced")).toBe("duplicate-cleared");
  });

  it("a CAPTURED duplicate-cleared row never re-enters the capture worklist — even in the window before the next re-rank", async () => {
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    await setCatalogueCapturePaused(false);
    // The post-capture window: sentinel standing, audio key landed, and the PRE-capture ladder
    // tier (3) still stamped because the rank sweep has not ticked yet. Without the queue's
    // key-null condition this row would be bought again.
    await seedFinding("finding-a", { artists: ["Known"], vector: axis(0) });
    await seedCatalogue("cat-forced", { artists: ["Known"] });
    await db.execute({
      args: ["cat-forced"],
      sql: `update tracks
            set capture_status = 'duplicate-cleared',
                capture_priority = 3,
                source_audio_key = 'catalogue/cat-forced/fresh.webm'
            where track_id = ?`,
    });

    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(work.map((w) => w.trackId)).not.toContain("cat-forced");
  });

  it("a duplicate-cleared row WITH audio is embed- and analyze-eligible — the forced row still gets its vector", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedCatalogue("cat-forced");
    await db.execute({
      args: ["cat-forced"],
      sql: `update tracks
            set capture_status = 'duplicate-cleared',
                capture_priority = 0,
                source_audio_key = 'catalogue/cat-forced/fresh.webm'
            where track_id = ?`,
    });

    const embedWork = await listTrackWork({ kind: "embed", scope: "catalogue" });
    expect(embedWork.map((w) => w.trackId)).toContain("cat-forced");
    const analyzeWork = await listTrackWork({ kind: "analyze", scope: "catalogue" });
    expect(analyzeWork.map((w) => w.trackId)).toContain("cat-forced");
  });

  it("a FAILED forced capture keeps the sentinel (never re-marked) and backs off on the attempt stamp", async () => {
    const { forceCapture, rankCatalogue } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");
    const { updateTrack } = await import("./track-update");

    await setCatalogueCapturePaused(false);
    // An uncaptured sibling pair → cat-want vetoed → forced → back on the honest ladder.
    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-have" });
    await seedCatalogueTrack(db, { artists: ["Bcee"], title: "Souls Apart", trackId: "cat-want" });
    await capture("cat-have");
    await rankCatalogue();
    expect((await rankingOf("cat-want")).duplicate_of_track_id).toBe("cat-have");
    expect(await forceCapture("cat-want")).toBe(true);
    await rankCatalogue();

    // The capture FAILS — the sweep's failure PATCH. The sentinel survives (the status never
    // becomes 'failed'), so a later re-rank still honours the ruling…
    await updateTrack(
      "cat-want",
      {
        captureStatus: "failed",
        sourceAudioAttemptedAt: new Date().toISOString(),
        sourceAudioFailures: 1,
      },
      { writer: "agent" },
    );
    expect(await statusOf("cat-want")).toBe("duplicate-cleared");
    await rankCatalogue();
    expect((await rankingOf("cat-want")).duplicate_of_track_id).toBeNull();

    // …and the retry is BOUNDED like a failed row: the fresh attempt stamp holds it out of the
    // worklist until the cooldown passes; an old stamp re-admits it.
    const fresh = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(fresh.map((w) => w.trackId)).not.toContain("cat-want");

    await db.execute({
      args: ["2000-01-01T00:00:00.000Z", "cat-want"],
      sql: `update tracks set source_audio_attempted_at = ? where track_id = ?`,
    });
    const cooled = await listTrackWork({ kind: "capture", scope: "catalogue" });
    expect(cooled.map((w) => w.trackId)).toContain("cat-want");
  });
});

// ── The long-form veto (docs/the-ear.md § The long-form veto) ─────────────────────────────
// A "track" at/above LONG_FORM_MS is a continuous DJ mix riding a compilation release: unloggable
// as a finding, centroid-like in vector space (it ranks ~0.92 against ANY finding), and the
// fattest thing the metered capture can buy. The veto is a READ + QUEUE exclusion, never a
// deletion — a captured mix keeps its bytes and vector.
describe("the long-form veto — a continuous mix never reaches a lens or the money", () => {
  async function captureAt(trackId: string): Promise<void> {
    await db.execute({
      args: [`catalogue/${trackId}/x.webm`, trackId],
      sql: `update tracks set source_audio_key = ?, capture_status = 'done' where track_id = ?`,
    });
  }

  it("a scored 70-minute mix is excluded from the ear lens (and its ranked count) — a 6-minute track is not", async () => {
    const { getCatalogueSummary, listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    await seedCatalogueTrack(db, {
      artists: ["Etherwood"],
      durationMs: 70 * 60_000,
      title: "Ten Years of Test (continuous mix)",
      trackId: "cat-mix",
    });
    await seedCatalogueTrack(db, {
      artists: ["Etherwood"],
      durationMs: 6 * 60_000,
      title: "Real Single",
      trackId: "cat-single",
    });
    await captureAt("cat-mix");
    await captureAt("cat-single");
    // The mix's hour-long mean-pool sits NEARER the finding than the single — the exact
    // pathology: without the veto it would occupy the top slot.
    await embed("cat-mix", blend(axis(0), axis(1), 0.05));
    await embed("cat-single", blend(axis(0), axis(1), 0.2));

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    expect(ear.map((t) => t.trackId)).toEqual(["cat-single"]);

    const summary = await getCatalogueSummary();
    expect(summary.ranked).toBe(1);
  });

  it("an uncaptured 70-minute mix never enters the capture worklist — the money half", async () => {
    const { rankCatalogue } = await import("./catalogue");
    const { setCatalogueCapturePaused } = await import("./capture-budget");
    const { listTrackWork } = await import("./track-work");

    await setCatalogueCapturePaused(false);
    await seedFinding("finding-a", { vector: axis(0) });
    // Both rows are on an ENABLED label (authorized), so the ONLY thing separating them is
    // duration — isolating the long-form veto (RFC artist-primary-capture keeps authorization
    // orthogonal to the duration guard).
    await ruleLabel("lbl-seed", "Critical Music", "critical-music", "enabled");
    await seedCatalogueTrack(db, {
      artists: ["Someone"],
      durationMs: 78 * 60_000,
      label: "Critical Music",
      title: "Summer Selection (Continuous mix 1)",
      trackId: "cat-mix-uncaptured",
    });
    await seedCatalogueTrack(db, {
      artists: ["Someone"],
      durationMs: 5 * 60_000,
      label: "Critical Music",
      title: "Buy Me",
      trackId: "cat-buyme",
    });

    await rankCatalogue();

    const work = await listTrackWork({ kind: "capture", scope: "catalogue" });
    const ids = work.map((item) => item.trackId);
    expect(ids).toContain("cat-buyme");
    expect(ids).not.toContain("cat-mix-uncaptured");
  });

  it("a captured row with NO store preview still auditions — hasCapturedAudio is the fallback signal", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-a", { vector: axis(0) });
    // No isrc, no preview_url seeded — the small-label case (the real "Talk to You" row).
    await seedCatalogueTrack(db, {
      artists: ["Changing Faces"],
      durationMs: 4 * 60_000 + 30_000,
      title: "Talk to You",
      trackId: "cat-noprev",
    });
    await captureAt("cat-noprev");
    await embed("cat-noprev", blend(axis(0), axis(1), 0.2));

    await rankCatalogue();

    const ear = await listCatalogueTracks("ear");
    const row = ear.find((t) => t.trackId === "cat-noprev");
    expect(row?.hasPreview).toBe(false);
    expect(row?.hasCapturedAudio).toBe(true);
  });

  // ── requeue_unmatched_captures — the terminal-unmatched rescue ────────────────────────
  it("re-queues only clean-duration unmatched CATALOGUE rows; vetoed rows and findings stay put", async () => {
    const { requeueUnmatchedCaptures } = await import("./catalogue");

    await seedCatalogueTrack(db, { durationMs: 270_000, trackId: "unm-clean" });
    await seedCatalogueTrack(db, { durationMs: 0, trackId: "unm-nodur" });
    await seedCatalogueTrack(db, { durationMs: 70 * 60_000, trackId: "unm-long" });
    await seedFinding("unm-find");
    await db.execute({
      sql: `update tracks set capture_status = 'unmatched', source_audio_failures = 5
            where track_id like 'unm-%'`,
    });

    const result = await requeueUnmatchedCaptures();

    // Only the clean-duration catalogue row is rescued; the missing-duration and long-form
    // rows would be re-refused by the queue's vetoes, so re-queueing them buys a
    // guaranteed-unmatched billed search — they stay terminal, counted honestly.
    expect(result).toEqual({ requeued: 1, skippedVetoed: 2 });

    const states = await db.execute({
      sql: `select track_id, capture_status, source_audio_failures from tracks
            where track_id like 'unm-%' order by track_id`,
    });
    const rows = states.rows as unknown as Array<{
      capture_status: null | string;
      source_audio_failures: number;
      track_id: string;
    }>;
    const byId = new Map(
      rows.map((row) => [
        row.track_id,
        { failures: Number(row.source_audio_failures), status: row.capture_status },
      ]),
    );
    expect(byId.get("unm-clean")).toEqual({ failures: 0, status: "pending" });
    expect(byId.get("unm-nodur")?.status).toBe("unmatched");
    expect(byId.get("unm-long")?.status).toBe("unmatched");
    // A FINDING marked unmatched is never this op's business — its own re-capture flows own it.
    expect(byId.get("unm-find")?.status).toBe("unmatched");

    // Idempotent: the rescued row is gone from the unmatched set; the vetoed pile is stable.
    expect(await requeueUnmatchedCaptures()).toEqual({ requeued: 0, skippedVetoed: 2 });
  });

  // ── the unmatched/failed observability lenses + the captureStatus DTO field ────────────
  it("exposes capture outcomes: the unmatched and failed lenses, newest attempt first, with captureStatus", async () => {
    const { listCatalogueTracks } = await import("./catalogue");

    await seedCatalogueTrack(db, { trackId: "obs-unm-old" });
    await seedCatalogueTrack(db, { trackId: "obs-unm-new" });
    await seedCatalogueTrack(db, { trackId: "obs-fail" });
    await seedCatalogueTrack(db, { trackId: "obs-pending" });
    await seedFinding("obs-find");
    await db.execute({
      sql: `update tracks set capture_status = 'unmatched',
                              source_audio_attempted_at = '2026-07-10T00:00:00Z'
            where track_id = 'obs-unm-old'`,
    });
    await db.execute({
      sql: `update tracks set capture_status = 'unmatched',
                              source_audio_attempted_at = '2026-07-14T00:00:00Z'
            where track_id = 'obs-unm-new'`,
    });
    await db.execute({
      sql: `update tracks set capture_status = 'failed',
                              source_audio_attempted_at = '2026-07-12T00:00:00Z'
            where track_id in ('obs-fail', 'obs-find')`,
    });
    await db.execute({
      sql: `update tracks set capture_status = 'pending', capture_priority = 3
            where track_id = 'obs-pending'`,
    });

    const unmatched = await listCatalogueTracks("unmatched");
    expect(unmatched.map((t) => t.trackId)).toEqual(["obs-unm-new", "obs-unm-old"]);
    expect(unmatched[0]?.captureStatus).toBe("unmatched");

    // The failed lens is catalogue-scoped: the failed FINDING never appears in it.
    const failed = await listCatalogueTracks("failed");
    expect(failed.map((t) => t.trackId)).toEqual(["obs-fail"]);
    expect(failed[0]?.captureStatus).toBe("failed");

    // The status rides every lens's DTO, so any view can say where a row stands.
    const capture = await listCatalogueTracks("capture");
    const pending = capture.find((t) => t.trackId === "obs-pending");
    expect(pending?.captureStatus).toBe("pending");
  });
});

describe("the diversity decay — the ear page spreads artists, years, and keys", () => {
  it("a same-artist clone wall is interleaved: the fresh artist rises past the second clone", async () => {
    const { listCatalogueTracks, rankCatalogue } = await import("./catalogue");

    await seedFinding("finding-anchor", { vector: axis(0) });

    // Three near-identical rows by ONE artist (the clone magnet), descending raw score...
    await seedCatalogue("cat-clone-1", {
      artists: ["Clone Artist"],
      key: "A Minor",
      releaseDate: "2019-05-01",
      vector: blend(axis(0), axis(1), 0.16),
    });
    await seedCatalogue("cat-clone-2", {
      artists: ["Clone Artist"],
      key: "A Minor",
      releaseDate: "2019-06-01",
      vector: blend(axis(0), axis(1), 0.18),
    });
    await seedCatalogue("cat-clone-3", {
      artists: ["Clone Artist"],
      key: "A Minor",
      releaseDate: "2019-07-01",
      vector: blend(axis(0), axis(1), 0.2),
    });
    // ...and a different artist scoring just below clone-2's raw score. Undecayed it ranks
    // third; the artist decay on clone-2 (second Clone Artist row) drops it below.
    await seedCatalogue("cat-fresh", {
      artists: ["Fresh Artist"],
      key: "F Major",
      releaseDate: "2023-01-01",
      vector: blend(axis(0), axis(1), 0.19),
    });

    await rankCatalogue();

    const page = await listCatalogueTracks("ear");

    // Raw order would be clone-1, clone-2, fresh, clone-3. Diversified: clone-1 leads (best
    // raw), then FRESH (clone-2 pays the artist decay), then the remaining clones.
    expect(page.map((track) => track.trackId)).toEqual([
      "cat-clone-1",
      "cat-fresh",
      "cat-clone-2",
      "cat-clone-3",
    ]);

    // The DISPLAYED score stays the raw similarity — the decay re-orders, never rewrites.
    const fresh = page.find((track) => track.trackId === "cat-fresh");
    expect(fresh?.nearestFindingScore ?? 0).toBeGreaterThan(0.9);
  });
});
