import rawInventory from "./index-inventory.json";
import {
  TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX,
  trackPageIndexableCoverIndexWhere,
} from "../../src/db/track-page-indexability";
import { type IndexConsumerCoordinate, type IndexInventoryDocument } from "./index-inventory";
import { SCALE_PROFILES, type ScaleProfile } from "./manifest";

// The audit inventory is read from its JSON document directly so this module has no runtime
// dependency on `index-inventory.ts`, which imports this inventory to report it.
const AUDIT_INVENTORY = rawInventory as unknown as IndexInventoryDocument;
const PRODUCTION_LOCK_PROFILES = [...SCALE_PROFILES] as const;

/**
 * Production `INDEXED BY` locks whose index sits OUTSIDE the audit's contraction inventory.
 *
 * `index-inventory.json` is the audit's contraction set: exactly 32 `tracks` indexes and 32
 * database-scale indexes, counted as an invariant, so an index cannot be added there without
 * changing what that cohort means. These indexes still carry production planner locks, and a lock
 * is a standing claim that the planner would otherwise diverge. This inventory holds that claim in
 * its own strict structure: every lock site is a real consumer coordinate, every contract states
 * the exact number of locks its real statement carries, and both counts are validated at import
 * and against the consumer source by `index-evidence.test.ts`.
 *
 * A production-lock contract therefore needs no inventory entry: its evidence is keyed by this
 * inventory's contract id, and `buildIndexAudit` reports it in its own `productionLocks` section
 * next to, never inside, the inventory audit.
 */
export type ProductionLockSite = IndexConsumerCoordinate & {
  /** The production-lock contract whose statement reproduces this site. */
  contractId: string;
};

export type ProductionLockIndex = {
  columns: string[];
  /** The fixture table the evidence statement locks; the fixture index is `perf_<name>`. */
  fixtureTable: string;
  name: string;
  partialPredicate: null | string;
  sites: ProductionLockSite[];
  table: string;
};

export type ProductionLockContract = {
  consumer: IndexConsumerCoordinate[];
  /** Exact number of `INDEXED BY` clauses the real statement carries on the fixture. */
  expectedLockCount: number;
  id: string;
  indexes: string[];
  query: string;
  requiredProfiles: ScaleProfile[];
};

/** Attached to a performance contract that reproduces a production-lock consumer. */
export type ProductionLockEvidenceDefinition = {
  contractId: string;
  expectedLockCount: number;
  growingTables: string[];
  indexes: string[];
};

export type ProductionLockInventory = {
  contracts: ProductionLockContract[];
  indexes: ProductionLockIndex[];
  inventoryKind: string;
};

export const PRODUCTION_LOCK_INDEX_COUNT = 6;
export const PRODUCTION_LOCK_CONTRACT_COUNT = 7;

const ARTISTS_FILE = "apps/web/src/lib/server/artists.ts";
const DUE_WORK_FILE = "apps/web/src/lib/server/due-work.ts";
const HUB_COUNTS_FILE = "apps/web/src/lib/server/hub-counts.ts";
const MIXABLE_FILE = "apps/web/src/lib/server/mixable-artists-projection.ts";
const MIXABLE_BACKFILL_FILE = "apps/web/scripts/backfill-mixable-artists-projection.ts";
const PUBLIC_PROJECTIONS_FILE = "apps/web/src/lib/server/public-projections.ts";
const TRACK_PAGE_FILE = "apps/web/src/lib/server/track-page.ts";

export const PRODUCTION_LOCK_CONTRACT_IDS = {
  artistLink: "index.production-lock.artist-link",
  dueWorkCleanup: "index.production-lock.due-work-cleanup",
  mixableArtists: "index.production-lock.mixable-artists",
  mixableArtistsReconciliation: "index.production-lock.mixable-artists-reconciliation",
  publicProjectionAuditChunk: "index.production-lock.public-projection-audit-chunk",
  rankableArtistRepair: "index.production-lock.rankable-artist-repair",
  sitemapIndexCount: "index.production-lock.sitemap-index-count",
} as const;

