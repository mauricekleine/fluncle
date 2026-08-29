import { type DueWorkSubjectType } from "./due-work";

export type DueWorkProducerInventoryEntry = {
  file: `${string}.ts`;
  producers: readonly string[];
  subjects: readonly DueWorkSubjectType[];
};

type DueWorkReviewedMutationSiteBase = {
  file: `${string}.ts`;
  rationale: string;
  sites: readonly string[];
};

export type DueWorkReviewedWriterEntry = DueWorkReviewedMutationSiteBase &
  (
    | { delegates: readonly string[]; disposition: "delegated-atomicity" }
    | {
        disposition: "ephemeral-staging" | "non-eligibility" | "serialization" | "test-fixture";
      }
  );

export type GoalDReviewedWriterEntry = DueWorkReviewedMutationSiteBase & {
  disposition:
    | "delegated-atomicity"
    | "derived-projection-write"
    | "ephemeral-staging"
    | "non-projection-fact"
    | "serialization"
    | "test-fixture";
};

/**
 * Every production writer that transactionally couples an eligibility source mutation to the
 * subject-level due-work repair marker. The static completeness test enumerates the real helper
 * callsites and requires an exact match with this list.
 */
export const DUE_WORK_PRODUCER_INVENTORY = [
  {
    file: "scripts/backfill-album-graph.ts",
    producers: ["backfill-album-link", "backfill-album-mint"],
    subjects: ["album", "track"],
  },
  {
    file: "scripts/backfill-artist-links.ts",
    producers: ["backfill-artist-links"],
    subjects: ["track"],
  },
  {
    file: "scripts/backfill-has-embedding.ts",
    producers: ["backfill-has-embedding-rank-corpus", "backfill-has-embedding-subjects"],
    subjects: ["track"],
  },
  {
    file: "scripts/backfill-has-isrc.ts",
    producers: ["backfill-has-isrc"],
    subjects: ["track"],
  },
  {
    file: "scripts/backfill-hub-counts.ts",
    producers: [
      "backfill-hub-counts-albums",
      "backfill-hub-counts-artists",
      "backfill-hub-counts-labels",
    ],
    subjects: ["album", "artist", "label"],
  },
  {
    file: "scripts/backfill-identity-ledger.ts",
    producers: ["backfill-identity-discogs-attempt", "backfill-identity-isrc-attempt"],
    subjects: ["track"],
  },
  {
    file: "scripts/backfill-is-catalogue.ts",
    producers: ["backfill-is-catalogue"],
    subjects: ["track"],
  },
  {
    file: "scripts/backfill-labels.ts",
    producers: ["backfill-label-link", "backfill-label-mint", "backfill-label-seed"],
    subjects: ["label", "track"],
  },
  {
    file: "scripts/backfill-remixer-roles.ts",
    producers: ["backfill-remixer-role"],
    subjects: ["track"],
  },
  {
    file: "albums.ts",
    producers: ["album-bio-fill", "album-mint"],
    subjects: ["album"],
  },
  {
    file: "anchor-apify.ts",
    producers: ["anchor-apify-requeue"],
    subjects: ["track"],
  },
  {
    file: "anchor.ts",
    producers: [
      "anchor-hit",
      "anchor-miss",
      "anchor-requeue",
      "anchor-review-accept",
      "anchor-stamp",
      "isrc-recovery-empty",
      "isrc-recovery-hit",
      "isrc-recovery-miss",
    ],
    subjects: ["track"],
  },
  {
    file: "artist-rules.ts",
    producers: ["label-artist-rules-replace"],
    subjects: ["label"],
  },
  {
    file: "artists.ts",
    producers: [
      "artist-bio-fill",
      "artist-edge-link",
      "artist-edge-rank-restale",
      "artist-edge-upsert",
      "artist-image-fill",
      "artist-mbid-mint",
      "artist-mint",
      "artist-remixer-role-stamp",
      "artist-spotify-adopt",
    ],
    subjects: ["artist", "track"],
  },
  {
    file: "backfill-artist-credits.ts",
    producers: ["artist-credit-edges", "artist-credit-stamp"],
    subjects: ["artist", "track"],
  },
  {
    file: "backfill-artist-edges.ts",
    producers: ["artist-edge-backfill", "artist-edge-backfill-stamp"],
    subjects: ["artist", "track"],
  },
  {
    file: "backfill-artist-images.ts",
    producers: ["artist-image-backfill-fill", "artist-image-backfill-none"],
    subjects: ["artist"],
  },
  {
    file: "backfill.ts",
    producers: [
      "backfill-apple-resolve",
      "backfill-attempt",
      "backfill-beatport-resolve",
      "backfill-deezer-failure",
      "backfill-deezer-miss",
      "backfill-deezer-resolve",
      "backfill-discogs-resolve",
    ],
    subjects: ["track"],
  },
  {
    file: "bio-review.ts",
    producers: ["bio-review-resolution"],
    subjects: ["album", "artist", "label"],
  },
  {
    file: "catalogue.ts",
    producers: [
      "capture-verification",
      "capture-verification-quarantine",
      "catalogue-clear-wrong-audio",
      "catalogue-dismiss-track",
      "catalogue-flag-wrong-audio",
      "catalogue-force-capture",
      "catalogue-rank",
      "catalogue-requeue-unmatched",
    ],
    subjects: ["track"],
  },
  {
    file: "cover-masters.ts",
    producers: [
      "cover-master-failure",
      "cover-master-none",
      "cover-master-requeue",
      "cover-master-resolved",
    ],
    subjects: ["album", "artist"],
  },
  { file: "crawl.ts", producers: ["crawl-track-mint"], subjects: ["track"] },
  { file: "demand.ts", producers: ["demand-score-rewrite"], subjects: ["track"] },
  {
    file: "hub-counts.ts",
    producers: ["hub-entity-relink"],
    subjects: ["album", "label", "track"],
  },
  {
    file: "hub-counts-reconcile.ts",
    producers: [
      "hub-counts-reconcile-album-grouped",
      "hub-counts-reconcile-album-zero",
      "hub-counts-reconcile-artist-grouped",
      "hub-counts-reconcile-artist-zero",
      "hub-counts-reconcile-label-grouped",
      "hub-counts-reconcile-label-zero",
    ],
    subjects: ["album", "artist", "label"],
  },
  {
    file: "label-images.ts",
    producers: ["label-image-failure", "label-image-none", "label-image-resolved"],
    subjects: ["label"],
  },
  {
    file: "label-releases.ts",
    producers: ["label-release-track-mint"],
    subjects: ["track"],
  },
  {
    file: "labels.ts",
    producers: [
      "label-bio-fill",
      "label-merge",
      "label-mint",
      "label-reconcile-mint",
      "label-seed-state",
    ],
    subjects: ["label", "track"],
  },
  {
    file: "publish.ts",
    producers: [
      "certify-spotify-error",
      "certify-spotify-missing",
      "certify-spotify-success",
      "certify-telegram-error",
      "certify-telegram-success",
      "certify-track",
      "certify-track-anchor",
      "publish-spotify-error",
      "publish-spotify-success",
      "publish-telegram-error",
      "publish-telegram-success",
      "publish-track",
    ],
    subjects: ["track"],
  },
  {
    file: "recording-mbids.ts",
    producers: [
      "recording-isrc-refresh",
      "recording-mbid-missed",
      "recording-mbid-prefix-strip",
      "recording-mbid-resolved",
    ],
    subjects: ["track"],
  },
  { file: "social.ts", producers: ["social-finding-touch"], subjects: ["track"] },
  {
    file: "track-update.ts",
    producers: ["track-note-fill", "track-update"],
    subjects: ["track"],
  },
] as const satisfies readonly DueWorkProducerInventoryEntry[];

