import { CONTRACT_D_CONTRACT_IDS } from "./contract-d";

export const DOMINANT_REGRESSION_FAMILY_IDS = [
  "artist-identity-case-or",
  "stale-allowed-artist-rearm",
  "qualified-artist-reconstruction",
  "release-hub-window-and-year-grouping",
  "empty-and-bounded-queue-scans",
  "sonar-remote-full-corpus-refresh",
  "device-production-corpus-derivation",
  "client-background-convoy",
  "ambiguous-mutation-outcomes",
] as const;

export type DominantRegressionFamilyId = (typeof DOMINANT_REGRESSION_FAMILY_IDS)[number];

export type EvidenceLocation = Readonly<{
  file: string;
  marker: string;
}>;

export type CompatibilityEvidence = Readonly<{
  description: string;
  source: EvidenceLocation;
  test: EvidenceLocation;
}>;

export type DominantRegressionFamily = Readonly<{
  compatibility: CompatibilityEvidence;
  finalImplementation: readonly EvidenceLocation[];
  id: DominantRegressionFamilyId;
  originalShapes: readonly string[];
  performanceContractIds: readonly string[];
  runtimeTests: readonly EvidenceLocation[];
}>;

function freezeInventory<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freezeInventory(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Goal H's finite inventory. Source locations are reference evidence; runtimeTests name the
 * integration/component checks that execute the behavior. The inventory checker intentionally
 * verifies both kinds without treating a source-text match as runtime execution.
 */
export const DOMINANT_REGRESSION_INVENTORY = freezeInventory([
  {
    compatibility: {
      description:
        "The due-work read flag remains default-off while the legacy selector is retained.",
      source: {
        file: "apps/web/src/lib/server/due-work-cutover.ts",
        marker: "TRACK_WORK_DUE_CUTOVER_ENABLED_KEY",
      },
      test: {
        file: "apps/web/src/lib/server/due-work-cutover.integration.test.ts",
        marker: "keeps the legacy selector when the flag is unset, malformed, or unreadable",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/src/lib/server/backfill-artist-credits.ts",
        marker: "createCreditResolver",
      },
      {
        file: "apps/web/src/lib/server/backfill-artist-credits.ts",
        marker: "resolveArtistCredits",
      },
    ],
    id: "artist-identity-case-or",
    originalShapes: [
      "Artist identity joined through a CASE/OR branch over MBID and case-folded name.",
      "Claimed-MBID exclusion was mixed into the same cross-table identity predicate.",
    ],
    performanceContractIds: ["artist-link.identity-resolution", "artist-link.name-resolution"],
    runtimeTests: [
      {
        file: "apps/web/src/lib/server/backfill-artist-credits.test.ts",
        marker: "FAILS CLOSED to a MINT on a homonym",
      },
    ],
  },
  {
    compatibility: {
      description:
        "The crawl due-work cutover is default-off; the old source selector remains the rollback path.",
      source: {
        file: "apps/web/src/lib/server/crawl-cutover.ts",
        marker: "CRAWL_DUE_CUTOVER_ENABLED_KEY",
      },
      test: {
        file: "apps/web/src/lib/server/crawl-cutover.integration.test.ts",
        marker: "is default-off, exact-literal-true, and fail-closed on a settings read error",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/src/lib/server/crawl.ts",
        marker: "rearmStaleAllowedArtists",
      },
      {
        file: "apps/web/src/lib/server/crawl-cutover.ts",
        marker: "claimCrawlFrontierRows",
      },
    ],
    id: "stale-allowed-artist-rearm",
    originalShapes: [
      "Stale allowed-artist re-arm selected and rewrote frontier source rows on every crawl pass.",
      "Crawl selection reconstructed its ordered two-lane page from the source frontier.",
    ],
    performanceContractIds: [
      "projection.crawl-two-lane-claim",
      "projection.crawl-two-lane-read",
      "projection.crawl-ready-sentinel",
    ],
    runtimeTests: [
      {
        file: "apps/web/src/lib/server/crawl-cutover.integration.test.ts",
        marker:
          "rearms stale allowed artists from bounded due state even when no nodes are claimed",
      },
      {
        file: "apps/web/src/lib/server/crawl-cutover.integration.test.ts",
        marker: "routes an open crawl pass through claims and never issues the legacy selector",
      },
    ],
  },
  {
    compatibility: {
      description:
        "The public-projection flag is default-off and falls back to the caller's legacy qualified-set SQL.",
      source: {
        file: "apps/web/src/lib/server/public-projection-cutover.ts",
        marker: "PUBLIC_PROJECTION_CUTOVER_ENABLED_KEY",
      },
      test: {
        file: "apps/web/src/lib/server/public-projections.integration.test.ts",
        marker:
          "keeps absent, false, malformed, and unreadable flags closed and opens only literal true",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/src/lib/server/public-projection-cutover.ts",
        marker: "readQualifiedArtistIds",
      },
    ],
    id: "qualified-artist-reconstruction",
    originalShapes: [
      "Each consumer rebuilt the qualified-artist set with repeated UNION/GROUP BY work.",
      "Authorization readers reconstructed weighted qualification instead of reading its maintained set.",
    ],
    performanceContractIds: ["projection.qualified-artists"],
    runtimeTests: [
      {
        file: "apps/web/src/lib/server/public-projections.integration.test.ts",
        marker:
          "rebuilds literal buckets, exact weighted qualification, totals, anchors, and shadow equivalence",
      },
    ],
  },
  {
    compatibility: {
      description:
        "The default-off public projection retains source aggregates and the release-year expression query for filtered or unusable state.",
      source: {
        file: "apps/web/src/lib/server/tracks-hub.ts",
        marker: "tracksHubYearLaneQuery",
      },
      test: {
        file: "apps/web/src/lib/server/public-projections.integration.test.ts",
        marker: "falls back on running, epoch-stale, repair-marked, and malformed-anchor states",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/src/lib/server/tracks-hub.ts",
        marker: "tracksHubAnchorExtractionQuery",
      },
      {
        file: "apps/web/src/lib/server/public-projection-cutover.ts",
        marker: "readProjectedAggregateBuckets",
      },
    ],
    id: "release-hub-window-and-year-grouping",
    originalShapes: [
      "Deep release hub pages derived row_number boundaries from the growing release order at request time.",
      "Release-year lanes grouped substr(release_date, 1, 4) across the archive on hot reads.",
    ],
    performanceContractIds: [
      "projection.public-readiness",
      "projection.public-total",
      "projection.public-release-years",
      "projection.public-keys",
      "projection.default-anchor-validity",
      "projection.default-anchor-keyset",
    ],
    runtimeTests: [
      {
        file: "apps/web/src/lib/server/hub-page-anchors.test.ts",
        marker: "derives the date-desc extraction modulo from the page-size constant",
      },
      {
        file: "apps/web/src/lib/server/public-projections.integration.test.ts",
        marker:
          "reads literal year/key buckets and projection indexes without a source scan or temp sort",
      },
    ],
  },
  {
    compatibility: {
      description:
        "The track-work due cutover remains default-off and keeps legacy selectors available until each consumer is cut over.",
      source: {
        file: "apps/web/src/lib/server/due-work-cutover.ts",
        marker: "isTrackWorkDueCutoverEnabled",
      },
      test: {
        file: "apps/web/src/lib/server/due-work-cutover.integration.test.ts",
        marker: "keeps the legacy selector when the flag is unset, malformed, or unreadable",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/src/lib/server/due-work-cutover.ts",
        marker: "readPromotedDueWorkPage",
      },
      {
        file: "apps/web/src/lib/server/due-work-cutover.ts",
        marker: "readTrackWorkDueIds",
      },
    ],
    id: "empty-and-bounded-queue-scans",
    originalShapes: [
      "Empty queue probes scanned source tables to prove no work existed.",
      "Bounded queue pages and claims selected from growing source tables rather than maintained due work.",
    ],
    performanceContractIds: [
      "fixture.frontier-pending-claim",
      "fixture.due-work-claim",
      "fixture.due-work-ready",
      "fixture.due-work-ready-empty",
    ],
    runtimeTests: [
      {
        file: "apps/web/src/lib/server/due-work-cutover.integration.test.ts",
        marker: "returns the projection's empty page and projected count without falling back",
      },
      {
        file: "apps/web/src/lib/server/due-work-cutover.integration.test.ts",
        marker:
          "reads ready due rows in bounded order, hydrates only their IDs, and keeps the wire exact",
      },
    ],
  },
  {
    compatibility: {
      description:
        "No default-off remote full-corpus fallback remains; a local-replica rebuild is the bounded recovery path.",
      source: {
        file: "apps/sonar/src/consumer.rs",
        marker: "full_local_rebuild",
      },
      test: {
        file: "apps/sonar/src/state.rs",
        marker: "delta_converges_with_full_local_rebuild_at_scaled_corpora",
      },
    },
    finalImplementation: [
      {
        file: "apps/sonar/src/consumer.rs",
        marker: "pub async fn consume_once",
      },
      {
        file: "apps/sonar/src/state.rs",
        marker: "replace_from_local_replica",
      },
    ],
    id: "sonar-remote-full-corpus-refresh",
    originalShapes: [
      "Sonar refreshed by scanning the remote vector corpus instead of applying a bounded local-replica delta.",
    ],
    performanceContractIds: ["sonar-refresh.local-replica-delta"],
    runtimeTests: [
      {
        file: "apps/sonar/src/state.rs",
        marker: "delta_converges_with_full_local_rebuild_at_scaled_corpora",
      },
    ],
  },
  {
    compatibility: {
      description:
        "No default-off production-corpus fallback remains; failed artifact publication leaves the prior validated device database in place.",
      source: {
        file: "apps/web/scripts/derive-device-db.ts",
        marker: "publishDeviceArtifactAtomically",
      },
      test: {
        file: "apps/web/scripts/lib/device-db-derivation.test.ts",
        marker:
          "materializes the growing anchored scan once and makes every copy read that relation",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/scripts/derive-device-db.ts",
        marker: "deriveDeviceDatabase",
      },
      {
        file: "apps/web/scripts/lib/device-db-derivation.ts",
        marker: "materializeSelectedTrackIdsSql",
      },
    ],
    id: "device-production-corpus-derivation",
    originalShapes: [
      "Every device-table copy independently derived the production eligibility corpus.",
      "Device publication could expose an incomplete derived corpus between replacement steps.",
    ],
    performanceContractIds: ["device-derivation.atomic-generation"],
    runtimeTests: [
      {
        file: "apps/web/scripts/lib/device-db-derivation.test.ts",
        marker:
          "materializes the growing anchored scan once and makes every copy read that relation",
      },
    ],
  },
  {
    compatibility: {
      description:
        "Database admission is default-off and shadow observation preserves the existing timer compatibility path until enforcement is armed.",
      source: {
        file: "apps/web/src/lib/server/database-admission.ts",
        marker: "isDatabaseAdmissionEnforcedFor",
      },
      test: {
        file: "apps/web/src/lib/server/database-admission-shadow.integration.test.ts",
        marker: "classifies simultaneous writers without changing their compatibility path",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/src/lib/server/database-admission.ts",
        marker: "coordinateDatabaseAdmissionFor",
      },
    ],
    id: "client-background-convoy",
    originalShapes: [
      "An unbounded/default primary client let heavy background work convoy public reads.",
      "Independent background writers could form an unbounded contention convoy.",
    ],
    performanceContractIds: ["client.mixed-load", "client.mixed-load-e2e", "admission.fenced-fifo"],
    runtimeTests: [
      {
        file: "apps/web/src/lib/server/database-admission.integration.test.ts",
        marker: "preserves FIFO order so repeated newcomers cannot starve the oldest contender",
      },
      {
        file: "apps/web/scripts/db-performance/mixed-load.test.ts",
        marker: "keeps public reads moving beside a held reader and serializes write batches",
      },
    ],
  },
  {
    compatibility: {
      description:
        "The health snapshot receipt cutover is default-off; disabled callers retain the legacy keyless write until contraction.",
      source: {
        file: "apps/web/src/lib/server/health-receipt-cutover.ts",
        marker: "HEALTH_SNAPSHOT_RECEIPTS_ENABLED_KEY",
      },
      test: {
        file: "apps/web/src/lib/server/health-receipt-cutover.integration.test.ts",
        marker: "stays default-off for missing and malformed values",
      },
    },
    finalImplementation: [
      {
        file: "apps/web/src/lib/server/operation-receipts.ts",
        marker: "executeReceiptBackedOperation",
      },
      {
        file: "apps/web/src/lib/server/operation-receipts.ts",
        marker: "reconcileOperationReceipt",
      },
    ],
    id: "ambiguous-mutation-outcomes",
    originalShapes: [
      "A timeout or response loss left mutation outcome ambiguous and allowed blind replay.",
    ],
    performanceContractIds: ["mutation.receipt-ambiguity"],
    runtimeTests: [
      {
        file: "apps/web/src/lib/server/operation-receipts.integration.test.ts",
        marker: "recovers the committed result when commit succeeds before response loss",
      },
      {
        file: "apps/web/src/lib/server/operation-receipts.integration.test.ts",
        marker: "is safely retryable when transport fails before the primary transaction",
      },
    ],
  },
] as const satisfies readonly DominantRegressionFamily[]);

export type DominantRegressionInventory = typeof DOMINANT_REGRESSION_INVENTORY;

export function validateDominantRegressionInventory(
  inventory: readonly DominantRegressionFamily[],
  knownPerformanceContractIds: ReadonlySet<string>,
): string[] {
  const failures: string[] = [];
  const ids = inventory.map((family) => family.id);

  if (
    ids.length !== DOMINANT_REGRESSION_FAMILY_IDS.length ||
    ids.some((id, index) => id !== DOMINANT_REGRESSION_FAMILY_IDS[index])
  ) {
    failures.push("inventory must contain exactly the nine canonical stable family IDs in order");
  }

  const contractDCounts = new Map<string, number>();
  for (const family of inventory) {
    if (family.originalShapes.length === 0) {
      failures.push(`${family.id}: originalShapes must not be empty`);
    }
    if (
      family.finalImplementation.length === 0 ||
      family.runtimeTests.length === 0 ||
      family.performanceContractIds.length === 0
    ) {
      failures.push(
        `${family.id}: final implementation, runtime test evidence, and performance contracts must not be empty`,
      );
    }
    if (
      family.compatibility.description.length === 0 ||
      family.compatibility.source.file.length === 0 ||
      family.compatibility.source.marker.length === 0 ||
      family.compatibility.test.file.length === 0 ||
      family.compatibility.test.marker.length === 0
    ) {
      failures.push(`${family.id}: compatibility evidence must not be empty`);
    }
    for (const evidence of [...family.finalImplementation, ...family.runtimeTests]) {
      if (evidence.file.length === 0 || evidence.marker.length === 0) {
        failures.push(`${family.id}: final evidence file and marker must not be empty`);
      }
    }
    for (const contractId of family.performanceContractIds) {
      if (!knownPerformanceContractIds.has(contractId)) {
        failures.push(`${family.id}: unknown performance contract ${contractId}`);
      }
      if (
        CONTRACT_D_CONTRACT_IDS.includes(contractId as (typeof CONTRACT_D_CONTRACT_IDS)[number])
      ) {
        contractDCounts.set(contractId, (contractDCounts.get(contractId) ?? 0) + 1);
      }
    }
  }

  for (const contractId of CONTRACT_D_CONTRACT_IDS) {
    const count = contractDCounts.get(contractId) ?? 0;
    if (count !== 1) {
      failures.push(`Contract D ID ${contractId} must be mapped exactly once; found ${count}`);
    }
  }

  return failures;
}
