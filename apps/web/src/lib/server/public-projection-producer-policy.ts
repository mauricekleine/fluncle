import { DUE_WORK_PRODUCER_INVENTORY } from "./due-work-producer-inventory";
import {
  type PublicProjectionTarget,
  PUBLIC_PROJECTION_TARGETS,
} from "./public-projection-source-maintenance";

export type PublicProjectionImpact =
  | "artist_qualification"
  | "both"
  | "neither"
  | "public_aggregates";

export type PublicProjectionProducerPolicy =
  | {
      impact: PublicProjectionImpact;
      kind: "static";
      producerId: string;
    }
  | {
      allowedImpacts: readonly PublicProjectionImpact[];
      kind: "dynamic";
      producerId: string;
      rationale: string;
    };

export type PublicProjectionDynamicImpactOverride = {
  impact: PublicProjectionImpact;
  justification: string;
};

const IMPACT_TARGETS: Record<PublicProjectionImpact, readonly PublicProjectionTarget[]> = {
  artist_qualification: ["artist_qualification"],
  both: ["public_aggregates", "artist_qualification"],
  neither: [],
  public_aggregates: ["public_aggregates"],
};
const PUBLIC_PROJECTION_IMPACTS = new Set<string>(Object.keys(IMPACT_TARGETS));
const DYNAMIC_PRODUCER_IMPACTS = {
  "hub-entity-relink": ["neither", "artist_qualification"],
  "label-seed-state": ["neither", "artist_qualification"],
  "track-update": ["neither", "public_aggregates"],
} as const satisfies Record<string, readonly PublicProjectionImpact[]>;

function expectedDynamicImpacts(producerId: string): readonly PublicProjectionImpact[] | undefined {
  return Object.prototype.hasOwnProperty.call(DYNAMIC_PRODUCER_IMPACTS, producerId)
    ? DYNAMIC_PRODUCER_IMPACTS[producerId as keyof typeof DYNAMIC_PRODUCER_IMPACTS]
    : undefined;
}

function staticPolicies(
  impact: PublicProjectionImpact,
  producers: readonly string[],
): PublicProjectionProducerPolicy[] {
  return producers.map((producerId) => ({ impact, kind: "static", producerId }));
}

/**
 * Closed policy over every atomic due-work producer. Static entries describe the authoritative
 * columns that producer writes; the three dynamic entries require their callsite to name the
 * branch it actually took. Nothing falls back to subject-type inference.
 */
export const PUBLIC_PROJECTION_PRODUCER_POLICIES = [
  ...staticPolicies("neither", [
    "album-bio-fill",
    "album-mint",
    "anchor-apify-requeue",
    "anchor-hit",
    "anchor-miss",
    "anchor-requeue",
    "anchor-review-accept",
    "anchor-stamp",
    "artist-bio-fill",
    "artist-credit-stamp",
    "artist-edge-backfill-stamp",
    "artist-edge-rank-restale",
    "artist-image-backfill-fill",
    "artist-image-backfill-none",
    "artist-image-fill",
    "artist-mbid-mint",
    "artist-mint",
    "artist-spotify-adopt",
    "backfill-album-link",
    "backfill-album-mint",
    "backfill-apple-resolve",
    "backfill-attempt",
    "backfill-beatport-resolve",
    "backfill-deezer-failure",
    "backfill-deezer-miss",
    "backfill-deezer-resolve",
    "backfill-discogs-resolve",
    "backfill-has-embedding-rank-corpus",
    "backfill-has-embedding-subjects",
    "backfill-has-isrc",
    "backfill-hub-counts-albums",
    "backfill-hub-counts-artists",
    "backfill-hub-counts-labels",
    "backfill-identity-discogs-attempt",
    "backfill-identity-isrc-attempt",
    "backfill-is-catalogue",
    "backfill-label-mint",
    "bio-review-resolution",
    "capture-verification",
    "capture-verification-quarantine",
    "catalogue-clear-wrong-audio",
    "catalogue-dismiss-track",
    "catalogue-flag-wrong-audio",
    "catalogue-force-capture",
    "catalogue-rank",
    "catalogue-requeue-unmatched",
    "certify-spotify-error",
    "certify-spotify-missing",
    "certify-spotify-success",
    "certify-telegram-error",
    "certify-telegram-success",
    "certify-track-anchor",
    "cover-master-failure",
    "cover-master-none",
    "cover-master-requeue",
    "cover-master-resolved",
    "demand-score-rewrite",
    "hub-counts-reconcile-album-grouped",
    "hub-counts-reconcile-album-zero",
    "hub-counts-reconcile-artist-grouped",
    "hub-counts-reconcile-artist-zero",
    "hub-counts-reconcile-label-grouped",
    "hub-counts-reconcile-label-zero",
    "isrc-recovery-empty",
    "isrc-recovery-hit",
    "isrc-recovery-miss",
    "label-artist-rules-replace",
    "label-bio-fill",
    "label-image-failure",
    "label-image-none",
    "label-image-resolved",
    "label-mint",
    "label-reconcile-mint",
    "publish-spotify-error",
    "publish-spotify-success",
    "publish-telegram-error",
    "publish-telegram-success",
    "recording-isrc-refresh",
    "recording-mbid-missed",
    "recording-mbid-prefix-strip",
    "recording-mbid-resolved",
    "social-finding-touch",
    "track-note-fill",
  ]),
  ...staticPolicies("public_aggregates", ["crawl-track-mint", "label-release-track-mint"]),
  ...staticPolicies("artist_qualification", [
    "artist-credit-edges",
    "artist-edge-backfill",
    "artist-edge-link",
    "artist-edge-upsert",
    "artist-remixer-role-stamp",
    "backfill-artist-links",
    "backfill-label-link",
    "backfill-label-seed",
    "backfill-remixer-role",
    "certify-track",
    "label-merge",
  ]),
  ...staticPolicies("both", ["publish-track"]),
  {
    allowedImpacts: DYNAMIC_PRODUCER_IMPACTS["track-update"],
    kind: "dynamic",
    producerId: "track-update",
    rationale: "Only a supplied tracks.key write changes an aggregate dependency.",
  },
  {
    allowedImpacts: DYNAMIC_PRODUCER_IMPACTS["label-seed-state"],
    kind: "dynamic",
    producerId: "label-seed-state",
    rationale: "Only a supplied labels.seed_state ruling changes artist qualification.",
  },
  {
    allowedImpacts: DYNAMIC_PRODUCER_IMPACTS["hub-entity-relink"],
    kind: "dynamic",
    producerId: "hub-entity-relink",
    rationale: "Only tracks.label_id relinks change artist qualification; album relinks do not.",
  },
] as const satisfies readonly PublicProjectionProducerPolicy[];

