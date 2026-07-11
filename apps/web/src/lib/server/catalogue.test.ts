import { describe, expect, it } from "vitest";

import { type ArchiveAffinity, capturePriorityFor, rankCorpus } from "./catalogue";

// The two pure pieces of The Ear (docs/the-ear.md): the pre-audio capture ladder, and the
// staleness fingerprint. Both are side-effect-free by design — the ladder because the sweep
// and the surface must never disagree about WHY a track is next (they call the same
// function), the fingerprint because it is the entire staleness model and has to be
// readable at a glance.
//
// The ladder's behaviour against the REAL schema (a real archive, real labels, the fold) is
// proven in catalogue.integration.test.ts; these cases pin the rungs themselves.

const archive: ArchiveAffinity = {
  // Anjunabeats is the real shape of the problem: it is RULED OUT, and it CARRIES a finding
  // (a single crossover remix) — as do all 8 of the operator's disabled labels.
  disabledLabels: new Set(["anjunabeats"]),
  findingArtists: new Set(["krakota", "nu:tone"]),
  findingLabels: new Set(["anjunabeats", "hospital-records"]),
  seedLabels: new Set(["hospital-records", "critical-music"]),
};

describe("capturePriorityFor — the pre-audio capture ladder", () => {
  it("puts an artist Fluncle has already logged at the top (3)", () => {
    expect(capturePriorityFor({ artists: ["Krakota"], label: "Some Label" }, archive)).toEqual({
      priority: 3,
      reason: { kind: "artist", name: "Krakota" },
    });
  });

  it("matches an artist case-insensitively, and names the spelling the TRACK carries", () => {
    // The archive set is lowercased; the reason must speak the row's own spelling back, since
    // that is the string the operator sees on the row.
    expect(capturePriorityFor({ artists: ["Guest", "NU:TONE"], label: null }, archive)).toEqual({
      priority: 3,
      reason: { kind: "artist", name: "NU:TONE" },
    });
  });

  it("falls to the label a finding already sits on (2), through the same slug fold", () => {
    // `Hospital Records.` and `Hospital Records` are one label everywhere else in the
    // archive (labelSlug), and they are one label here.
    expect(
      capturePriorityFor({ artists: ["Nobody"], label: "Hospital Records." }, archive),
    ).toEqual({ priority: 2, reason: { kind: "label", name: "Hospital Records." } });
  });

  it("falls to an in-lane but unproven seed label (1)", () => {
    expect(capturePriorityFor({ artists: ["Nobody"], label: "Critical Music" }, archive)).toEqual({
      priority: 1,
      reason: { kind: "seed-label", name: "Critical Music" },
    });
  });

  it("bottoms out at nothing-ties-it-to-the-archive (0)", () => {
    expect(
      capturePriorityFor({ artists: ["Nobody"], label: "Some Trance Imprint" }, archive),
    ).toEqual({ priority: 0, reason: { kind: "none", name: null } });
    expect(capturePriorityFor({ artists: [], label: null }, archive)).toEqual({
      priority: 0,
      reason: { kind: "none", name: null },
    });
  });

  it("VETOES a label the operator ruled out, even though it carries a finding (0)", () => {
    // THE BUG THIS EXISTS TO PREVENT. All 8 disabled labels in the real archive carry a
    // finding — each arrived on one crossover remix — so the `label` rung fires on every one
    // of them. Without the veto, the metered per-GB capture budget goes on trance.
    expect(capturePriorityFor({ artists: ["Nobody"], label: "Anjunabeats" }, archive)).toEqual({
      priority: 0,
      reason: { kind: "skipped-label", name: "Anjunabeats" },
    });
  });

  it("lets the veto beat even the strongest rung — a ruled-out label sinks an archive artist", () => {
    // A DnB artist Fluncle has logged, doing a remix on a label he says is not his lane. The
    // artist signal is the strongest one there is, and the ruling still wins: he TOLD us.
    expect(capturePriorityFor({ artists: ["Krakota"], label: "Anjunabeats" }, archive)).toEqual({
      priority: 0,
      reason: { kind: "skipped-label", name: "Anjunabeats" },
    });
  });

  it("keeps the veto to ACQUISITION, never storage — the row still ranks, it just ranks last", () => {
    // docs/label-entity.md: a ruling is crawl scope, never storage. A capture IS an
    // acquisition, so ordering it is in scope; the track keeps its row, its place in the
    // lens, and an honest reason. Nothing is hidden or removed — the reason NAMES the label.
    const { reason } = capturePriorityFor({ artists: ["Krakota"], label: "Anjunabeats" }, archive);

    expect(reason.name).toBe("Anjunabeats");
  });

  it("never lets a blank or all-punctuation label climb a rung", () => {
    // `labelSlug` returns undefined for these, and a track with no usable label is exactly
    // as unproven as a track with none at all.
    for (const label of ["", "   ", "."]) {
      expect(capturePriorityFor({ artists: ["Nobody"], label }, archive).priority).toBe(0);
    }
  });

  it("prefers the strongest rung when several apply", () => {
    // An artist match beats a label match, always: his ear has said yes to the ARTIST.
    expect(
      capturePriorityFor({ artists: ["Krakota"], label: "Hospital Records" }, archive).reason.kind,
    ).toBe("artist");
  });
});

describe("rankCorpus — the staleness fingerprint", () => {
  it("moves when a finding is logged, and when one is embedded", () => {
    expect(rankCorpus(60, 60)).toBe("60:60");
    // A new finding lands (unembedded): the affinity corpus changed, so every ranked row is
    // stale — its capture ladder could now name a new artist.
    expect(rankCorpus(61, 60)).not.toBe(rankCorpus(60, 60));
    // Then it embeds: a new vector to be near, so every scored row is stale too.
    expect(rankCorpus(61, 61)).not.toBe(rankCorpus(61, 60));
  });

  it("catches a DELETED finding, because it is compared for INEQUALITY and not order", () => {
    // The count going DOWN must invalidate exactly like it going up — which is why the
    // predicate is `<>` and never `<`.
    expect(rankCorpus(59, 59)).not.toBe(rankCorpus(60, 60));
  });

  it("is a no-op fingerprint on an unchanged archive", () => {
    expect(rankCorpus(60, 60)).toBe(rankCorpus(60, 60));
  });
});
