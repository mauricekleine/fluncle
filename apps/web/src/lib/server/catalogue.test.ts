import { describe, expect, it } from "vitest";

import {
  type ArchiveAffinity,
  capturePriorityFor,
  DUPLICATE_CAPTURE_TIER,
  rankCorpus,
} from "./catalogue";

// The two pure pieces of The Ear (docs/the-ear.md): the pre-audio capture ladder, and the
// staleness fingerprint. Both are side-effect-free by design — the ladder because the sweep
// and the surface must never disagree about WHY a track is next (they call the same
// function), the fingerprint because it is the entire staleness model and has to be
// readable at a glance.
//
// The ladder's behaviour against the REAL schema (a real archive, real labels, the graph, the
// fold, the weighted qualification) is proven in catalogue.integration.test.ts; these cases pin
// the pure decision — AUTHORIZATION (by artist identity or an enabled label) vs PRIORITY (the
// ordering hint) — that the sweep and the surface share (RFC artist-primary-capture, slice 1).

// A qualified artist id — one that has earned the spend (a certified finding, or a weighted
// release count ≥ 3 on enabled labels). Authorization is by THIS, never by a name-fold.
const KRAKOTA_ID = "artist-krakota";

const archive: ArchiveAffinity = {
  // Anjunabeats is the real shape of the problem: it is RULED OUT, and it CARRIES a finding
  // (a single crossover remix) — as do all 8 of the operator's disabled labels.
  disabledLabels: new Set(["anjunabeats"]),
  // The tier-3 ORDERING hint (names on a finding). Never authorization now.
  findingArtists: new Set(["krakota", "nu:tone"]),
  // A label carrying a finding is a HINT, never authorization. `atlantic-uk` is the live
  // counter-example: an un-enabled label with one crossover finding, whose label-mates must
  // NOT be authorized by it.
  findingLabels: new Set(["anjunabeats", "atlantic-uk", "hospital-records"]),
  // The AUTHORIZATION set — qualified artist ids.
  qualifiedArtists: new Set([KRAKOTA_ID]),
  // The enabled labels — the label side of authorization.
  seedLabels: new Set(["hospital-records", "critical-music"]),
};

describe("capturePriorityFor — authorization (the artist-driven gate)", () => {
  it("authorizes a track by a QUALIFIED artist (identity) and puts it at the top (3)", () => {
    // A qualified artist authorizes even on an UNDECIDED label the operator has not ruled on:
    // capture follows the artist, discovery follows the label.
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Some Undecided Label" },
        archive,
      ),
    ).toEqual({ priority: 3, reason: { kind: "artist", name: "Krakota" } });
  });

  it("authorizes an EDGE-LESS track only via its enabled label (1)", () => {
    // ~2/3 of catalogue rows carry no graph edges until slice 0 drains. An edge-less row can
    // authorize ONLY through its enabled label — never a name-fold.
    expect(
      capturePriorityFor({ artistIds: [], artists: ["Nobody"], label: "Critical Music" }, archive),
    ).toEqual({ priority: 1, reason: { kind: "seed-label", name: "Critical Music" } });
  });

  it("SINKS an edge-less name-match on an un-enabled label — identity-only, not name-fold", () => {
    // "Krakota" is on a finding (the tier-3 name hint), but this row has no graph edge and its
    // label is not enabled — so it is NOT authorized. The name would only ORDER it, never buy it.
    expect(
      capturePriorityFor(
        { artistIds: [], artists: ["Krakota"], label: "Some Undecided Label" },
        archive,
      ),
    ).toEqual({ priority: -3, reason: { kind: "unauthorized", name: null } });
  });

  it("does NOT authorize label-mates off a finding on a NON-enabled label (the Atlantic-UK pin)", () => {
    // THE COUNTER-EXAMPLE THIS RULE EXISTS FOR. One Atlantic-UK finding used to lift every
    // crawled Atlantic-UK track to tier 2 and into the budget. A finding lifts its ARTIST, never
    // its label's neighbours — so an un-enabled label carrying a finding no longer authorizes.
    expect(
      capturePriorityFor({ artistIds: [], artists: ["Nobody"], label: "Atlantic UK" }, archive),
    ).toEqual({ priority: -3, reason: { kind: "unauthorized", name: null } });
  });

  it("sinks an unqualified artist on an undecided label with no findings to `unauthorized`", () => {
    expect(
      capturePriorityFor(
        { artistIds: ["artist-unknown"], artists: ["Nobody"], label: "Some Trance Imprint" },
        archive,
      ),
    ).toEqual({ priority: -3, reason: { kind: "unauthorized", name: null } });
  });

  it("sinks a bare row (no artists, no label) to `unauthorized`", () => {
    expect(capturePriorityFor({ artistIds: [], artists: [], label: null }, archive)).toEqual({
      priority: -3,
      reason: { kind: "unauthorized", name: null },
    });
  });
});

describe("capturePriorityFor — the veto, checked first", () => {
  it("VETOES a disabled label even though it carries a finding (−1)", () => {
    // All 8 disabled labels in the real archive carry a finding — each arrived on one crossover
    // remix — so the `label` hint fires on every one. The veto sinks them regardless.
    expect(
      capturePriorityFor({ artistIds: [], artists: ["Nobody"], label: "Anjunabeats" }, archive),
    ).toEqual({ priority: -1, reason: { kind: "skipped-label", name: "Anjunabeats" } });
  });

  it("lets the veto beat even a QUALIFIED artist — the operator's ruling wins", () => {
    // A qualified DnB artist doing a remix on a ruled-out label. Authorization is the strongest
    // signal there is, and the ruling still wins: he TOLD us the label is not his lane.
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Anjunabeats" },
        archive,
      ),
    ).toEqual({ priority: -1, reason: { kind: "skipped-label", name: "Anjunabeats" } });
  });

  it("keeps the veto to ACQUISITION, never storage — the reason still NAMES the label", () => {
    const { reason } = capturePriorityFor(
      { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Anjunabeats" },
      archive,
    );

    expect(reason.name).toBe("Anjunabeats");
  });
});

