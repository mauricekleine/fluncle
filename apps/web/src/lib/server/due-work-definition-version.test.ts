import { describe, expect, it } from "vitest";

import { crawlDueDefinitionVersion, CRAWL_DUE_WORK_FRONTIER } from "./crawl-due-work";
import {
  definitionFingerprint,
  probeLadderCrossing,
  probeMatrix,
  PROBE_BEFORE,
  PROBE_NOW,
} from "./due-work-definition-fingerprint";
import {
  DUE_WORK_PROBE_LADDER,
  DUE_WORK_PROBE_THRESHOLDS,
  dueWorkDefinitionVersion,
  trackProbeMatrix,
  vendorProbeMatrix,
} from "./due-work-definition-version";
import * as entityDefinitions from "./due-work-entity-definitions";
import { DUE_WORK_KINDS } from "./due-work-entity-definitions";
import * as trackDefinitions from "./due-work-track-definitions";
import {
  describeDueWorkTrackDecision,
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  type DueWorkKind as DueWorkTrackKind,
  type DueWorkTrackSource,
} from "./due-work-track-definitions";
import * as vendorDefinitions from "./due-work-vendor-definitions";
import {
  describeDueWorkVendorDecision,
  DUE_WORK_VENDOR_WORK_KIND_INVENTORY,
  type DueWorkVendorKind,
  type DueWorkVendorSource,
} from "./due-work-vendor-definitions";

// The committed fixture of every due-work family's DEFINITION version.
//
// This is the build-fail half of the mechanism. The versions themselves are DERIVED — each one is a
// fingerprint of the running eligibility/order code over a fixed probe matrix, never a hand-bumped
// constant — so this table cannot drift from the definitions: it can only fail. Editing a queue's
// order components, its membership predicate, or one of the constants those read moves that
// family's value and fails here until the fixture is updated in the same commit.
//
// A line changing in this table is the notice that the deploy will RE-PROJECT that queue: the
// rebuild checkpoint stores the version, a mismatch is not `complete`, and the maintenance sweep
// opens a fresh generation for it (docs/database-performance.md).
const DEFINITION_VERSIONS: Record<string, string> = {
  "album.bio": "dv1-4819c920a086e930",
  "album.cover-master": "dv1-459e79a54b3a843e",
  "analyze-catalogue": "dv1-1f297b5cef0697a4",
  "analyze-findings": "dv1-22242cd998de4319",
  anchor: "dv1-4c86384c7bf91680",
  "apple-catalogue": "dv1-ed94c054757c759f",
  "apple-finding": "dv1-f0c353ca093dcca5",
  "artist-credits": "dv1-d0f5defb9c7a254c",
  "artist-edges": "dv1-c449335013e4e2c5",
  "artist.bio": "dv1-8eb4d729ca634243",
  "artist.cover-master": "dv1-793bef3a6e067a1f",
  "artist.image": "dv1-9c360030245a3584",
  "beatport-catalogue": "dv1-c74a55868e9a4b5b",
  "beatport-finding": "dv1-6cb525c623f95994",
  "capture-catalogue": "dv1-2163efcff42c1846",
  "capture-findings": "dv1-f6a5231ec5915261",
  "capture-verification": "dv1-6dfa7d33bd65c6fc",
  "catalogue-rank": "dv1-b4d716fc92aecd70",
  [CRAWL_DUE_WORK_FRONTIER]: "dv1-fb948dc996aa0790",
  "deezer-catalogue": "dv1-e4a1bc14ec6497ff",
  "deezer-finding": "dv1-5b1928fa8ae6b8b4",
  "discogs-track": "dv1-a326bfe891da6a6a",
  "embed-catalogue": "dv1-0423ac8ca65d0801",
  "embed-findings": "dv1-fc8ef789bce82fe6",
  "finding.context": "dv1-a088324065f20535",
  "finding.context.retry-empty": "dv1-1abf6af6d360c616",
  "finding.enrich": "dv1-f75bdde4dcf49b61",
  "finding.note": "dv1-3bb54f8054cd8485",
  "finding.observe": "dv1-090a2f17ce7e1650",
  "finding.render": "dv1-ab77f540425e2e6a",
  "finding.render.requires-observation": "dv1-aff14ee99090bbb5",
  "isrc-recovery": "dv1-7537e54f29cb579a",
  "label.bio": "dv1-41ae5783c64f46a9",
  "label.image": "dv1-d151b3b48f992d54",
  "lastfm-track": "dv1-1ee3b3f38ed9d959",
  "mbid-isrc-lookup": "dv1-f27e5513545bc97d",
  "mbid-isrc-refresh": "dv1-21cd21b971f56659",
  "mbid-prefix-strip": "dv1-20958d0c7aad29ea",
  "youtube-provenance-catalogue": "dv1-86b325cd42fc4589",
  "youtube-provenance-findings": "dv1-36ecb6b2ef0fd4dd",
  "youtube-reverdict-catalogue": "dv1-836c7811ef779b40",
  "youtube-reverdict-findings": "dv1-35be954cf97c7f8c",
};

