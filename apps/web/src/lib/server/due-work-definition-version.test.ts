import { describe, expect, it } from "vitest";

import { crawlDueDefinitionVersion, CRAWL_DUE_WORK_FRONTIER } from "./crawl-due-work";
import {
  definitionFingerprint,
  probeMatrix,
  PROBE_LADDER,
} from "./due-work-definition-fingerprint";
import { dueWorkDefinitionVersion } from "./due-work-definition-version";
import { DUE_WORK_KINDS } from "./due-work-entity-definitions";
import {
  describeDueWorkTrackDecision,
  DUE_WORK_TRACK_WORK_KIND_INVENTORY,
  type DueWorkTrackSource,
} from "./due-work-track-definitions";
import { DUE_WORK_VENDOR_WORK_KIND_INVENTORY } from "./due-work-vendor-definitions";

// The committed fixture of every due-work family's DEFINITION version.
//
// This is the build-fail half of the mechanism. The versions themselves are DERIVED — each one is a
// fingerprint of the running eligibility/order code over a fixed probe matrix, never a hand-bumped
// constant — so this table cannot drift from the definitions: it can only fail. Editing a queue's
// order components, its membership predicate, or one of the constants those read moves that
// family's value and fails here until the fixture is updated in the same commit.
//
// A line changing in this table is the notice that the deploy will RE-PROJECT that queue: the
// rebuild checkpoint stores the version, a mismatch is not `complete`, and the next ordinary
// `--action rebuild` step opens a fresh generation for it (docs/database-performance.md).
const DEFINITION_VERSIONS: Record<string, string> = {
  "album.bio": "dv1-ae6a250525ca12af",
  "album.cover-master": "dv1-fa078959e0a94892",
  "analyze-catalogue": "dv1-a64b5b85e0be9bb7",
  "analyze-findings": "dv1-c7d5e07420aabde2",
  anchor: "dv1-755186683419b1c7",
  "apple-catalogue": "dv1-9a7b3307062ddc7e",
  "apple-finding": "dv1-4c40d4b9baf61175",
  "artist-credits": "dv1-7441f5a0c4ecb106",
  "artist-edges": "dv1-f2621649568cb8da",
  "artist.bio": "dv1-31b293da48684c1b",
  "artist.cover-master": "dv1-6655659e1667f076",
  "artist.image": "dv1-0fc825b4cea50075",
  "beatport-catalogue": "dv1-4f542ba5e83de28f",
  "beatport-finding": "dv1-03879047c68a250a",
  "capture-catalogue": "dv1-2eca68495464e3ee",
  "capture-findings": "dv1-38f48c1d7d6d7457",
  "capture-verification": "dv1-b1be9f9eaa583610",
  "catalogue-rank": "dv1-907213f111e8f9cc",
  [CRAWL_DUE_WORK_FRONTIER]: "dv1-125b5176cf7ef83e",
  "deezer-catalogue": "dv1-e2caeb058f85c1c0",
  "deezer-finding": "dv1-8e4f8e9f17f9a622",
  "discogs-track": "dv1-8c4ae8bbd9e5501c",
  "embed-catalogue": "dv1-84ca7730e9dd487c",
  "embed-findings": "dv1-c58e29eb7745773b",
  "finding.context": "dv1-7f3f9ce325b5a38d",
  "finding.context.retry-empty": "dv1-b2530b96ce5ed6d9",
  "finding.enrich": "dv1-6e86c11c417a86c2",
  "finding.note": "dv1-f28b443af73ddc11",
  "finding.observe": "dv1-d4631793f7315410",
  "finding.render": "dv1-07eb60beb16a0d75",
  "finding.render.requires-observation": "dv1-c10fb8b128d30bf0",
  "isrc-recovery": "dv1-f4dc075d208ff323",
  "label.bio": "dv1-cd8fb67500750d4b",
  "label.image": "dv1-d03620da8971b70a",
  "lastfm-track": "dv1-6f6c35aedb05eed1",
  "mbid-isrc-lookup": "dv1-051a9c8cfc319304",
  "mbid-isrc-refresh": "dv1-edfb7fba9ed7a7f9",
  "mbid-prefix-strip": "dv1-7583fea53827e302",
  "youtube-provenance-catalogue": "dv1-4de0786c22c69193",
  "youtube-provenance-findings": "dv1-b55f04749775565a",
  "youtube-reverdict-catalogue": "dv1-ff1d25bbfbab92ad",
  "youtube-reverdict-findings": "dv1-c5ab1723e2e2f723",
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

const CAPTURE_PROBE: DueWorkTrackSource = {
  analyzedAt: null,
  analyzedFrom: null,
  artistsJson: '["Probe Artist"]',
  capturePriority: 3,
  captureStatus: "pending",
  certified: false,
  demandScore: 2,
  dismissedAt: null,
  duplicateOfTrackId: null,
  durationMs: 300_000,
  findingAddedAt: null,
  hasEmbedding: false,
  hasIsrc: false,
  isrc: null,
  isrcRecoveryAttemptedAt: null,
  labelSeedState: "enabled",
  logId: null,
  nearestFindingScore: 0.5,
  sourceAudioAttemptedAt: null,
  sourceAudioFailures: 0,
  sourceAudioKey: null,
  sourceVerification: null,
  spotifyAnchorAttemptedAt: null,
  spotifyAnchorAttempts: 0,
  spotifyUri: null,
  title: "Probe Title",
  trackId: "probe-track",
  youtubeProvenanceFailures: 0,
  youtubeVerifiedAt: null,
  youtubeVideoId: null,
  youtubeVideoOfficial: null,
};

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
    const anchored = describeDueWorkTrackDecision(
      "capture",
      { ...CAPTURE_PROBE, spotifyUri: "spotify:track:probe" },
      "2026-01-02T03:04:05.000Z",
    );
    const unanchored = describeDueWorkTrackDecision(
      "capture",
      CAPTURE_PROBE,
      "2026-01-02T03:04:05.000Z",
    );
    expect(anchored).not.toBe(unanchored);
    expect(anchored < unanchored).toBe(true);
  });

  it("moves when a decision moves and holds when nothing does", () => {
    const base = { a: "1", b: "2" };
    const columns = ["a", "b"];
    const original = (row: Record<string, unknown>) => `${String(row["a"])}|${String(row["b"])}`;
    const reordered = (row: Record<string, unknown>) => `${String(row["b"])}|${String(row["a"])}`;
    const transcript = (decide: (row: Record<string, unknown>) => string) =>
      probeMatrix([base], columns).map((row, index) => `${index}:${decide(row)}`);

    expect(definitionFingerprint("probe", transcript(original))).toBe(
      definitionFingerprint("probe", transcript(original)),
    );
    expect(definitionFingerprint("probe", transcript(original))).not.toBe(
      definitionFingerprint("probe", transcript(reordered)),
    );
    expect(PROBE_LADDER.length).toBeGreaterThan(1);
  });
});