export const PRODUCTION_LOCK_INVENTORY: ProductionLockInventory = {
  contracts: [
    {
      consumer: [{ file: ARTISTS_FILE, marker: "buildArtistLinkStatement" }],
      expectedLockCount: 4,
      id: PRODUCTION_LOCK_CONTRACT_IDS.artistLink,
      indexes: ["artists_mbid_idx", "artists_name_nocase_idx"],
      query:
        "buildArtistLinkStatement expands a bounded track batch's credits once, resolves each credit through three sargable branches (mbid seek, name fold for unclaimed mbids with a claimed-mbid anti-join, anonymous name fold), anti-joins to the first position, inserts the edges with insert or ignore, and returns each accepted edge with its catalogue and rankability discriminators.",
      requiredProfiles: [...PRODUCTION_LOCK_PROFILES],
    },
    {
      consumer: [{ file: MIXABLE_FILE, marker: "mixableArtistsProjectionQuery" }],
      expectedLockCount: 1,
      id: PRODUCTION_LOCK_CONTRACT_IDS.mixableArtists,
      indexes: ["artists_mixable_order_idx"],
      query:
        "mixableArtistsProjectionQuery selects name, slug, image_url, and rankable_track_count for artists with a positive rankable count, optionally filtered by a nocase name pattern, ordered by negated count then name, with a limit.",
      requiredProfiles: [...PRODUCTION_LOCK_PROFILES],
    },
    {
      consumer: [{ file: DUE_WORK_FILE, marker: "dueWorkCleanupPageStatement" }],
      expectedLockCount: 4,
      id: PRODUCTION_LOCK_CONTRACT_IDS.dueWorkCleanup,
      indexes: ["due_work_cleanup_idx"],
      query:
        "dueWorkCleanupPageStatement unions four non-repair generation slices of one queue (below the lower generation, between the two generations, above the upper generation, and stale live rows bounded by updated_at), each after a subject cursor, ordered by generation, updated_at, and subject_id with a limit.",
      requiredProfiles: [...PRODUCTION_LOCK_PROFILES],
    },
    {
      consumer: [{ file: HUB_COUNTS_FILE, marker: "repairRankableArtistsForTrackStatement" }],
      expectedLockCount: 1,
      id: PRODUCTION_LOCK_CONTRACT_IDS.rankableArtistRepair,
      indexes: ["track_artists_artist_id_idx"],
      query:
        "repairRankableArtistsForTrackStatement recounts the rankable tracks of every artist credited on one track through the artist-id edge index and updates only the artists whose stored rankable_track_count differs.",
      requiredProfiles: [...PRODUCTION_LOCK_PROFILES],
    },
    {
      consumer: [{ file: PUBLIC_PROJECTIONS_FILE, marker: "readPublicProjectionAuditChunk" }],
      expectedLockCount: 1,
      id: PRODUCTION_LOCK_CONTRACT_IDS.publicProjectionAuditChunk,
      indexes: ["track_artists_artist_id_idx"],
      query:
        "readPublicProjectionAuditChunk's artist source lane pages distinct artist ids after a cursor through the artist-id edge index, then aggregates each page artist's certified finding count and enabled-label credit half units across its edges, tracks, findings, and labels, grouped and ordered by artist id.",
      requiredProfiles: [...PRODUCTION_LOCK_PROFILES],
    },
    {
      consumer: [{ file: MIXABLE_BACKFILL_FILE, marker: "backfillMixableArtistsProjection" }],
      expectedLockCount: 1,
      id: PRODUCTION_LOCK_CONTRACT_IDS.mixableArtistsReconciliation,
      indexes: ["track_artists_artist_id_idx"],
      query:
        "The mixable-artist projection reconciliation recounts one keyset page of artist ids through the artist-id edge index and updates only the artists whose stored rankable_track_count differs; deploy:cf runs it with --activate.",
      requiredProfiles: [...PRODUCTION_LOCK_PROFILES],
    },
    {
      consumer: [{ file: TRACK_PAGE_FILE, marker: "trackSitemapIndexCountStatement" }],
      expectedLockCount: 2,
      id: PRODUCTION_LOCK_CONTRACT_IDS.sitemapIndexCount,
      indexes: [TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX],
      query:
        "trackSitemapIndexCountStatement counts exact archive-track sitemap membership through disjoint Spotify and Apple-only branches over one covering catalogue partial index; its unforced twin selects the broader active-catalogue index on the audited local profiles.",
      requiredProfiles: [...PRODUCTION_LOCK_PROFILES],
    },
  ],
  indexes: [
    {
      columns: ["mbid"],
      fixtureTable: "perf_artists",
      name: "artists_mbid_idx",
      partialPredicate: null,
      sites: [
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.artistLink,
          file: ARTISTS_FILE,
          marker: "indexed by artists_mbid_idx on artist.mbid = credit.mbid",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.artistLink,
          file: ARTISTS_FILE,
          marker: "from artists claimed indexed by artists_mbid_idx",
        },
      ],
      table: "artists",
    },
    {
      columns: ["name collate nocase", "slug"],
      fixtureTable: "perf_artists",
      name: "artists_name_nocase_idx",
      partialPredicate: null,
      sites: [
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.artistLink,
          file: ARTISTS_FILE,
          marker: "and artist.mbid is null",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.artistLink,
          file: ARTISTS_FILE,
          marker: "${anonymousCreditWhere}",
        },
      ],
      table: "artists",
    },
    {
      columns: ["-rankable_track_count", "name", "slug"],
      fixtureTable: "perf_artists",
      name: "artists_mixable_order_idx",
      partialPredicate: "rankable_track_count > 0",
      sites: [
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.mixableArtists,
          file: MIXABLE_FILE,
          marker: "from artists indexed by artists_mixable_order_idx",
        },
      ],
      table: "artists",
    },
    {
      columns: ["work_kind", "subject_type", "generation", "updated_at", "subject_id"],
      fixtureTable: "perf_due_work",
      name: "due_work_cleanup_idx",
      partialPredicate: "state <> 'repair'",
      sites: [
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.dueWorkCleanup,
          file: DUE_WORK_FILE,
          marker: "and generation < ?",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.dueWorkCleanup,
          file: DUE_WORK_FILE,
          marker: "and generation > ? and generation < ?",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.dueWorkCleanup,
          file: DUE_WORK_FILE,
          marker: "and generation > ?\n",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.dueWorkCleanup,
          file: DUE_WORK_FILE,
          marker: "and generation = '${DUE_WORK_LIVE_GENERATION}' and updated_at < ?",
        },
      ],
      table: "due_work",
    },
    {
      columns: ["artist_id"],
      fixtureTable: "perf_track_artists",
      name: "track_artists_artist_id_idx",
      partialPredicate: null,
      sites: [
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.rankableArtistRepair,
          file: HUB_COUNTS_FILE,
          marker: "left join track_artists artist_tracks indexed by track_artists_artist_id_idx",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.publicProjectionAuditChunk,
          file: PUBLIC_PROJECTIONS_FILE,
          marker:
            "select distinct artist_id as id from track_artists indexed by track_artists_artist_id_idx",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.mixableArtistsReconciliation,
          file: MIXABLE_BACKFILL_FILE,
          marker: "left join track_artists indexed by track_artists_artist_id_idx",
        },
      ],
      table: "track_artists",
    },
    {
      columns: [
        "duplicate_of_track_id",
        "dismissed_at",
        "spotify_url",
        "apple_music_url",
        "album_id",
        "release_date",
        "album_image_url",
        "title",
        "artists_json",
      ],
      fixtureTable: "perf_tracks",
      name: TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX,
      partialPredicate: trackPageIndexableCoverIndexWhere(),
      sites: [
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.sitemapIndexCount,
          file: TRACK_PAGE_FILE,
          marker: "from tracks indexed by ${TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX}",
        },
        {
          contractId: PRODUCTION_LOCK_CONTRACT_IDS.sitemapIndexCount,
          file: TRACK_PAGE_FILE,
          marker: "from tracks indexed by ${TRACK_PAGE_INDEXABLE_COVER_COUNT_INDEX}",
        },
      ],
      table: "tracks",
    },
  ],
  inventoryKind: "production-lock-inventory",
};