function versionFor(workKind: string): string {
  return workKind === CRAWL_DUE_WORK_FRONTIER
    ? crawlDueDefinitionVersion()
    : dueWorkDefinitionVersion(workKind);
}

const REGISTERED_KINDS: readonly string[] = [
  ...DUE_WORK_TRACK_WORK_KIND_INVENTORY.map((entry) => entry.workKind),
  ...DUE_WORK_VENDOR_WORK_KIND_INVENTORY.map((entry) => entry.workKind),
  ...DUE_WORK_KINDS,
  CRAWL_DUE_WORK_FRONTIER,
];

// Every constant the three definition modules export, classified. A constant an evaluator COMPARES
// a source value against is invisible unless the ladder straddles it, so it must be in
// `DUE_WORK_PROBE_THRESHOLDS`. A constant an evaluator ADDS to a timestamp lands in the computed
// `nextDueAt`, so instead it needs a probe PAIR in the real matrix whose decisions differ — which
// is only true when some base carries the companion stamp the branch reads. Both halves are
// asserted below, and the last case in this file fails when a new exported constant appears
// without being classified here.
type ThresholdCase = { constant: string; kind: "threshold" };
type AdditiveTrackCase = {
  constant: string;
  field: keyof DueWorkTrackSource;
  kind: "additive-track";
  /** The probe in the real matrix this constant acts on, named by the fields that identify it. */
  match: Partial<DueWorkTrackSource>;
  queue: DueWorkTrackKind;
  value: unknown;
};
type AdditiveVendorCase = {
  constant: string;
  field: keyof DueWorkVendorSource;
  kind: "additive-vendor";
  match: Partial<DueWorkVendorSource>;
  queue: DueWorkVendorKind;
  value: unknown;
};
type ConstantCase = AdditiveTrackCase | AdditiveVendorCase | ThresholdCase;