describe("capturePriorityFor — priority ordering among AUTHORIZED rows", () => {
  it("falls to the label a finding sits on (2), but only once ENABLED-authorized, through the fold", () => {
    // `Hospital Records.` and `Hospital Records` are one label (labelSlug). It is enabled (so the
    // row is authorized) AND carries a finding, so it lands the tier-2 hint.
    expect(
      capturePriorityFor(
        { artistIds: [], artists: ["Nobody"], label: "Hospital Records." },
        archive,
      ),
    ).toEqual({ priority: 2, reason: { kind: "label", name: "Hospital Records." } });
  });

  it("names a QUALIFIED artist by the row's own first credit when the spelling is not on a finding", () => {
    // A weighted-count qualifier whose name is not literally on any finding still earns the top
    // rung; the reason speaks the row's own spelling back.
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Fresh Name"], label: null },
        archive,
      ),
    ).toEqual({ priority: 3, reason: { kind: "artist", name: "Fresh Name" } });
  });

  it("matches the finding-artist hint case-insensitively, naming the spelling the TRACK carries", () => {
    // The archive set is lowercased; the reason must speak the row's own spelling back.
    expect(
      capturePriorityFor(
        { artistIds: [], artists: ["Guest", "NU:TONE"], label: "Critical Music" },
        archive,
      ),
    ).toEqual({ priority: 3, reason: { kind: "artist", name: "NU:TONE" } });
  });

  it("prefers the strongest rung — a qualified artist beats a label hint", () => {
    expect(
      capturePriorityFor(
        { artistIds: [KRAKOTA_ID], artists: ["Krakota"], label: "Hospital Records" },
        archive,
      ).reason.kind,
    ).toBe("artist");
  });

  it("never lets a blank or all-punctuation label authorize an edge-less row", () => {
    // `labelSlug` returns undefined for these, so there is no enabled label to authorize on.
    for (const label of ["", "   ", "."]) {
      expect(capturePriorityFor({ artistIds: [], artists: ["Nobody"], label }, archive)).toEqual({
        priority: -3,
        reason: { kind: "unauthorized", name: null },
      });
    }
  });
});

describe("capturePriorityFor — the negative band is distinct and ordered", () => {
  it("gives `unauthorized` its own tier, below the veto and the duplicate", () => {
    // Three distinct negatives, all excluded from the capture queue by `capture_priority >= 0`.
    // Their order (a DESC board read) is by how SPECIFIC the reason is: an explicit ruling and an
    // identity fact outrank the default "not qualified yet".
    const unauthorized = capturePriorityFor(
      { artistIds: [], artists: ["Nobody"], label: "Some Trance Imprint" },
      archive,
    );
    const vetoed = capturePriorityFor(
      { artistIds: [], artists: ["Nobody"], label: "Anjunabeats" },
      archive,
    );

    expect(vetoed.priority).toBe(-1);
    expect(DUPLICATE_CAPTURE_TIER).toBe(-2);
    expect(unauthorized.priority).toBe(-3);
    expect(unauthorized.priority).toBeLessThan(DUPLICATE_CAPTURE_TIER);
    expect(DUPLICATE_CAPTURE_TIER).toBeLessThan(vetoed.priority);
  });
});

describe("rankCorpus — the staleness fingerprint", () => {
  it("moves when a finding is logged, and when one is embedded", () => {
    expect(rankCorpus(60, 60, 0, 0, 0)).toBe("v4:60:60:0:0:0");
    // A new finding lands (unembedded): the affinity corpus changed, so every ranked row is stale.
    expect(rankCorpus(61, 60, 0, 0, 0)).not.toBe(rankCorpus(60, 60, 0, 0, 0));
    // Then it embeds: a new vector to be near, so every scored row is stale too.
    expect(rankCorpus(61, 61, 0, 0, 0)).not.toBe(rankCorpus(61, 60, 0, 0, 0));
  });

  it("moves when the ARTIST GRAPH grows — so slice 0's backfill re-ranks old rows", () => {
    // Authorization depends on the graph, which the two finding counts do not see. A new
    // `track_artists` edge must re-stale the catalogue or the new gate never reaches old rows.
    expect(rankCorpus(60, 60, 100, 5, 8)).not.toBe(rankCorpus(60, 60, 99, 5, 8));
  });

  it("moves when a label ruling changes — an enable or a disable re-ranks the catalogue", () => {
    expect(rankCorpus(60, 60, 100, 6, 8)).not.toBe(rankCorpus(60, 60, 100, 5, 8));
    expect(rankCorpus(60, 60, 100, 5, 9)).not.toBe(rankCorpus(60, 60, 100, 5, 8));
  });

  it("catches a DELETED finding, because it is compared for INEQUALITY and not order", () => {
    expect(rankCorpus(59, 59, 0, 0, 0)).not.toBe(rankCorpus(60, 60, 0, 0, 0));
  });

  it("is a no-op fingerprint on an unchanged archive", () => {
    expect(rankCorpus(60, 60, 100, 5, 8)).toBe(rankCorpus(60, 60, 100, 5, 8));
  });
});