function coordinateIsEmpty(coordinate: IndexConsumerCoordinate): boolean {
  return coordinate.file.length === 0 || coordinate.marker.length === 0;
}

function validateContracts(
  inventory: ProductionLockInventory,
  auditContractIds: ReadonlySet<string>,
  contractIds: Set<string>,
  failures: string[],
): void {
  for (const contract of inventory.contracts) {
    if (contractIds.has(contract.id)) {
      failures.push(`duplicate production-lock contract: ${contract.id}`);
    }
    contractIds.add(contract.id);
    if (auditContractIds.has(contract.id)) {
      failures.push(`production-lock contract ${contract.id} collides with an inventory contract`);
    }
    if (contract.consumer.length === 0 || contract.consumer.some(coordinateIsEmpty)) {
      failures.push(`production-lock contract ${contract.id} is missing its consumer coordinate`);
    }
    if (contract.query.length === 0) {
      failures.push(`production-lock contract ${contract.id} is missing its consumer query`);
    }
    if (contract.indexes.length === 0) {
      failures.push(`production-lock contract ${contract.id} locks no index`);
    }
    if (!Number.isInteger(contract.expectedLockCount) || contract.expectedLockCount < 1) {
      failures.push(`production-lock contract ${contract.id} must expect at least one lock`);
    }
    if (contract.requiredProfiles.join(",") !== PRODUCTION_LOCK_PROFILES.join(",")) {
      failures.push(`production-lock contract ${contract.id} is missing a required profile`);
    }
  }
}