type ProducerInventory = readonly { producers: readonly string[] }[];

/** Validate registry closure and return the unique producer lookup. Exported for fail-closed tests. */
export function validatePublicProjectionProducerPolicies(
  inventory: ProducerInventory,
  policies: readonly PublicProjectionProducerPolicy[],
): Map<string, PublicProjectionProducerPolicy> {
  const inventoryProducers = inventory.flatMap((entry) => [...entry.producers]);
  const inventorySet = new Set(inventoryProducers);
  if (inventorySet.size !== inventoryProducers.length) {
    throw new Error("due-work producer inventory contains duplicate producer ids");
  }

  const policyByProducer = new Map<string, PublicProjectionProducerPolicy>();
  for (const policy of policies) {
    if (!policy.producerId.trim()) {
      throw new Error("public projection producer policy id must not be empty");
    }
    if (policyByProducer.has(policy.producerId)) {
      throw new Error(`duplicate public projection producer policy: ${policy.producerId}`);
    }
    if (!inventorySet.has(policy.producerId)) {
      throw new Error(`unknown public projection producer policy: ${policy.producerId}`);
    }
    const dynamicImpacts = expectedDynamicImpacts(policy.producerId);
    if (policy.kind === "static") {
      if (!PUBLIC_PROJECTION_IMPACTS.has(policy.impact)) {
        throw new Error(`unknown public projection impact for ${policy.producerId}`);
      }
      if (dynamicImpacts !== undefined) {
        throw new Error(
          `dynamic public projection producer requires dynamic policy: ${policy.producerId}`,
        );
      }
    }
    if (policy.kind === "dynamic") {
      if (dynamicImpacts === undefined) {
        throw new Error(
          `static public projection producer cannot use dynamic policy: ${policy.producerId}`,
        );
      }
      if (!policy.rationale.trim()) {
        throw new Error(`dynamic public projection policy needs a rationale: ${policy.producerId}`);
      }
      if (policy.allowedImpacts.length === 0) {
        throw new Error(
          `dynamic public projection policy needs allowed impacts: ${policy.producerId}`,
        );
      }
      if (new Set(policy.allowedImpacts).size !== policy.allowedImpacts.length) {
        throw new Error(`dynamic public projection policy repeats an impact: ${policy.producerId}`);
      }
      if (policy.allowedImpacts.some((impact) => !PUBLIC_PROJECTION_IMPACTS.has(impact))) {
        throw new Error(
          `dynamic public projection policy has an unknown impact: ${policy.producerId}`,
        );
      }
      if (
        policy.allowedImpacts.length !== dynamicImpacts.length ||
        dynamicImpacts.some((impact) => !policy.allowedImpacts.includes(impact))
      ) {
        throw new Error(
          `dynamic public projection policy has invalid allowed impacts: ${policy.producerId}`,
        );
      }
    }
    policyByProducer.set(policy.producerId, policy);
  }

  const missing = inventoryProducers.filter((producer) => !policyByProducer.has(producer));
  if (missing.length > 0) {
    throw new Error(`missing public projection producer policies: ${missing.join(", ")}`);
  }
  return policyByProducer;
}

const POLICY_BY_PRODUCER = validatePublicProjectionProducerPolicies(
  DUE_WORK_PRODUCER_INVENTORY,
  PUBLIC_PROJECTION_PRODUCER_POLICIES,
);

/** Resolve one producer to explicit projection targets, rejecting every unregistered shortcut. */
export function resolvePublicProjectionProducerTargets(
  producer: string,
  override?: PublicProjectionDynamicImpactOverride,
): readonly PublicProjectionTarget[] {
  const policy = POLICY_BY_PRODUCER.get(producer);
  if (policy === undefined) {
    throw new Error(`unknown due-work producer: ${producer}`);
  }
  if (policy.kind === "static") {
    if (override !== undefined) {
      throw new Error(`static public projection producer cannot override impact: ${producer}`);
    }
    return IMPACT_TARGETS[policy.impact];
  }
  if (override === undefined) {
    throw new Error(`dynamic public projection producer requires an impact override: ${producer}`);
  }
  if (!override.justification.trim()) {
    throw new Error(`dynamic public projection impact override needs justification: ${producer}`);
  }
  if (!policy.allowedImpacts.includes(override.impact)) {
    throw new Error(
      `dynamic public projection impact ${override.impact} is not allowed for ${producer}`,
    );
  }
  return IMPACT_TARGETS[override.impact].filter((target) =>
    PUBLIC_PROJECTION_TARGETS.includes(target),
  );
}
