export const DUE_WORK_CATALOGUE_RANK_PRODUCER_DEPENDENCIES = {
  ambiguous: ["capture-verification-quarantine"],
  required: [
    "artist-credit-edges",
    "artist-edge-backfill",
    "artist-edge-link",
    "artist-edge-rank-restale",
    "artist-edge-upsert",
    "backfill-artist-links",
    "backfill-has-embedding-rank-corpus",
    "backfill-label-seed",
    "backfill-remixer-role",
    "catalogue-flag-wrong-audio",
    "certify-track",
    "label-seed-state",
    "publish-track",
    "track-update",
  ],
} as const;

export type DueWorkCatalogueRankProducer =
  | (typeof DUE_WORK_CATALOGUE_RANK_PRODUCER_DEPENDENCIES.ambiguous)[number]
  | (typeof DUE_WORK_CATALOGUE_RANK_PRODUCER_DEPENDENCIES.required)[number];