/**
 * Exact source mutation sites that are either statement builders whose every callsite is checked
 * for transactional coupling, or writes that cannot change a due-work evaluator input. Site ids
 * include the normalized SQL fingerprint, so another mutation in the same file fails closed.
 */
export const DUE_WORK_REVIEWED_NONPRODUCER_WRITERS = [
  {
    disposition: "non-eligibility",
    file: "albums.ts",
    rationale:
      "Writes release-group identity and Discogs facts outside album bio and cover predicates.",
    sites: [
      "albums.ts:update:albums:48798e31",
      "albums.ts:update:albums:bf0c6c3b",
      "albums.ts:update:albums:d75b7caf",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "anchor.ts",
    rationale: "Writes operator anchor-review evidence outside every track due-work source field.",
    sites: ["anchor.ts:update:tracks:b6e72ebf", "anchor.ts:update:tracks:106f7943"],
  },
  {
    disposition: "non-eligibility",
    file: "artist-dossier.ts",
    rationale:
      "Refreshes search centroids; no recurring due-work evaluator reads artist_centroids.",
    sites: [
      "artist-dossier.ts:delete:artist_centroids:cafcc203",
      "artist-dossier.ts:insert:artist_centroids:3fa48d30",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "artist-resolution.ts",
    rationale:
      "Writes identity, aliases, and socials outside the artist bio/image and track source projections.",
    sites: [
      "artist-resolution.ts:update:artists:1c30b097",
      "artist-resolution.ts:insert:artist_socials:0f064bb3",
      "artist-resolution.ts:insert:artist_socials:f60a483a",
      "artist-resolution.ts:insert:artist_aliases:cfe94f01",
    ],
  },
  {
    delegates: ["buildArtistLinkStatement"],
    disposition: "delegated-atomicity",
    file: "artists.ts",
    rationale:
      "The edge statement builder is executed only by the inventoried explicit write transaction.",
    sites: ["artists.ts:insert:track_artists:6430174d"],
  },
  {
    disposition: "non-eligibility",
    file: "artists.ts",
    rationale:
      "Writes artist names, MB identity, and social trust outside due-work evaluator inputs.",
    sites: [
      "artists.ts:update:artists:8908f34c",
      "artists.ts:update:artists:ccc6822f",
      "artists.ts:update:artist_socials:818be6b6",
      "artists.ts:insert:artist_socials:1fddf2a2",
      "artists.ts:update:artist_socials:3f03699a",
      "artists.ts:update:artist_socials:4d04fd25",
      "artists.ts:update:artist_socials:c6ad2259",
      "artists.ts:update:artist_socials:8b6abb43",
      "artists.ts:delete:artist_socials:16c8ee98",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "backfill.ts",
    rationale: "Stores Apple album display facts outside album cover-master and bio predicates.",
    sites: ["backfill.ts:update:albums:1d0eb024"],
  },
  {
    delegates: ["restaleCatalogueRankByLabelStatement", "restaleCatalogueRankStatements"],
    disposition: "delegated-atomicity",
    file: "catalogue-rank-restale.ts",
    rationale:
      "Every rank-restale statement builder call is checked inside its producer's write batch.",
    sites: [
      "catalogue-rank-restale.ts:update:tracks:7b4809bb",
      "catalogue-rank-restale.ts:update:tracks:5f8866fc",
    ],
  },
  {
    disposition: "serialization",
    file: "db-dump.ts",
    rationale: "Renders inert SQL dump text and never executes a database mutation.",
    sites: ["db-dump.ts:insert:dynamic:3511a2ab"],
  },
  {
    disposition: "non-eligibility",
    file: "embedding.ts",
    rationale:
      "The satellite mirrors tracks.has_embedding; due-work reads the atomically maintained mirror.",
    sites: [
      "embedding.ts:delete:track_embeddings:34cdaea5",
      "embedding.ts:insert:track_embeddings:543d6b2d",
    ],
  },
  {
    delegates: ["correctionStatement", "zeroStatement"],
    disposition: "delegated-atomicity",
    file: "hub-counts-reconcile.ts",
    rationale:
      "Each generated count correction executes beside its selection marker in one write batch.",
    sites: [
      "hub-counts-reconcile.ts:update:dynamic:239a77b2",
      "hub-counts-reconcile.ts:update:dynamic:b3c3aab2",
    ],
  },
  {
    delegates: [
      "hubCountArtistDeltaStatement",
      "hubCountArtistEdgeStatements",
      "hubCountDeltaForTrackArtistsStatement",
      "hubCountDeltaStatement",
      "hubCountMoveStatements",
      "rankableArtistDeltaForTrackStatement",
    ],
    disposition: "delegated-atomicity",
    file: "hub-counts.ts",
    rationale:
      "Every entity-count delta builder call is checked inside its producer's write batch.",
    sites: [
      "hub-counts.ts:update:dynamic:4b68e04a",
      "hub-counts.ts:update:artists:d23372bf",
      "hub-counts.ts:update:artists:b06285c6",
      "hub-counts.ts:update:artists:f35e8253",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "hub-counts.ts",
    rationale:
      "Recomputes the maintained artist mixability counter after a guarded embedding clear; no due-work evaluator reads that derived counter.",
    sites: ["hub-counts.ts:update:artists:f6f4cece"],
  },
  {
    disposition: "test-fixture",
    file: "integration-db.ts",
    rationale: "Seeds isolated integration databases and is not a production mutation surface.",
    sites: [
      "integration-db.ts:insert:findings:645c7078",
      "integration-db.ts:update:tracks:2687eeb5",
      "integration-db.ts:insert:tracks:0192c825",
      "integration-db.ts:update:tracks:e05d9ca6",
      "integration-db.ts:update:tracks:e05d9ca6:2",
      "integration-db.ts:insert:artists:8c220465",
      "integration-db.ts:insert:labels:a39abea2",
      "integration-db.ts:insert:albums:cb1fa531",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "label-images.ts",
    rationale:
      "Stores external label identity outside label image eligibility and source-version fields.",
    sites: ["label-images.ts:update:labels:eea3eaf3", "label-images.ts:update:labels:27d7ff1d"],
  },
  {
    disposition: "non-eligibility",
    file: "label-lineage.ts",
    rationale: "Writes label lineage metadata outside bio and artwork eligibility predicates.",
    sites: [
      "label-lineage.ts:update:labels:c627ba9a",
      "label-lineage.ts:update:labels:8b333375",
      "label-lineage.ts:update:labels:b2861415",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "label-releases.ts",
    rationale: "Writes the label crawl cadence, which no due-work projection evaluates.",
    sites: ["label-releases.ts:update:labels:32c5071e", "label-releases.ts:update:labels:0e8fa4e4"],
  },
  {
    disposition: "non-eligibility",
    file: "labels.ts",
    rationale:
      "Writes label MB identity and alias review state outside label bio/image predicates.",
    sites: [
      "labels.ts:update:labels:7120eabc",
      "labels.ts:update:label_aliases:22525227",
      "labels.ts:delete:label_aliases:a75be81b",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "public-projections.ts",
    rationale:
      "Updates the selected shadow rebuild checkpoint table and never mutates an authoritative due-work source.",
    sites: [
      "public-projections.ts:update:dynamic:b32e954f",
      "public-projections.ts:update:dynamic:87624bb3",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "preview-archive.ts",
    rationale: "Writes private preview archive metadata outside recurring queue predicates.",
    sites: ["preview-archive.ts:update:tracks:d06cafad"],
  },
  {
    disposition: "non-eligibility",
    file: "preview-bucket-migration.ts",
    rationale: "Rekeys private preview archive metadata without changing queue eligibility.",
    sites: ["preview-bucket-migration.ts:update:tracks:846f3e45"],
  },
  {
    delegates: ["findingInsertStatement"],
    disposition: "delegated-atomicity",
    file: "publish.ts",
    rationale:
      "Every finding certification insert is called inside an inventoried source-mutation helper.",
    sites: ["publish.ts:insert:findings:4869a78b"],
  },
  {
    disposition: "non-eligibility",
    file: "track-duplicate-keys.ts",
    rationale:
      "The identity satellite is not read by due-work; evaluators read its tracks-column sources.",
    sites: [
      "track-duplicate-keys.ts:insert:track_duplicate_keys:c4b17979",
      "track-duplicate-keys.ts:insert:track_duplicate_keys:69bf6808",
      "track-duplicate-keys.ts:update:track_duplicate_keys:14e083b9",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-anchor-reviews.ts",
    rationale: "Writes operator review evidence that no due-work evaluator consumes.",
    sites: ["scripts/backfill-anchor-reviews.ts:update:tracks:6e9eee3b"],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-artist-social-reviews.ts",
    rationale: "Backfills social review state, which no due-work evaluator reads.",
    sites: ["scripts/backfill-artist-social-reviews.ts:update:artist_socials:ae859736"],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-artist-socials-from-mb-dump.ts",
    rationale: "Backfills artist socials, which are not due-work source fields.",
    sites: ["scripts/backfill-artist-socials-from-mb-dump.ts:insert:artist_socials:5a47a0b6"],
  },
  {
    delegates: ["applyHubCountsStatement"],
    disposition: "delegated-atomicity",
    file: "scripts/backfill-hub-counts.ts",
    rationale:
      "Each generated count backfill executes beside its entity marker in one write batch.",
    sites: [
      "scripts/backfill-hub-counts.ts:update:labels:4610a46b",
      "scripts/backfill-hub-counts.ts:update:albums:f66095f3",
      "scripts/backfill-hub-counts.ts:update:artists:213bb591",
    ],
  },
  {
    disposition: "ephemeral-staging",
    file: "scripts/backfill-hub-counts.ts",
    rationale: "Writes only invocation-scoped staging relations, never eligibility source truth.",
    sites: [
      "scripts/backfill-hub-counts.ts:insert:dynamic:9ae9c583",
      "scripts/backfill-hub-counts.ts:insert:dynamic:c0d12468",
      "scripts/backfill-hub-counts.ts:insert:dynamic:1305bca4",
    ],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-mixable-artists-projection.ts",
    rationale:
      "Reconciles the maintained artist-grain mix counter after deploy; no due-work evaluator reads it.",
    sites: ["scripts/backfill-mixable-artists-projection.ts:update:artists:b379bc6e"],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-identity-ledger.ts",
    rationale: "Backfills anchor provenance fields outside due-work evaluator inputs.",
    sites: ["scripts/backfill-identity-ledger.ts:update:tracks:bcc7b764"],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-label-aliases.ts",
    rationale: "Backfills candidate label aliases outside label bio/image predicates.",
    sites: ["scripts/backfill-label-aliases.ts:insert:label_aliases:90829f41"],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-label-mbid.ts",
    rationale: "Writes label MusicBrainz identity outside label bio and artwork predicates.",
    sites: ["scripts/backfill-label-mbid.ts:update:labels:7120eabc"],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/backfill-track-embeddings.ts",
    rationale:
      "Copies the historical vector satellite without changing the tracks.has_embedding source mirror.",
    sites: ["scripts/backfill-track-embeddings.ts:insert:track_embeddings:909c0ff8"],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-artist-rank.ts",
    rationale: "Seeds an isolated benchmark database and is not a production mutation surface.",
    sites: [
      "scripts/bench-artist-rank.ts:insert:artists:ba5328f9",
      "scripts/bench-artist-rank.ts:insert:tracks:2ddb456f",
      "scripts/bench-artist-rank.ts:insert:track_embeddings:0d46046d",
      "scripts/bench-artist-rank.ts:insert:track_artists:afc239c0",
      "scripts/bench-artist-rank.ts:insert:findings:ccca5fec",
      "scripts/bench-artist-rank.ts:insert:artist_centroids:3fa48d30",
    ],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-db-scale.ts",
    rationale: "Seeds an isolated benchmark database and is not a production mutation surface.",
    sites: ["scripts/bench-db-scale.ts:update:tracks:fe3c1e0d"],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-frontier-novelty.ts",
    rationale: "Seeds an isolated benchmark database and is not a production mutation surface.",
    sites: [
      "scripts/bench-frontier-novelty.ts:insert:tracks:e7e471d8",
      "scripts/bench-frontier-novelty.ts:insert:track_embeddings:82abc46b",
      "scripts/bench-frontier-novelty.ts:insert:tracks:e7e471d8:2",
      "scripts/bench-frontier-novelty.ts:insert:track_embeddings:82abc46b:2",
      "scripts/bench-frontier-novelty.ts:insert:findings:354cf5e9",
    ],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-tracks-hub.ts",
    rationale: "Seeds an isolated benchmark database and is not a production mutation surface.",
    sites: [
      "scripts/bench-tracks-hub.ts:insert:tracks:bc3f8c63",
      "scripts/bench-tracks-hub.ts:insert:tracks:bc3f8c63:2",
      "scripts/bench-tracks-hub.ts:insert:findings:354cf5e9",
      "scripts/bench-tracks-hub.ts:insert:labels:766cb9f0",
      "scripts/bench-tracks-hub.ts:insert:albums:7576ce11",
      "scripts/bench-tracks-hub.ts:insert:artists:20a31d2b",
    ],
  },
  {
    disposition: "serialization",
    file: "scripts/derive-device-db.ts",
    rationale: "Serializes rows into a derived device database and never mutates application data.",
    sites: ["scripts/derive-device-db.ts:insert:dynamic:eb0180a3"],
  },
  {
    disposition: "serialization",
    file: "scripts/lib/device-db-derivation.ts",
    rationale:
      "Builds insert statements for an isolated device database, not the application database.",
    sites: ["scripts/lib/device-db-derivation.ts:insert:dynamic:0540082e"],
  },
  {
    disposition: "test-fixture",
    file: "scripts/lib/scale-seed.ts",
    rationale: "Seeds deterministic local performance fixtures and never targets application data.",
    sites: [
      "scripts/lib/scale-seed.ts:insert:tracks:8bb8038d",
      "scripts/lib/scale-seed.ts:insert:track_embeddings:82abc46b",
      "scripts/lib/scale-seed.ts:insert:findings:354cf5e9",
      "scripts/lib/scale-seed.ts:insert:labels:fd1c42fd",
      "scripts/lib/scale-seed.ts:insert:albums:2effd7a4",
      "scripts/lib/scale-seed.ts:insert:artists:3f37a759",
      "scripts/lib/scale-seed.ts:insert:track_artists:32e13993",
      "scripts/lib/scale-seed.ts:insert:track_artists:32e13993:2",
      "scripts/lib/scale-seed.ts:insert:artist_socials:a9c818ef",
      "scripts/lib/scale-seed.ts:update:labels:290f2b0e",
      "scripts/lib/scale-seed.ts:update:albums:5fb43e5d",
      "scripts/lib/scale-seed.ts:update:artists:b6f87ba2",
    ],
  },
  {
    disposition: "test-fixture",
    file: "scripts/probe-artist-socials-liveness.ts",
    rationale: "Deletes the probe's own synthetic social row during liveness cleanup.",
    sites: ["scripts/probe-artist-socials-liveness.ts:delete:artist_socials:16c8ee98"],
  },
  {
    disposition: "non-eligibility",
    file: "scripts/requeue-empty-artists.ts",
    rationale:
      "Clears artist social-resolution state outside recurring bio and artwork predicates.",
    sites: ["scripts/requeue-empty-artists.ts:update:artists:4ade5c1e"],
  },
] as const satisfies readonly DueWorkReviewedWriterEntry[];

/** Exact dispositions for Goal D source-table SQL that does not owe a new shadow repair marker. */
export const GOAL_D_REVIEWED_NONPROJECTION_WRITERS = [
  {
    disposition: "delegated-atomicity",
    file: "publish.ts",
    rationale:
      "The finding insert builder is called only inside the inventoried source mutation chokepoint.",
    sites: ["publish.ts:insert:findings:4869a78b"],
  },
  {
    disposition: "derived-projection-write",
    file: "public-projections.ts",
    rationale: "Writes a projection checkpoint table selected dynamically, never source truth.",
    sites: [
      "public-projections.ts:update:dynamic:b32e954f",
      "public-projections.ts:update:dynamic:87624bb3",
    ],
  },
  {
    disposition: "non-projection-fact",
    file: "artist-rules.ts",
    rationale: "Updates only MusicBrainz drift-audit fields, not verdict, scope, or re-arm state.",
    sites: ["artist-rules.ts:update:artist_rules:2093c18a"],
  },
  {
    disposition: "serialization",
    file: "db-dump.ts",
    rationale: "Generates restore SQL and does not execute an application source mutation.",
    sites: ["db-dump.ts:insert:dynamic:3511a2ab"],
  },
  {
    disposition: "derived-projection-write",
    file: "hub-counts.ts",
    rationale: "Updates maintained entity and mixability counters, not Goal D source facts.",
    sites: ["hub-counts.ts:update:dynamic:4b68e04a"],
  },
  {
    disposition: "test-fixture",
    file: "integration-db.ts",
    rationale: "Seeds and mutates isolated integration-test databases only.",
    sites: [
      "integration-db.ts:insert:findings:645c7078",
      "integration-db.ts:update:tracks:2687eeb5",
      "integration-db.ts:insert:tracks:0192c825",
      "integration-db.ts:update:tracks:e05d9ca6",
      "integration-db.ts:update:tracks:e05d9ca6:2",
      "integration-db.ts:insert:labels:a39abea2",
    ],
  },
  {
    disposition: "non-projection-fact",
    file: "catalogue-rank-restale.ts",
    rationale: "Changes only The Ear staleness state, outside both Goal D projections.",
    sites: [
      "catalogue-rank-restale.ts:update:tracks:7b4809bb",
      "catalogue-rank-restale.ts:update:tracks:5f8866fc",
    ],
  },
  {
    disposition: "non-projection-fact",
    file: "label-lineage.ts",
    rationale: "Changes label lineage display facts, not seed state or crawl scope.",
    sites: [
      "label-lineage.ts:update:labels:c627ba9a",
      "label-lineage.ts:update:labels:8b333375",
      "label-lineage.ts:update:labels:b2861415",
    ],
  },
  {
    disposition: "derived-projection-write",
    file: "crawl-due-work.ts",
    rationale:
      "The bounded due-time promotion updates frontier and its crawl projection in one write batch.",
    sites: ["crawl-due-work.ts:update:crawl_frontier:a5c0d85c"],
  },
  {
    disposition: "delegated-atomicity",
    file: "artists.ts",
    rationale:
      "The edge statement builder is called only by the inventoried explicit write transaction.",
    sites: ["artists.ts:insert:track_artists:6430174d"],
  },
  {
    disposition: "derived-projection-write",
    file: "hub-counts-reconcile.ts",
    rationale: "Reconciles maintained hub counters on dynamic entity tables only.",
    sites: [
      "hub-counts-reconcile.ts:update:dynamic:239a77b2",
      "hub-counts-reconcile.ts:update:dynamic:b3c3aab2",
    ],
  },
  {
    disposition: "non-projection-fact",
    file: "label-images.ts",
    rationale: "Changes label artwork resolution fields, not seed state or crawl scope.",
    sites: ["label-images.ts:update:labels:eea3eaf3", "label-images.ts:update:labels:27d7ff1d"],
  },
  {
    disposition: "non-projection-fact",
    file: "preview-archive.ts",
    rationale: "Changes preview archive storage metadata only.",
    sites: ["preview-archive.ts:update:tracks:d06cafad"],
  },
  {
    disposition: "non-projection-fact",
    file: "anchor.ts",
    rationale: "Changes anchor-review bookkeeping only; accepted anchor writes use the chokepoint.",
    sites: ["anchor.ts:update:tracks:b6e72ebf", "anchor.ts:update:tracks:106f7943"],
  },
  {
    disposition: "non-projection-fact",
    file: "label-releases.ts",
    rationale: "Changes label release-sync bookkeeping, not seed state or crawl scope.",
    sites: ["label-releases.ts:update:labels:32c5071e", "label-releases.ts:update:labels:0e8fa4e4"],
  },
  {
    disposition: "non-projection-fact",
    file: "preview-bucket-migration.ts",
    rationale: "Changes preview bucket storage metadata only.",
    sites: ["preview-bucket-migration.ts:update:tracks:846f3e45"],
  },
  {
    disposition: "non-projection-fact",
    file: "labels.ts",
    rationale: "Adopts label MusicBrainz identity without changing seed state or crawl scope.",
    sites: ["labels.ts:update:labels:7120eabc"],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-artist-rank.ts",
    rationale: "Seeds an isolated benchmark database only.",
    sites: [
      "scripts/bench-artist-rank.ts:insert:tracks:2ddb456f",
      "scripts/bench-artist-rank.ts:insert:track_artists:afc239c0",
      "scripts/bench-artist-rank.ts:insert:findings:ccca5fec",
    ],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-db-scale.ts",
    rationale: "Seeds an isolated benchmark database only.",
    sites: ["scripts/bench-db-scale.ts:update:tracks:fe3c1e0d"],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-tracks-hub.ts",
    rationale: "Seeds an isolated benchmark database only.",
    sites: [
      "scripts/bench-tracks-hub.ts:insert:tracks:bc3f8c63",
      "scripts/bench-tracks-hub.ts:insert:tracks:bc3f8c63:2",
      "scripts/bench-tracks-hub.ts:insert:findings:354cf5e9",
      "scripts/bench-tracks-hub.ts:insert:labels:766cb9f0",
    ],
  },
  {
    disposition: "non-projection-fact",
    file: "scripts/backfill-anchor-reviews.ts",
    rationale: "Backfills anchor-review bookkeeping only.",
    sites: ["scripts/backfill-anchor-reviews.ts:update:tracks:6e9eee3b"],
  },
  {
    disposition: "serialization",
    file: "scripts/derive-device-db.ts",
    rationale: "Writes an isolated derived device database, not application source truth.",
    sites: ["scripts/derive-device-db.ts:insert:dynamic:eb0180a3"],
  },
  {
    disposition: "non-projection-fact",
    file: "scripts/backfill-label-mbid.ts",
    rationale: "Backfills label MusicBrainz identity without changing seed state or crawl scope.",
    sites: ["scripts/backfill-label-mbid.ts:update:labels:7120eabc"],
  },
  {
    disposition: "derived-projection-write",
    file: "scripts/backfill-hub-counts.ts",
    rationale: "Backfills maintained label hub counters only.",
    sites: ["scripts/backfill-hub-counts.ts:update:labels:4610a46b"],
  },
  {
    disposition: "ephemeral-staging",
    file: "scripts/backfill-hub-counts.ts",
    rationale: "Writes invocation-scoped staging relations rather than public projection facts.",
    sites: [
      "scripts/backfill-hub-counts.ts:insert:dynamic:9ae9c583",
      "scripts/backfill-hub-counts.ts:insert:dynamic:c0d12468",
      "scripts/backfill-hub-counts.ts:insert:dynamic:1305bca4",
    ],
  },
  {
    disposition: "non-projection-fact",
    file: "scripts/backfill-identity-ledger.ts",
    rationale: "Backfills track identity-attempt bookkeeping only.",
    sites: ["scripts/backfill-identity-ledger.ts:update:tracks:bcc7b764"],
  },
  {
    disposition: "test-fixture",
    file: "scripts/bench-frontier-novelty.ts",
    rationale: "Seeds an isolated benchmark database only.",
    sites: [
      "scripts/bench-frontier-novelty.ts:insert:tracks:e7e471d8",
      "scripts/bench-frontier-novelty.ts:insert:tracks:e7e471d8:2",
      "scripts/bench-frontier-novelty.ts:insert:findings:354cf5e9",
    ],
  },
  {
    disposition: "test-fixture",
    file: "scripts/lib/scale-seed.ts",
    rationale: "Seeds deterministic local performance fixtures only.",
    sites: [
      "scripts/lib/scale-seed.ts:insert:tracks:8bb8038d",
      "scripts/lib/scale-seed.ts:insert:findings:354cf5e9",
      "scripts/lib/scale-seed.ts:insert:labels:fd1c42fd",
      "scripts/lib/scale-seed.ts:insert:track_artists:32e13993",
      "scripts/lib/scale-seed.ts:insert:track_artists:32e13993:2",
      "scripts/lib/scale-seed.ts:insert:crawl_frontier:574e0cf1",
      "scripts/lib/scale-seed.ts:update:labels:290f2b0e",
    ],
  },
  {
    disposition: "serialization",
    file: "scripts/lib/device-db-derivation.ts",
    rationale: "Builds SQL for an isolated derived device database only.",
    sites: ["scripts/lib/device-db-derivation.ts:insert:dynamic:0540082e"],
  },
] as const satisfies readonly GoalDReviewedWriterEntry[];