const CONSTANT_CASES: readonly ConstantCase[] = [
  { constant: "ANCHOR_MAX_ATTEMPTS", kind: "threshold" },
  { constant: "BIO_INDEX_FLOOR", kind: "threshold" },
  { constant: "CAPTURE_MAX_FAILURES", kind: "threshold" },
  { constant: "DEEZER_MAX_FAILURES", kind: "threshold" },
  { constant: "LONG_FORM_MS", kind: "threshold" },
  { constant: "MIN_TRACK_MS", kind: "threshold" },
  { constant: "YOUTUBE_PROVENANCE_MAX_FAILURES", kind: "threshold" },
  {
    constant: "CAPTURE_FAILED_COOLDOWN_MS",
    field: "sourceAudioAttemptedAt",
    kind: "additive-track",
    match: { captureStatus: "failed", sourceAudioAttemptedAt: PROBE_BEFORE },
    queue: "capture",
    value: null,
  },
  {
    constant: "ANCHOR_REASK_AFTER_DAYS",
    field: "spotifyAnchorAttemptedAt",
    kind: "additive-track",
    match: { spotifyAnchorAttemptedAt: PROBE_BEFORE, spotifyUri: null },
    queue: "anchor",
    value: null,
  },
  {
    constant: "ISRC_RECOVERY_REASK_AFTER_DAYS",
    field: "isrcRecoveryAttemptedAt",
    kind: "additive-track",
    match: { captureStatus: "duplicate-cleared", isrcRecoveryAttemptedAt: PROBE_BEFORE },
    queue: "isrc-recovery",
    value: null,
  },
  {
    constant: "YOUTUBE_PROVENANCE_REASK_AFTER_DAYS",
    field: "youtubeVerifiedAt",
    kind: "additive-track",
    match: { youtubeVerifiedAt: PROBE_BEFORE, youtubeVideoId: null },
    queue: "youtube-provenance",
    value: null,
  },
  {
    constant: "VENDOR_COOLDOWN_BASE_MS",
    field: "lastfmAttemptedAt",
    kind: "additive-vendor",
    match: { lastfmAttemptedAt: PROBE_BEFORE, lastfmFailures: 0 },
    queue: "lastfm-track",
    value: null,
  },
  {
    // The clamp only bites above `VENDOR_COOLDOWN_BASE_MS * 2 ** failures`, so the pair straddles
    // the failure count at which `min(…)` starts returning the ceiling.
    constant: "VENDOR_COOLDOWN_MAX_MS",
    field: "discogsFailures",
    kind: "additive-vendor",
    match: { discogsAttemptedAt: PROBE_BEFORE, discogsFailures: 11 },
    queue: "discogs-track",
    value: 2,
  },
  {
    constant: "MBID_ISRC_REFRESH_AFTER_MS",
    field: "isrcAttemptedAt",
    kind: "additive-vendor",
    match: { isrc: null, isrcAttemptedAt: PROBE_BEFORE, mbRecordingId: "probe-recording" },
    queue: "mbid-isrc-refresh",
    value: null,
  },
];

/** The entity families are probed through their evaluators, so their additive pairs live here. */
const ENTITY_ADDITIVE_CASES: readonly {
  constant: string;
  field: string;
  kind: entityDefinitions.DueWorkKind;
  value: unknown;
}[] = [
  {
    constant: "ENRICH_STALE_PROCESSING_MS",
    field: "updated_at",
    kind: "finding.enrich",
    value: null,
  },
  {
    constant: "IMAGE_RETRY_COOLDOWN_MS",
    field: "image_attempted_at",
    kind: "label.image",
    value: null,
  },
];

function trackDecision(source: DueWorkTrackSource, queue: DueWorkTrackKind): string {
  return describeDueWorkTrackDecision(queue, source, PROBE_NOW);
}

function vendorDecision(source: DueWorkVendorSource, queue: DueWorkVendorKind): string {
  return describeDueWorkVendorDecision(queue, source, PROBE_NOW, "rank-corpus-probe");
}

/** The one probe in the real matrix whose named fields all match; ambiguity is a failing case. */
function selectProbe<Source extends Record<string, unknown>>(
  matrix: readonly Source[],
  match: Record<string, unknown>,
): Source | undefined {
  return matrix.find((source) =>
    Object.entries(match).every(([field, value]) => source[field] === value),
  );
}

/** True when the exact probe object is in the matrix the fingerprint actually hashes. */
function matrixHolds(matrix: readonly unknown[], probe: unknown): boolean {
  const wanted = JSON.stringify(probe);
  return matrix.some((entry) => JSON.stringify(entry) === wanted);
}

function exportedConstants(module: Record<string, unknown>): string[] {
  return Object.entries(module)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([name]) => name);
}