function validateIndexes(
  inventory: ProductionLockInventory,
  auditNames: ReadonlySet<string>,
  indexNames: Set<string>,
  contractIds: ReadonlySet<string>,
  failures: string[],
): void {
  for (const index of inventory.indexes) {
    if (indexNames.has(index.name)) {
      failures.push(`duplicate production-lock index: ${index.name}`);
    }
    indexNames.add(index.name);
    if (auditNames.has(index.name)) {
      failures.push(`${index.name} belongs to the audit inventory, not the production-lock set`);
    }
    if (index.columns.length === 0) {
      failures.push(`${index.name} has no indexed columns`);
    }
    if (index.fixtureTable.length === 0 || index.table.length === 0) {
      failures.push(`${index.name} is missing its table or fixture table`);
    }
    if (index.sites.length === 0) {
      failures.push(`${index.name} has no production lock site`);
    }
    for (const site of index.sites) {
      if (coordinateIsEmpty(site)) {
        failures.push(`${index.name} has an empty lock site coordinate`);
      }
      if (!contractIds.has(site.contractId)) {
        failures.push(`${index.name} lock site names an undeclared contract ${site.contractId}`);
      } else if (
        !inventory.contracts
          .find((contract) => contract.id === site.contractId)
          ?.indexes.includes(index.name)
      ) {
        failures.push(`${index.name} lock site points to a contract that does not declare it`);
      }
    }
  }
}

function validateContractCoverage(
  inventory: ProductionLockInventory,
  indexNames: ReadonlySet<string>,
  failures: string[],
): void {
  for (const contract of inventory.contracts) {
    for (const indexName of contract.indexes) {
      if (!indexNames.has(indexName)) {
        failures.push(`production-lock contract ${contract.id} locks undeclared ${indexName}`);
      }
    }
    const siteCount = inventory.indexes.reduce(
      (total, index) =>
        total +
        (contract.indexes.includes(index.name)
          ? index.sites.filter((site) => site.contractId === contract.id).length
          : 0),
      0,
    );
    if (siteCount !== contract.expectedLockCount) {
      failures.push(
        `production-lock contract ${contract.id} expects ${contract.expectedLockCount} locks but its indexes declare ${siteCount} sites`,
      );
    }
  }
}

export function validateProductionLockInventory(
  inventory: ProductionLockInventory = PRODUCTION_LOCK_INVENTORY,
  auditInventory: IndexInventoryDocument = AUDIT_INVENTORY,
): string[] {
  const failures: string[] = [];
  const auditEntries = [...auditInventory.tracksIndexes, ...auditInventory.databaseScaleIndexes];
  const auditNames = new Set(auditEntries.map((entry) => entry.name));
  const auditContractIds = new Set(
    auditEntries.flatMap((entry) => entry.performanceContracts.map((contract) => contract.id)),
  );
  const indexNames = new Set<string>();
  const contractIds = new Set<string>();

  if (inventory.inventoryKind !== "production-lock-inventory") {
    failures.push("inventory kind is not production-lock-inventory");
  }
  if (inventory.indexes.length !== PRODUCTION_LOCK_INDEX_COUNT) {
    failures.push(
      `expected ${PRODUCTION_LOCK_INDEX_COUNT} production-lock indexes, found ${inventory.indexes.length}`,
    );
  }
  if (inventory.contracts.length !== PRODUCTION_LOCK_CONTRACT_COUNT) {
    failures.push(
      `expected ${PRODUCTION_LOCK_CONTRACT_COUNT} production-lock contracts, found ${inventory.contracts.length}`,
    );
  }

  validateContracts(inventory, auditContractIds, contractIds, failures);
  validateIndexes(inventory, auditNames, indexNames, contractIds, failures);
  validateContractCoverage(inventory, indexNames, failures);

  return failures;
}

const productionLockFailures = validateProductionLockInventory();
if (productionLockFailures.length > 0) {
  throw new Error(`invalid production-lock inventory: ${productionLockFailures.join("; ")}`);
}

export function productionLockIndex(name: string): ProductionLockIndex {
  const index = PRODUCTION_LOCK_INVENTORY.indexes.find((candidate) => candidate.name === name);
  if (index === undefined) {
    throw new Error(`no production-lock inventory index ${name}`);
  }
  return index;
}

export function productionLockContract(id: string): ProductionLockContract {
  const contract = PRODUCTION_LOCK_INVENTORY.contracts.find((candidate) => candidate.id === id);
  if (contract === undefined) {
    throw new Error(`no production-lock inventory contract ${id}`);
  }
  return contract;
}