describe("due-work definition versions", () => {
  it("covers every family that owns a rebuild checkpoint", () => {
    expect(Object.keys(DEFINITION_VERSIONS).sort()).toEqual([...REGISTERED_KINDS].sort());
  });

  it("matches the committed fixture for every family", () => {
    const actual = Object.fromEntries(REGISTERED_KINDS.map((kind) => [kind, versionFor(kind)]));
    expect(actual).toEqual(DEFINITION_VERSIONS);
  });

  it("gives each family its own value", () => {
    const values = REGISTERED_KINDS.map((kind) => versionFor(kind));
    expect(new Set(values).size).toBe(values.length);
  });

  it("is stable across repeated reads", () => {
    for (const kind of REGISTERED_KINDS) {
      expect(versionFor(kind)).toBe(versionFor(kind));
    }
  });

  it("watches the anchored-first term the catalogue capture queue orders by", () => {
    // The transcript the capture-catalogue version hashes must SEE this distinction, else an
    // order change like it could ship without moving the version.
    const [base] = trackProbeMatrix();
    if (base === undefined) {
      throw new Error("the track probe matrix is empty");
    }
    const anchored = trackDecision({ ...base, spotifyUri: "spotify:track:probe" }, "capture");
    const unanchored = trackDecision({ ...base, spotifyUri: null }, "capture");
    expect(anchored).not.toBe(unanchored);
    expect(anchored < unanchored).toBe(true);
  });

  it("moves when a decision moves and holds when nothing does", () => {
    const base = { a: "1", b: "2" };
    const columns = ["a", "b"];
    const ladder = probeLadderCrossing([3]);
    const original = (row: Record<string, unknown>) => `${String(row["a"])}|${String(row["b"])}`;
    const reordered = (row: Record<string, unknown>) => `${String(row["b"])}|${String(row["a"])}`;
    const transcript = (decide: (row: Record<string, unknown>) => string) =>
      probeMatrix([base], columns, ladder).map((row, index) => `${index}:${decide(row)}`);

    expect(definitionFingerprint("probe", transcript(original))).toBe(
      definitionFingerprint("probe", transcript(original)),
    );
    expect(definitionFingerprint("probe", transcript(original))).not.toBe(
      definitionFingerprint("probe", transcript(reordered)),
    );
  });

  it("derives a ladder that straddles every threshold it is given", () => {
    const ladder = probeLadderCrossing([5, 5, 40]);
    for (const value of [4, 5, 6, 39, 40, 41]) {
      expect(ladder).toContain(value);
    }
    // Derived, so retuning a constant retunes the ladder: no hand-listed number to fall behind.
    expect(probeLadderCrossing([6])).not.toEqual(ladder);
  });
});

describe("the probe matrix crosses every constant the evaluators read", () => {
  it("straddles each compared threshold", () => {
    for (const probeCase of CONSTANT_CASES) {
      if (probeCase.kind !== "threshold") {
        continue;
      }
      const value =
        (trackDefinitions as Record<string, unknown>)[probeCase.constant] ??
        (vendorDefinitions as Record<string, unknown>)[probeCase.constant] ??
        (entityDefinitions as Record<string, unknown>)[probeCase.constant];
      expect(typeof value, probeCase.constant).toBe("number");
      expect(DUE_WORK_PROBE_THRESHOLDS, probeCase.constant).toContain(value);
      for (const crossing of [Number(value) - 1, Number(value), Number(value) + 1]) {
        expect(DUE_WORK_PROBE_LADDER, `${probeCase.constant} ${crossing}`).toContain(crossing);
      }
    }
  });

  it("reaches each additive constant through a real pair of probes in the matrix", () => {
    const tracks = trackProbeMatrix();
    const vendors = vendorProbeMatrix();
    for (const probeCase of CONSTANT_CASES) {
      if (probeCase.kind === "threshold") {
        continue;
      }
      if (probeCase.kind === "additive-track") {
        const live = selectProbe(tracks, probeCase.match);
        expect(live, `${probeCase.constant}: no matrix probe matches its selector`).toBeDefined();
        if (live === undefined) {
          continue;
        }
        expect(trackDecision(live, probeCase.queue), `${probeCase.constant} live`).not.toBe("-");
        const without = { ...live, [probeCase.field]: probeCase.value };
        expect(matrixHolds(tracks, without), `${probeCase.constant} paired probe`).toBe(true);
        expect(trackDecision(live, probeCase.queue), probeCase.constant).not.toBe(
          trackDecision(without, probeCase.queue),
        );
        continue;
      }
      const live = selectProbe(vendors, probeCase.match);
      expect(live, `${probeCase.constant}: no matrix probe matches its selector`).toBeDefined();
      if (live === undefined) {
        continue;
      }
      expect(vendorDecision(live, probeCase.queue), `${probeCase.constant} live`).not.toBe("-");
      const without = { ...live, [probeCase.field]: probeCase.value };
      expect(matrixHolds(vendors, without), `${probeCase.constant} paired probe`).toBe(true);
      expect(vendorDecision(live, probeCase.queue), probeCase.constant).not.toBe(
        vendorDecision(without, probeCase.queue),
      );
    }
  });

  it("reaches each entity constant through its own evaluator", () => {
    for (const probeCase of ENTITY_ADDITIVE_CASES) {
      const matrix = probeMatrix(
        [entityProbeBaseFor(probeCase.kind)],
        entityDefinitions.DUE_WORK_SOURCE_COLUMNS[probeCase.kind],
        DUE_WORK_PROBE_LADDER,
      );
      const live = matrix.find(
        (source) =>
          entityDecision(probeCase.kind, source) !== "-" && source[probeCase.field] !== null,
      );
      expect(live, probeCase.constant).toBeDefined();
      if (live === undefined) {
        continue;
      }
      const without = { ...live, [probeCase.field]: probeCase.value };
      expect(matrixHolds(matrix, without), `${probeCase.constant} paired probe`).toBe(true);
      expect(entityDecision(probeCase.kind, live), probeCase.constant).not.toBe(
        entityDecision(probeCase.kind, without),
      );
    }
  });

  it("classifies every exported constant, so a new one cannot slip in unprobed", () => {
    const named = new Set([
      ...CONSTANT_CASES.map((probeCase) => probeCase.constant),
      ...ENTITY_ADDITIVE_CASES.map((probeCase) => probeCase.constant),
    ]);
    const exported = [
      ...exportedConstants(trackDefinitions as Record<string, unknown>),
      ...exportedConstants(vendorDefinitions as Record<string, unknown>),
      ...exportedConstants(entityDefinitions as Record<string, unknown>),
    ];
    expect(exported.filter((name) => !named.has(name))).toEqual([]);
  });
});

// The entity harness the version module uses, duplicated here so the coverage test probes the same
// shapes without exporting the module's private base builder.
function entityProbeBaseFor(kind: entityDefinitions.DueWorkKind): Record<string, unknown> {
  const overrides: Record<string, Record<string, unknown>> = {
    "finding.enrich": { enrichment_status: "processing" },
    "label.image": { image_state: "pending" },
  };
  const base: Record<string, unknown> = {};
  for (const column of entityDefinitions.DUE_WORK_SOURCE_COLUMNS[kind]) {
    base[column] = column.endsWith("_at")
      ? PROBE_BEFORE
      : column.endsWith("_count")
        ? 5
        : `probe-${column}`;
  }
  return { ...base, ...overrides[kind] };
}

function entityDecision(
  kind: entityDefinitions.DueWorkKind,
  source: Record<string, unknown>,
): string {
  const evaluate =
    kind === "finding.enrich"
      ? entityDefinitions.evaluateFindingEnrich
      : entityDefinitions.evaluateLabelImage;
  try {
    const row = evaluate(source as never, PROBE_NOW);
    return row === null ? "-" : `${row.nextDueAt}|${row.orderKey}`;
  } catch {
    return "!";
  }
}
