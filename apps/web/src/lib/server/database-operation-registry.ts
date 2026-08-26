import { type DatabaseAccessClass, isDatabaseOperationId } from "./database-observability";

export type OperationMutationDispositionKind =
  | "deliberately-non-replayable"
  | "not-applicable"
  | "receipt-backed"
  | "replay-safe-idempotent";

type OperationMutationDispositionDetails = Readonly<{
  evidenceSource: string;
  rationale: string;
  reconciliation: string;
}>;

export type OperationMutationDisposition =
  | (OperationMutationDispositionDetails & { kind: "deliberately-non-replayable" })
  | (OperationMutationDispositionDetails & { kind: "not-applicable" })
  | (OperationMutationDispositionDetails & { kind: "receipt-backed" })
  | (OperationMutationDispositionDetails & { kind: "replay-safe-idempotent" });
export type OperationTriggerKind = "cli" | "direct-database" | "no-database" | "worker-endpoint";

export type OperationCadence = Readonly<{
  onBootSec?: string;
  onCalendar?: string;
  onUnitActiveSec?: string;
  persistent: boolean;
  randomizedDelaySec?: string;
}>;

export type OperationTrigger = Readonly<{
  /** The stable ID of this step. A scheduled run may contain several steps. */
  operationId: string;
  accessClass: DatabaseAccessClass | null;
  /** Exact command template, HTTP method/path, or non-database action. */
  target: string;
  kind: OperationTriggerKind;
  mutationDisposition: OperationMutationDisposition;
  /** Commander route tokens, without arguments or options. */
  cliRoute?: readonly string[];
  /** Checked-in implementation that issues this trigger. */
  source: string;
}>;

export type IncidentOperation = Readonly<{
  functionName: string;
  mutationDisposition: OperationMutationDisposition;
  operationId: string;
  source: string;
}>;

export type RecurringDatabaseOperation = Readonly<{
  /** Stable run-level ID used by spans and fleet telemetry. */
  operationId: string;
  accessClass: DatabaseAccessClass | null;
  cadence: OperationCadence;
  heavy: boolean;
  incidents: readonly IncidentOperation[];
  mutationDisposition: OperationMutationDisposition;
  owner: Readonly<{
    service: string;
    telemetryUnit: string;
    timer: string;
  }>;
  serviceSource: string;
  timerSource: string;
  triggers: readonly OperationTrigger[];
  wrapperSource: string;
}>;

type OperationDefinition = Omit<
  RecurringDatabaseOperation,
  "incidents" | "mutationDisposition" | "owner" | "serviceSource" | "timerSource"
> & {
  directory: string;
  incidents?: readonly IncidentOperation[];
  service?: string;
  telemetryUnit?: string;
  timer?: string;
};

const HERMES_ROOT = "docs/agents/hermes";

type MutationPolicy = Omit<OperationMutationDisposition, "evidenceSource"> & {
  evidenceSource: string;
};

export const WRITE_MUTATION_POLICIES = {
  "analytics.funnel-snapshot": {
    evidenceSource: "apps/web/src/lib/server/funnel.ts",
    kind: "replay-safe-idempotent",
    rationale: "The UTC-day row uses on-conflict update on its stable day key.",
    reconciliation: "Read that UTC-day snapshot before repeating the bounded recompute.",
  },
  "artist.resolve": {
    evidenceSource: "apps/web/src/lib/server/artists.ts",
    kind: "replay-safe-idempotent",
    rationale: "Identity, social, and image writes are guarded or upserted by stable artist keys.",
    reconciliation: "Read the artist identity and social rows before repeating resolution.",
  },
  "backfill.artist-credits": {
    evidenceSource: "apps/web/src/lib/server/backfill-artist-credits.ts",
    kind: "replay-safe-idempotent",
    rationale: "Artist edges use a natural conflict key and durable per-track drain state.",
    reconciliation: "Read the bounded track work row and its edges before retrying it.",
  },
  "backfill.artist-edges": {
    evidenceSource: "apps/web/src/lib/server/backfill-artist-edges.ts",
    kind: "replay-safe-idempotent",
    rationale: "Edge inserts ignore natural-key conflicts and visited rows carry a durable stamp.",
    reconciliation: "Read the track's current edge set and visited stamp before retrying it.",
  },
  "backfill.cover-masters": {
    evidenceSource: "apps/web/src/lib/server/cover-masters.ts",
    kind: "replay-safe-idempotent",
    rationale: "The bounded resolver fills one owned key/source and is explicitly idempotent.",
    reconciliation: "Read the entity's owned cover key and source before resolving it again.",
  },
  "backfill.label-images": {
    evidenceSource: "apps/web/src/lib/server/label-images.ts",
    kind: "replay-safe-idempotent",
    rationale: "The bounded resolver fills only missing label identity and image fields.",
    reconciliation: "Read the label image fields before repeating that label's resolution.",
  },
  "backfill.label-lineage": {
    evidenceSource: "apps/web/src/lib/server/label-lineage.ts",
    kind: "replay-safe-idempotent",
    rationale: "Lineage facts coalesce into missing fields and preserve prior values.",
    reconciliation: "Read the label lineage fields before repeating that label's fill.",
  },
  "backfill.recording-mbids": {
    evidenceSource: "apps/web/src/lib/server/recording-mbids.ts",
    kind: "replay-safe-idempotent",
    rationale: "Prefix fill requires null identity and resolved MBIDs use non-clobbering coalesce.",
    reconciliation: "Read the recording MBID before retrying the bounded row.",
  },
  "backfill.vendor-sweep": {
    evidenceSource: "apps/web/src/lib/server/backfill.ts",
    kind: "replay-safe-idempotent",
    rationale:
      "Vendor facts use existing-null guards or stable upserts; provider love is idempotent.",
    reconciliation: "Read the bounded track's vendor fields before replaying that item.",
  },
  "bio.album": {
    evidenceSource: "apps/web/src/lib/server/albums.ts",
    kind: "replay-safe-idempotent",
    rationale: "The SQL fill-empty predicate cannot overwrite an existing album bio.",
    reconciliation: "Read the album bio; a non-empty value is the stable result.",
  },
  "bio.artist": {
    evidenceSource: "apps/web/src/lib/server/artists.ts",
    kind: "replay-safe-idempotent",
    rationale: "The SQL fill-empty predicate cannot overwrite an existing artist bio.",
    reconciliation: "Read the artist bio; a non-empty value is the stable result.",
  },
  "bio.label": {
    evidenceSource: "apps/web/src/lib/server/labels.ts",
    kind: "replay-safe-idempotent",
    rationale: "The SQL fill-empty predicate cannot overwrite an existing label bio.",
    reconciliation: "Read the label bio; a non-empty value is the stable result.",
  },
  "catalogue.anchor": {
    evidenceSource: "apps/web/src/lib/server/catalogue.ts",
    kind: "replay-safe-idempotent",
    rationale: "Anchor resolution converges on the track's stable Spotify identity fields.",
    reconciliation: "Read the bounded track's anchor fields before retrying resolution.",
  },
  "catalogue.crawl": {
    evidenceSource: "apps/web/src/lib/server/crawl.ts",
    kind: "replay-safe-idempotent",
    rationale:
      "Frontier and track writes use conflict guards and durable watermark or lease state.",
    reconciliation: "Read the claimed frontier node and lease before retrying that node.",
  },
  "catalogue.demand": {
    evidenceSource: "apps/web/src/lib/server/demand.ts",
    kind: "replay-safe-idempotent",
    rationale: "Demand values are cleared and recomputed from current source truth.",
    reconciliation: "Repeat the bounded recompute; the derived rows converge on current truth.",
  },
  "catalogue.isrc-recovery": {
    evidenceSource: "apps/web/src/lib/server/recording-mbids.ts",
    kind: "replay-safe-idempotent",
    rationale: "Identity recovery fills only missing ISRC or anchor fields.",
    reconciliation: "Read the bounded track's ISRC and anchor fields before retrying it.",
  },
  "catalogue.label-releases": {
    evidenceSource: "apps/web/src/lib/server/label-releases.ts",
    kind: "replay-safe-idempotent",
    rationale: "Track minting uses the stable track ID with on-conflict do-nothing.",
    reconciliation: "Read the track ID before repeating the bounded release item.",
  },
  "catalogue.rank": {
    evidenceSource: "apps/web/src/lib/server/catalogue.ts",
    kind: "replay-safe-idempotent",
    rationale: "The rank transaction uses primary-keyed statements derived from current truth.",
    reconciliation: "Repeat the bounded rank pass; stored rank rows converge by primary key.",
  },
  "catalogue.reconcile-hub-counts": {
    evidenceSource: "apps/web/src/lib/server/hub-counts-reconcile.ts",
    kind: "replay-safe-idempotent",
    rationale: "Hub counts are recomputed from source truth, including stale nonzero rows.",
    reconciliation: "Repeat the bounded reconciliation; zero corrected rows proves convergence.",
  },
  "catalogue.verify-captures": {
    evidenceSource: "apps/web/src/lib/server/catalogue.ts",
    kind: "replay-safe-idempotent",
    rationale: "Verification records a guarded classification on an existing captured track.",
    reconciliation: "Read the bounded track's current capture verdict before retrying it.",
  },
  "clips.studio": {
    evidenceSource: "apps/web/src/lib/server/clips.ts",
    kind: "deliberately-non-replayable",
    rationale: "Cut and render artifacts are created outside the database transaction.",
    reconciliation: "Inspect one clip's state and owned output artifact before recutting it.",
  },
  "device.mirror": {
    evidenceSource: "docs/agents/hermes/scripts/device-mirror.ts",
    kind: "replay-safe-idempotent",
    rationale: "The source-to-device diff is a convergence operation over stable device identity.",
    reconciliation: "Compare the bounded device state with its source before rerunning the diff.",
  },
  "frontier.refresh": {
    evidenceSource: "apps/web/src/lib/server/frontier-playlist.ts",
    kind: "deliberately-non-replayable",
    rationale: "A refresh can mutate an external playlist beyond the database transaction.",
    reconciliation:
      "Inspect the bounded user's persisted and external playlist state before refresh.",
  },
  "galaxies.cluster": {
    evidenceSource: "apps/web/src/lib/server/galaxies-map.ts",
    kind: "replay-safe-idempotent",
    rationale: "Map application upserts centroids and memberships from the same stable map input.",
    reconciliation: "Read the current map generation before applying that generation again.",
  },
  "health.snapshot": {
    evidenceSource: "apps/web/src/lib/server/status.ts",
    kind: "receipt-backed",
    rationale:
      "Random-ID events and samples require the effect and terminal receipt to commit together.",
    reconciliation: "Look up the operation receipt by key before any replay.",
  },
  "live.snapshot": {
    evidenceSource: "apps/web/src/lib/server/live.ts",
    kind: "replay-safe-idempotent",
    rationale: "The live state is upserted into one fixed-identity row.",
    reconciliation: "Read the singleton live-state row before repeating the snapshot.",
  },
  "logbook.draft": {
    evidenceSource: "apps/web/src/lib/server/logbook.ts",
    kind: "replay-safe-idempotent",
    rationale: "Agent draft creation uses on-conflict do-nothing on the stable sector key.",
    reconciliation: "Read the sector entry before retrying its draft.",
  },
  "newsletter.draft": {
    evidenceSource: "apps/web/src/lib/server/newsletter.ts",
    kind: "replay-safe-idempotent",
    rationale:
      "Edition and window identity returns or rejects an existing draft instead of appending.",
    reconciliation: "Read the edition window before retrying draft creation.",
  },
  "ops.pin-watch": {
    evidenceSource: "docs/agents/hermes/pin-watch/rebuild-hermes.sh",
    kind: "deliberately-non-replayable",
    rationale: "Image rebuild and deploy side effects cannot share a database transaction.",
    reconciliation: "Inspect the one pinned image set and running release before rebuilding.",
  },
  "reach.collect": {
    evidenceSource: "apps/web/src/lib/server/platform-stats.ts",
    kind: "replay-safe-idempotent",
    rationale:
      "Snapshot rows use deterministic platform, metric, and UTC-day IDs with conflict suppression.",
    reconciliation:
      "Read that UTC day's platform/metric rows; replay only inserts identities still absent.",
  },
  "social.capture": {
    evidenceSource: "apps/web/src/lib/server/clip-social.ts",
    kind: "replay-safe-idempotent",
    rationale: "A posted clip with a captured permalink leaves the stable worklist.",
    reconciliation: "Read the bounded post row's permalink before capturing it again.",
  },
  "social.metrics": {
    evidenceSource: "apps/web/src/lib/server/social-metrics.ts",
    kind: "replay-safe-idempotent",
    rationale: "Metric snapshots are unique per external post, source, and UTC day.",
    reconciliation: "Read that post/source/day row before repeating collection.",
  },
  "social.publish-advance": {
    evidenceSource: "apps/web/src/lib/server/publish-advance.ts",
    kind: "replay-safe-idempotent",
    rationale:
      "Publication rows use the stable track and platform identity with conflict suppression.",
    reconciliation: "Read the bounded publication row before advancing it again.",
  },
  "submissions.triage": {
    evidenceSource: "apps/web/src/lib/server/submissions.ts",
    kind: "replay-safe-idempotent",
    rationale: "A verdict converges on the same stable submission row and terminal state.",
    reconciliation: "Read the submission's current state before applying the verdict again.",
  },
  "track.capture": {
    evidenceSource: "apps/web/src/lib/server/track-update.ts",
    kind: "deliberately-non-replayable",
    rationale: "Download and object-storage work precedes the mutable track update.",
    reconciliation:
      "Inspect one track's capture state, owned object, and hash before downloading again.",
  },
  "track.context": {
    evidenceSource: "apps/web/src/lib/server/track-update.ts",
    kind: "replay-safe-idempotent",
    rationale: "Context enrichment is guarded by the track's existing authored state.",
    reconciliation: "Read the bounded track's context fields before reauthoring them.",
  },
  "track.embed": {
    evidenceSource: "apps/web/src/lib/server/track-update.ts",
    kind: "deliberately-non-replayable",
    rationale: "Embedding computation and artifact handling precede the mutable track update.",
    reconciliation: "Inspect one track's input and artifact fingerprints before recomputing it.",
  },
  "track.enrich": {
    evidenceSource: "apps/web/src/lib/server/track-update.ts",
    kind: "deliberately-non-replayable",
    rationale: "External analysis is derived before its mutable provenance update.",
    reconciliation: "Inspect one track's analysis provenance before deriving it again.",
  },
  "track.note": {
    evidenceSource: "apps/web/src/lib/server/track-update.ts",
    kind: "replay-safe-idempotent",
    rationale: "The note writer has an in-SQL pending or empty guard.",
    reconciliation: "Read the track note; a non-pending value is the stable result.",
  },
  "track.observe": {
    evidenceSource: "apps/web/src/lib/server/track-update.ts",
    kind: "deliberately-non-replayable",
    rationale: "Observation creation represents a fresh authored observation and provenance.",
    reconciliation: "Inspect one track's observation and provenance before authoring another.",
  },
} as const satisfies Record<string, MutationPolicy>;

export const INCIDENT_MUTATION_POLICIES = {
  fillEmptyAlbumBio: {
    rationale: "The fill-empty predicate cannot overwrite an existing album bio.",
    reconciliation: "Read the album bio before repeating the fill.",
  },
  listDeezerWork: {
    rationale: "The function is a read-only bounded worklist and has no effect to duplicate.",
    reconciliation: "Read the same bounded worklist again.",
  },
  markResolved: {
    rationale:
      "Resolved MBID uses non-clobbering coalesce; only the attempt timestamp may refresh.",
    reconciliation: "Read the recording MBID before repeating the resolution stamp.",
  },
  rearmStaleAllowedArtists: {
    rationale: "Only allowed rows without the current rearm stamp are changed.",
    reconciliation: "Read the artist's rearm stamp before repeating the bounded rearm.",
  },
  stripCrawlerPrefixes: {
    rationale: "Only crawler-prefixed rows with null MBID are filled from stable identity.",
    reconciliation: "Read the recording MBID before repeating the prefix fill.",
  },
} as const;

function makeMutationDisposition(
  kind: OperationMutationDispositionKind,
  evidenceSource: string,
): OperationMutationDisposition {
  switch (kind) {
    case "deliberately-non-replayable":
      throw new Error(`non-replayable operation ${evidenceSource} needs an explicit policy`);
    case "not-applicable":
      return {
        evidenceSource,
        kind,
        rationale: "No product-database mutation occurs in this recurring path.",
        reconciliation: "No mutation reconciliation is required.",
      };
    case "receipt-backed":
    case "replay-safe-idempotent":
      throw new Error(`write operation ${evidenceSource} needs an explicit policy`);
  }
}

function initialTriggerDisposition(
  accessClass: DatabaseAccessClass | null,
  evidenceSource: string,
): OperationMutationDisposition {
  if (accessClass !== "write") {
    return makeMutationDisposition("not-applicable", evidenceSource);
  }

  return {
    evidenceSource,
    kind: "replay-safe-idempotent",
    rationale: "The owning recurring operation supplies this trigger's final mutation policy.",
    reconciliation: "Use the owning recurring operation's reconciliation rule.",
  };
}

function operationMutationDisposition(
  operationId: string,
  accessClass: DatabaseAccessClass | null,
  evidenceSource: string,
): OperationMutationDisposition {
  if (accessClass !== "write") {
    return makeMutationDisposition("not-applicable", evidenceSource);
  }

  const policy = WRITE_MUTATION_POLICIES[operationId as keyof typeof WRITE_MUTATION_POLICIES];
  if (policy === undefined) {
    throw new Error(`write operation ${operationId} has no mutation policy`);
  }

  return policy;
}

function incident(functionName: string, operationId: string, source: string): IncidentOperation {
  const policy =
    INCIDENT_MUTATION_POLICIES[functionName as keyof typeof INCIDENT_MUTATION_POLICIES];
  if (policy === undefined) {
    throw new Error(`incident function ${functionName} has no mutation policy`);
  }

  return {
    functionName,
    mutationDisposition: {
      evidenceSource: source,
      kind: "replay-safe-idempotent",
      ...policy,
    },
    operationId,
    source,
  };
}

function defineOperation(definition: OperationDefinition): RecurringDatabaseOperation {
  const timer = definition.timer ?? `${definition.telemetryUnit}.timer`;
  const service = definition.service ?? timer.replace(/\.timer$/, ".service");
  const directory = `${HERMES_ROOT}/${definition.directory}`;
  const mutationDisposition = operationMutationDisposition(
    definition.operationId,
    definition.accessClass,
    definition.wrapperSource,
  );
  const triggers = definition.triggers.map((trigger) => ({
    ...trigger,
    mutationDisposition:
      trigger.accessClass === "write"
        ? mutationDisposition
        : makeMutationDisposition("not-applicable", trigger.source),
  }));

  return {
    accessClass: definition.accessClass,
    cadence: definition.cadence,
    heavy: definition.heavy,
    incidents: definition.incidents ?? [],
    mutationDisposition,
    operationId: definition.operationId,
    owner: {
      service,
      telemetryUnit: definition.telemetryUnit ?? service.replace(/\.service$/, ""),
      timer,
    },
    serviceSource: `${directory}/${service}`,
    timerSource: `${directory}/${timer}`,
    triggers,
    wrapperSource: definition.wrapperSource,
  };
}

function cli(
  operationId: string,
  route: readonly string[],
  target: string,
  source: string,
): OperationTrigger {
  const accessClass = HEAVY_READ_CLI_OPERATIONS.has(operationId)
    ? "heavy-read"
    : READ_CLI_OPERATIONS.has(operationId)
      ? "read"
      : "write";

  return {
    accessClass,
    cliRoute: route,
    kind: "cli",
    mutationDisposition: initialTriggerDisposition(accessClass, source),
    operationId,
    source,
    target,
  };
}

function endpoint(
  operationId: string,
  method: "GET" | "PATCH" | "POST" | "PUT",
  path: string,
  source: string,
): OperationTrigger {
  const accessClass = method === "GET" ? "read" : "write";

  return {
    accessClass,
    kind: "worker-endpoint",
    mutationDisposition: initialTriggerDisposition(accessClass, source),
    operationId,
    source,
    target: `${method} ${path}`,
  };
}

function direct(
  operationId: string,
  accessClass: DatabaseAccessClass,
  target: string,
  source: string,
): OperationTrigger {
  return {
    accessClass,
    kind: "direct-database",
    mutationDisposition: initialTriggerDisposition(accessClass, source),
    operationId,
    source,
    target,
  };
}

function noDatabase(operationId: string, target: string, source: string): OperationTrigger {
  return {
    accessClass: null,
    kind: "no-database",
    mutationDisposition: makeMutationDisposition("not-applicable", source),
    operationId,
    source,
    target,
  };
}

const every = (
  onBootSec: string,
  onUnitActiveSec: string,
  randomizedDelaySec = "90",
  persistent = true,
): OperationCadence => ({
  onBootSec,
  onUnitActiveSec,
  persistent,
  ...(randomizedDelaySec ? { randomizedDelaySec } : {}),
});

const calendar = (
  onCalendar: string,
  randomizedDelaySec = "60",
  persistent = true,
): OperationCadence => ({ onCalendar, persistent, randomizedDelaySec });

const SCRIPTS = `${HERMES_ROOT}/scripts`;

const READ_CLI_OPERATIONS = new Set([
  "artist.resolve.queue",
  "bio.album.draft",
  "bio.album.queue",
  "bio.artist.draft",
  "bio.artist.queue",
  "bio.label.draft",
  "bio.label.queue",
  "clips.pending.read",
  "galaxies.map.read",
  "logbook.gaps",
  "newsletter.list",
  "render.track-read",
  "render.tracks.queue-read",
  "render.vehicles-read",
  "submissions.list",
  "track.admin-read",
  "track.context.queue",
  "track.context.read",
  "track.enrich.queue",
  "track.note.queue",
  "track.observe.queue",
  "track.read",
  "track.similar",
]);

const HEAVY_READ_CLI_OPERATIONS = new Set(["galaxies.embeddings.read"]);

/**
 * Complete roster of committed Hermes timers. The classification describes the
 * scheduled operation's product-database effect; the standard run-ledger receipt
 * is telemetry and deliberately does not turn a no-database operation into a
 * product write.
 */
export const DATABASE_OPERATION_REGISTRY: readonly RecurringDatabaseOperation[] = [
  defineOperation({
    accessClass: "write",
    cadence: every("9min", "30min"),
    directory: "album-bio-timer",
    heavy: false,
    incidents: [
      incident("fillEmptyAlbumBio", "bio.album.describe", "apps/web/src/lib/server/albums.ts"),
    ],
    operationId: "bio.album",
    service: "fluncle-album-bio.service",
    telemetryUnit: "album-bio",
    timer: "fluncle-album-bio.timer",
    triggers: [
      cli(
        "bio.album.queue",
        ["admin", "albums", "describe"],
        "fluncle admin albums describe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
      cli(
        "bio.album.draft",
        ["admin", "albums", "draft-bio"],
        "fluncle admin albums draft-bio <slug> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
      cli(
        "bio.album.describe",
        ["admin", "albums", "describe"],
        "fluncle admin albums describe <slug> --bio-file <file> --prompt-version <version> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/album-bio-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "1h"),
    directory: "anchor-timer",
    heavy: false,
    operationId: "catalogue.anchor",
    service: "fluncle-anchor.service",
    telemetryUnit: "anchor",
    timer: "fluncle-anchor.timer",
    triggers: [
      endpoint(
        "catalogue.anchor.queue",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/anchor-sweep.ts`,
      ),
      endpoint(
        "catalogue.anchor.search",
        "POST",
        "/api/v1/admin/catalogue/anchor",
        `${SCRIPTS}/anchor-sweep.ts`,
      ),
      endpoint(
        "catalogue.anchor.resolve",
        "POST",
        "/api/v1/admin/catalogue/anchor/resolve",
        `${SCRIPTS}/anchor-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/anchor-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("5min", "30min"),
    directory: "artist-bio-timer",
    heavy: false,
    operationId: "bio.artist",
    service: "fluncle-artist-bio.service",
    telemetryUnit: "artist-bio",
    timer: "fluncle-artist-bio.timer",
    triggers: [
      cli(
        "bio.artist.queue",
        ["admin", "artists", "describe"],
        "fluncle admin artists describe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
      cli(
        "bio.artist.draft",
        ["admin", "artists", "draft-bio"],
        "fluncle admin artists draft-bio <slug> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
      cli(
        "bio.artist.describe",
        ["admin", "artists", "describe"],
        "fluncle admin artists describe <slug> --bio-file <file> --prompt-version <version> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-bio-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("4min", "5min"),
    directory: "artist-credits-timer",
    heavy: false,
    operationId: "backfill.artist-credits",
    service: "fluncle-artist-credits.service",
    telemetryUnit: "artist-credits",
    timer: "fluncle-artist-credits.timer",
    triggers: [
      cli(
        "backfill.artist-credits",
        ["admin", "backfills", "artist-credits"],
        "fluncle admin backfills artist-credits --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-credits-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-credits-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("17min", "60min"),
    directory: "artist-edges-timer",
    heavy: false,
    operationId: "backfill.artist-edges",
    service: "fluncle-artist-edges.service",
    telemetryUnit: "artist-edges",
    timer: "fluncle-artist-edges.timer",
    triggers: [
      cli(
        "backfill.artist-edges",
        ["admin", "backfills", "artist-edges"],
        "fluncle admin backfills artist-edges --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-edges-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-edges-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("7min", "60min"),
    directory: "artist-sweep-timer",
    heavy: false,
    operationId: "artist.resolve",
    service: "fluncle-artist-sweep.service",
    telemetryUnit: "artist-sweep",
    timer: "fluncle-artist-sweep.timer",
    triggers: [
      cli(
        "artist.resolve.queue",
        ["admin", "artists", "resolve"],
        "fluncle admin artists resolve --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-sweep.ts`,
      ),
      cli(
        "artist.resolve",
        ["admin", "artists", "resolve"],
        "fluncle admin artists resolve <id> --json",
        `${SCRIPTS}/artist-sweep.ts`,
      ),
      cli(
        "backfill.artist-images",
        ["admin", "backfills", "artist-images"],
        "fluncle admin backfills artist-images --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-sweep.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*-*-* 05:00:00 Europe/Amsterdam"),
    directory: "audit-review-timer",
    heavy: false,
    operationId: "ops.audit-review",
    service: "fluncle-audit-review.service",
    telemetryUnit: "audit-review",
    timer: "fluncle-audit-review.timer",
    triggers: [
      noDatabase(
        "ops.audit-review",
        "review the newest audit pull request",
        `${SCRIPTS}/audit-review-sweep.sh`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/audit-review-sweep.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*-*-* 01:00:00 Europe/Amsterdam"),
    directory: "audit-timer",
    heavy: false,
    operationId: "ops.audit",
    service: "fluncle-audit.service",
    telemetryUnit: "audit",
    timer: "fluncle-audit.timer",
    triggers: [
      noDatabase("ops.audit", "run the nightly repository audit", `${SCRIPTS}/audit-sweep.sh`),
    ],
    wrapperSource: `${SCRIPTS}/audit-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("5min", "30min"),
    directory: "backfill-timer",
    heavy: false,
    incidents: [
      incident("listDeezerWork", "backfill.deezer", "apps/web/src/lib/server/backfill.ts"),
    ],
    operationId: "backfill.vendor-sweep",
    service: "fluncle-backfill.service",
    telemetryUnit: "backfill",
    timer: "fluncle-backfill.timer",
    triggers: [
      endpoint(
        "backfill.discogs",
        "POST",
        "/api/v1/admin/backfill/discogs",
        `${SCRIPTS}/backfill-sweep.ts`,
      ),
      cli(
        "backfill.lastfm",
        ["admin", "backfills", "lastfm"],
        "fluncle admin backfills lastfm --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
      ),
      cli(
        "backfill.apple-music",
        ["admin", "backfills", "apple-music"],
        "fluncle admin backfills apple-music --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
      ),
      cli(
        "backfill.apple-catalogue",
        ["admin", "backfills", "apple-catalogue"],
        "fluncle admin backfills apple-catalogue --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
      ),
      cli(
        "backfill.beatport",
        ["admin", "backfills", "beatport"],
        "fluncle admin backfills beatport --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
      ),
      endpoint(
        "backfill.discogs-facts",
        "POST",
        "/api/v1/admin/backfill/discogs-facts",
        `${SCRIPTS}/backfill-sweep.ts`,
      ),
      cli(
        "backfill.deezer",
        ["admin", "backfills", "deezer"],
        "fluncle admin backfills deezer --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/backfill-sweep.sh`,
  }),
  defineOperation({
    accessClass: "heavy-read",
    cadence: calendar("*-*-* 03:00:00 Europe/Amsterdam"),
    directory: "backup-timer",
    heavy: true,
    operationId: "database.backup",
    service: "fluncle-backup.service",
    telemetryUnit: "backup",
    timer: "fluncle-backup.timer",
    triggers: [
      direct(
        "database.backup",
        "heavy-read",
        "stream a read-only database dump to the backup archive",
        `${SCRIPTS}/backup-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/backup-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("3min", "5min"),
    directory: "capture-timer",
    heavy: true,
    operationId: "track.capture",
    service: "fluncle-capture.service",
    telemetryUnit: "capture",
    timer: "fluncle-capture.timer",
    triggers: [
      endpoint(
        "track.capture.queue",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/capture-sweep.ts`,
      ),
      endpoint(
        "track.capture.write",
        "PATCH",
        "/api/v1/admin/tracks/{trackId}",
        `${SCRIPTS}/capture-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/capture-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 02:20:00 Europe/Amsterdam"),
    directory: "cluster-timer",
    heavy: true,
    operationId: "galaxies.cluster",
    service: "fluncle-cluster.service",
    telemetryUnit: "cluster",
    timer: "fluncle-cluster.timer",
    triggers: [
      cli(
        "galaxies.map.read",
        ["admin", "galaxies", "map"],
        "fluncle admin galaxies map --json",
        `${SCRIPTS}/cluster-sweep.ts`,
      ),
      cli(
        "galaxies.embeddings.read",
        ["admin", "galaxies", "embeddings"],
        "fluncle admin galaxies embeddings --cursor <cursor> --json",
        `${SCRIPTS}/cluster-sweep.ts`,
      ),
      cli(
        "galaxies.map.write",
        ["admin", "galaxies", "set-map"],
        "fluncle admin galaxies set-map --file <file> --json",
        `${SCRIPTS}/cluster-sweep.ts`,
      ),
      cli(
        "track.update.galaxy",
        ["admin", "tracks", "update"],
        "fluncle admin tracks update <id> --galaxy-id <id> --json",
        `${SCRIPTS}/cluster-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/cluster-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("2min", "5min"),
    directory: "context-note-timer",
    heavy: false,
    operationId: "track.context",
    service: "fluncle-context-note.service",
    telemetryUnit: "context-note",
    timer: "fluncle-context-note.timer",
    triggers: [
      cli(
        "track.context.queue",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/context-sweep.ts`,
      ),
      cli(
        "track.context.fill",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context <id> --json",
        `${SCRIPTS}/context-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/context-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "60min"),
    directory: "cover-masters-timer",
    heavy: false,
    operationId: "backfill.cover-masters",
    service: "fluncle-cover-masters.service",
    telemetryUnit: "cover-masters",
    timer: "fluncle-cover-masters.timer",
    triggers: [
      cli(
        "backfill.cover-masters.album",
        ["admin", "backfills", "cover-masters"],
        "fluncle admin backfills cover-masters --kind album --limit <bounded-limit> --json",
        `${SCRIPTS}/cover-masters-sweep.ts`,
      ),
      cli(
        "backfill.cover-masters.artist",
        ["admin", "backfills", "cover-masters"],
        "fluncle admin backfills cover-masters --kind artist --limit <bounded-limit> --json",
        `${SCRIPTS}/cover-masters-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/cover-masters-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("7min", "10min"),
    directory: "crawl-timer",
    heavy: true,
    incidents: [
      incident("rearmStaleAllowedArtists", "catalogue.crawl", "apps/web/src/lib/server/crawl.ts"),
    ],
    operationId: "catalogue.crawl",
    service: "fluncle-crawl.service",
    telemetryUnit: "crawl",
    timer: "fluncle-crawl.timer",
    triggers: [
      cli(
        "catalogue.crawl",
        ["admin", "catalogue", "crawl"],
        "fluncle admin catalogue crawl --limit 60 --json",
        `${SCRIPTS}/crawl-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/crawl-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 04:40:00 Europe/Amsterdam"),
    directory: "demand-timer",
    heavy: true,
    operationId: "catalogue.demand",
    service: "fluncle-demand.service",
    telemetryUnit: "demand",
    timer: "fluncle-demand.timer",
    triggers: [
      cli(
        "catalogue.demand",
        ["admin", "catalogue", "demand"],
        "fluncle admin catalogue demand --json",
        `${SCRIPTS}/demand-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/demand-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("23min", "1h"),
    directory: "device-mirror-timer",
    heavy: true,
    operationId: "device.mirror",
    service: "fluncle-device-mirror.service",
    telemetryUnit: "device-mirror",
    timer: "fluncle-device-mirror.timer",
    triggers: [
      direct(
        "device.mirror",
        "write",
        "diff the source database into the device mirror database",
        `${SCRIPTS}/device-mirror.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/device-mirror.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("3min", "5min"),
    directory: "embed-timer",
    heavy: false,
    operationId: "track.embed",
    service: "fluncle-embed.service",
    telemetryUnit: "embed",
    timer: "fluncle-embed.timer",
    triggers: [
      endpoint(
        "track.embed.queue",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/embed-sweep.ts`,
      ),
      cli(
        "track.update.embedding",
        ["admin", "tracks", "update"],
        "fluncle admin tracks update <id> --embedding-file <file> --json",
        `${SCRIPTS}/embed-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/embed-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("1min", "5min"),
    directory: "enrich-timer",
    heavy: false,
    operationId: "track.enrich",
    service: "fluncle-enrich.service",
    telemetryUnit: "enrich",
    timer: "fluncle-enrich.timer",
    triggers: [
      cli(
        "track.enrich.queue",
        ["admin", "tracks", "enrich"],
        "fluncle admin tracks enrich --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/enrich-sweep.ts`,
      ),
      cli(
        "track.read",
        ["tracks", "get"],
        "fluncle tracks get <id> --json",
        `${SCRIPTS}/enrich-sweep.ts`,
      ),
      endpoint(
        "track.enrich.catalogue-queue",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/enrich-sweep.ts`,
      ),
      cli(
        "track.update.analysis",
        ["admin", "tracks", "update"],
        "fluncle admin tracks update <id> <analysis-fields> --json",
        `${SCRIPTS}/enrich-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/enrich-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*:0/15"),
    directory: "frontier-refresh-timer",
    heavy: false,
    operationId: "frontier.refresh",
    service: "fluncle-frontier-refresh.service",
    telemetryUnit: "frontier-refresh",
    timer: "fluncle-frontier-refresh.timer",
    triggers: [
      cli(
        "frontier.refresh",
        ["admin", "frontier", "refresh"],
        "fluncle admin frontier refresh --json",
        `${SCRIPTS}/frontier-refresh-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/frontier-refresh-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 23:45:00 UTC"),
    directory: "funnel-snapshot-timer",
    heavy: false,
    operationId: "analytics.funnel-snapshot",
    service: "fluncle-funnel-snapshot.service",
    telemetryUnit: "funnel-snapshot",
    timer: "fluncle-funnel-snapshot.timer",
    triggers: [
      endpoint(
        "analytics.funnel-snapshot",
        "POST",
        "/api/v1/admin/funnel/snapshot",
        `${SCRIPTS}/funnel-snapshot-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/funnel-snapshot-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("2min", "10min"),
    directory: "healthcheck-timer",
    heavy: false,
    operationId: "health.snapshot",
    service: "fluncle-healthcheck.service",
    telemetryUnit: "healthcheck",
    timer: "fluncle-healthcheck.timer",
    triggers: [
      endpoint("health.web", "GET", "/api/v1/health", `${SCRIPTS}/fluncle-healthcheck.ts`),
      endpoint("health.database", "GET", "/api/v1/status", `${SCRIPTS}/fluncle-healthcheck.ts`),
      endpoint(
        "health.snapshot",
        "POST",
        "/api/v1/admin/health",
        `${SCRIPTS}/fluncle-healthcheck.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/fluncle-healthcheck.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("12min", "1h"),
    directory: "isrc-recovery-timer",
    heavy: false,
    operationId: "catalogue.isrc-recovery",
    service: "fluncle-isrc-recovery.service",
    telemetryUnit: "isrc-recovery",
    timer: "fluncle-isrc-recovery.timer",
    triggers: [
      endpoint(
        "catalogue.isrc-recovery.queue",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/isrc-recovery-sweep.ts`,
      ),
      endpoint(
        "catalogue.isrc-recovery.resolve",
        "POST",
        "/api/v1/admin/catalogue/anchor/resolve",
        `${SCRIPTS}/isrc-recovery-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/isrc-recovery-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("7min", "30min"),
    directory: "label-bio-timer",
    heavy: false,
    operationId: "bio.label",
    service: "fluncle-label-bio.service",
    telemetryUnit: "label-bio",
    timer: "fluncle-label-bio.timer",
    triggers: [
      cli(
        "bio.label.queue",
        ["admin", "labels", "describe"],
        "fluncle admin labels describe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
      cli(
        "bio.label.draft",
        ["admin", "labels", "draft-bio"],
        "fluncle admin labels draft-bio <slug> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
      cli(
        "bio.label.describe",
        ["admin", "labels", "describe"],
        "fluncle admin labels describe <slug> --bio-file <file> --prompt-version <version> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-bio-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("8min", "60min"),
    directory: "label-images-timer",
    heavy: false,
    operationId: "backfill.label-images",
    service: "fluncle-label-images.service",
    telemetryUnit: "label-images",
    timer: "fluncle-label-images.timer",
    triggers: [
      cli(
        "backfill.label-images",
        ["admin", "backfills", "label-images"],
        "fluncle admin backfills label-images --limit <bounded-limit> --json",
        `${SCRIPTS}/label-images-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-images-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("13min", "60min"),
    directory: "label-lineage-timer",
    heavy: false,
    operationId: "backfill.label-lineage",
    service: "fluncle-label-lineage.service",
    telemetryUnit: "label-lineage",
    timer: "fluncle-label-lineage.timer",
    triggers: [
      cli(
        "backfill.label-lineage",
        ["admin", "backfills", "label-lineage"],
        "fluncle admin backfills label-lineage --limit <bounded-limit> --json",
        `${SCRIPTS}/label-lineage-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-lineage-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("23min", "24h"),
    directory: "label-releases-timer",
    heavy: false,
    operationId: "catalogue.label-releases",
    service: "fluncle-label-releases.service",
    telemetryUnit: "label-releases",
    timer: "fluncle-label-releases.timer",
    triggers: [
      endpoint(
        "catalogue.label-releases",
        "POST",
        "/api/v1/admin/backfill/label-releases",
        `${SCRIPTS}/label-releases-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-releases-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("30s", "1min", "90", false),
    directory: "live-timer",
    heavy: false,
    operationId: "live.snapshot",
    service: "fluncle-live.service",
    telemetryUnit: "live",
    timer: "fluncle-live.timer",
    triggers: [
      endpoint("live.snapshot", "POST", "/api/v1/admin/twitch/live", `${SCRIPTS}/fluncle-live.ts`),
    ],
    wrapperSource: `${SCRIPTS}/fluncle-live.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 00:40:00 Europe/Amsterdam"),
    directory: "logbook-timer",
    heavy: false,
    operationId: "logbook.draft",
    service: "fluncle-logbook.service",
    telemetryUnit: "logbook",
    timer: "fluncle-logbook.timer",
    triggers: [
      cli(
        "logbook.gaps",
        ["admin", "logbook", "gaps"],
        "fluncle admin logbook gaps --limit <bounded-limit> --json",
        `${SCRIPTS}/logbook-sweep.ts`,
      ),
      cli(
        "logbook.create",
        ["admin", "logbook", "create"],
        "fluncle admin logbook create <sector> --title <title> --body-file <file> --json",
        `${SCRIPTS}/logbook-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/logbook-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("Fri 15:00 Europe/Amsterdam"),
    directory: "newsletter-timer",
    heavy: false,
    operationId: "newsletter.draft",
    service: "fluncle-newsletter.service",
    telemetryUnit: "newsletter",
    timer: "fluncle-newsletter.timer",
    triggers: [
      cli(
        "newsletter.list",
        ["admin", "newsletter", "list"],
        "fluncle admin newsletter list --json",
        `${SCRIPTS}/newsletter-sweep.ts`,
      ),
      cli(
        "newsletter.draft",
        ["admin", "newsletter", "draft"],
        "fluncle admin newsletter draft --content-file <file> --subject <subject> --window-since <iso> --window-until <iso> --json",
        `${SCRIPTS}/newsletter-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/newsletter-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("3min", "10min"),
    directory: "note-timer",
    heavy: false,
    operationId: "track.note",
    service: "fluncle-note.service",
    telemetryUnit: "note",
    timer: "fluncle-note.timer",
    triggers: [
      cli(
        "track.note.queue",
        ["admin", "tracks", "note"],
        "fluncle admin tracks note --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/note-sweep.ts`,
      ),
      cli(
        "track.read",
        ["tracks", "get"],
        "fluncle tracks get <id> --json",
        `${SCRIPTS}/note-sweep.ts`,
      ),
      cli(
        "track.similar",
        ["tracks", "similar"],
        "fluncle tracks similar <id> --limit <bounded-limit> --json",
        `${SCRIPTS}/note-sweep.ts`,
      ),
      cli(
        "track.context.read",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context <id> --json",
        `${SCRIPTS}/note-sweep.ts`,
      ),
      cli(
        "track.note.write",
        ["admin", "tracks", "note"],
        "fluncle admin tracks note <id> --script-file <file> --json",
        `${SCRIPTS}/note-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/note-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("4min", "60min"),
    directory: "observation-timer",
    heavy: false,
    operationId: "track.observe",
    service: "fluncle-observation.service",
    telemetryUnit: "observation",
    timer: "fluncle-observation.timer",
    triggers: [
      cli(
        "track.observe.queue",
        ["admin", "tracks", "observe"],
        "fluncle admin tracks observe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/observe-sweep.ts`,
      ),
      cli(
        "track.read",
        ["tracks", "get"],
        "fluncle tracks get <id> --json",
        `${SCRIPTS}/observe-sweep.ts`,
      ),
      cli(
        "track.context.read",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context <id> --json",
        `${SCRIPTS}/observe-sweep.ts`,
      ),
      cli(
        "track.observe.write",
        ["admin", "tracks", "observe"],
        "fluncle admin tracks observe <id> --script-file <file> --json",
        `${SCRIPTS}/observe-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/observe-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("10min", "1h", "", true),
    directory: "pin-watch",
    heavy: false,
    operationId: "ops.pin-watch",
    service: "pin-watch.service",
    telemetryUnit: "pin-watch",
    timer: "pin-watch.timer",
    triggers: [
      endpoint(
        "health.self-deploy",
        "POST",
        "/api/v1/admin/health",
        `${HERMES_ROOT}/pin-watch/rebuild-hermes.sh`,
      ),
    ],
    wrapperSource: `${HERMES_ROOT}/pin-watch/rebuild-hermes.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("9min", "30min"),
    directory: "publish-advance-timer",
    heavy: false,
    operationId: "social.publish-advance",
    service: "fluncle-publish-advance.service",
    telemetryUnit: "publish-advance",
    timer: "fluncle-publish-advance.timer",
    triggers: [
      endpoint(
        "social.publish-advance",
        "POST",
        "/api/v1/admin/social/publish/advance",
        `${SCRIPTS}/publish-advance-sweep.sh`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/publish-advance-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "30min"),
    directory: "rank-timer",
    heavy: true,
    operationId: "catalogue.rank",
    service: "fluncle-rank.service",
    telemetryUnit: "rank",
    timer: "fluncle-rank.timer",
    triggers: [
      cli(
        "catalogue.rank",
        ["admin", "catalogue", "rank"],
        "fluncle admin catalogue rank --limit <bounded-limit> --json",
        `${SCRIPTS}/rank-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/rank-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 04:00:00 Europe/Amsterdam"),
    directory: "reach-timer",
    heavy: false,
    operationId: "reach.collect",
    service: "fluncle-reach.service",
    telemetryUnit: "reach",
    timer: "fluncle-reach.timer",
    triggers: [
      cli(
        "reach.collect",
        ["admin", "reach", "collect"],
        "fluncle admin reach collect --json",
        `${SCRIPTS}/reach-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/reach-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 04:10:00 Europe/Amsterdam"),
    directory: "reconcile-hub-counts-timer",
    heavy: true,
    operationId: "catalogue.reconcile-hub-counts",
    service: "fluncle-reconcile-hub-counts.service",
    telemetryUnit: "reconcile-hub-counts",
    timer: "fluncle-reconcile-hub-counts.timer",
    triggers: [
      endpoint(
        "catalogue.reconcile-hub-counts",
        "POST",
        "/api/v1/admin/hub-counts/reconcile",
        `${SCRIPTS}/reconcile-hub-counts.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/reconcile-hub-counts.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "60min"),
    directory: "recording-mbids-timer",
    heavy: false,
    incidents: [
      incident(
        "stripCrawlerPrefixes",
        "backfill.recording-mbids",
        "apps/web/src/lib/server/recording-mbids.ts",
      ),
      incident(
        "markResolved",
        "backfill.recording-mbids",
        "apps/web/src/lib/server/recording-mbids.ts",
      ),
    ],
    operationId: "backfill.recording-mbids",
    service: "fluncle-recording-mbids.service",
    telemetryUnit: "recording-mbids",
    timer: "fluncle-recording-mbids.timer",
    triggers: [
      cli(
        "backfill.recording-mbids",
        ["admin", "backfills", "recording-mbids"],
        "fluncle admin backfills recording-mbids --limit <bounded-limit> --json",
        `${SCRIPTS}/recording-mbids-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/recording-mbids-sweep.sh`,
  }),
  defineOperation({
    accessClass: "read",
    cadence: every("9min", "60min"),
    directory: "render-timer",
    heavy: false,
    operationId: "render.conductor",
    service: "fluncle-render.service",
    telemetryUnit: "render",
    timer: "fluncle-render.timer",
    triggers: [
      cli(
        "render.track-read",
        ["admin", "tracks", "get"],
        "fluncle admin tracks get <id> --json",
        `${SCRIPTS}/render-conductor.sh`,
      ),
      cli(
        "render.tracks.queue-read",
        ["admin", "tracks", "queue"],
        "fluncle admin tracks queue --limit 25 --json",
        `${SCRIPTS}/render-conductor.sh`,
      ),
      cli(
        "render.vehicles-read",
        ["admin", "tracks", "vehicles"],
        "fluncle admin tracks vehicles --json",
        `${SCRIPTS}/render-conductor.sh`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/render-conductor.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: every("1min", "15min", ""),
    directory: "secrets",
    heavy: false,
    operationId: "ops.secrets-sync",
    service: "fluncle-secrets-sync.service",
    telemetryUnit: "fluncle-secrets-sync",
    timer: "fluncle-secrets-sync.timer",
    triggers: [
      noDatabase(
        "ops.secrets-sync",
        "materialize the box secret files",
        `${HERMES_ROOT}/secrets/fluncle-secrets-sync.sh`,
      ),
    ],
    wrapperSource: `${HERMES_ROOT}/secrets/fluncle-secrets-sync.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*-*-* 03:30:00 Europe/Amsterdam"),
    directory: "sentry-triage-timer",
    heavy: false,
    operationId: "ops.sentry-triage",
    service: "fluncle-sentry-triage.service",
    telemetryUnit: "sentry-triage",
    timer: "fluncle-sentry-triage.timer",
    triggers: [
      noDatabase(
        "ops.sentry-triage",
        "triage the Sentry issue queue",
        `${SCRIPTS}/sentry-triage-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/sentry-triage-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("6min", "10min"),
    directory: "social-capture-timer",
    heavy: false,
    operationId: "social.capture",
    service: "fluncle-social-capture.service",
    telemetryUnit: "social-capture",
    timer: "fluncle-social-capture.timer",
    triggers: [
      endpoint(
        "social.capture",
        "POST",
        "/api/v1/admin/social/posts/capture",
        `${SCRIPTS}/social-capture-sweep.sh`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/social-capture-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 22:15:00 UTC"),
    directory: "social-metrics-timer",
    heavy: false,
    operationId: "social.metrics",
    service: "fluncle-social-metrics.service",
    telemetryUnit: "social-metrics",
    timer: "fluncle-social-metrics.timer",
    triggers: [
      endpoint(
        "social.metrics",
        "POST",
        "/api/v1/admin/social/metrics/record",
        `${SCRIPTS}/social-metrics-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/social-metrics-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("10min", "15min"),
    directory: "studio-clip-timer",
    heavy: false,
    operationId: "clips.studio",
    service: "fluncle-studio-clip.service",
    telemetryUnit: "studio-clip",
    timer: "fluncle-studio-clip.timer",
    triggers: [
      cli(
        "clips.pending.read",
        ["admin", "clips", "list"],
        "fluncle admin clips list --status pending --json",
        `${SCRIPTS}/clip-sweep.ts`,
      ),
      cli(
        "clips.cut",
        ["admin", "clips", "cut"],
        "fluncle admin clips cut <id> --json",
        `${SCRIPTS}/clip-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/clip-sweep.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*:0/15", "90"),
    directory: "timer-watchdog",
    heavy: false,
    operationId: "ops.timer-watchdog",
    service: "fluncle-timer-watchdog.service",
    telemetryUnit: "fluncle-timer-watchdog",
    timer: "fluncle-timer-watchdog.timer",
    triggers: [
      noDatabase(
        "ops.timer-watchdog",
        "inspect and re-arm stranded systemd timers",
        `${HERMES_ROOT}/timer-watchdog/timer-watchdog.sh`,
      ),
    ],
    wrapperSource: `${HERMES_ROOT}/timer-watchdog/timer-watchdog.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("5min", "15min"),
    directory: "triage-timer",
    heavy: false,
    operationId: "submissions.triage",
    service: "fluncle-triage.service",
    telemetryUnit: "triage",
    timer: "fluncle-triage.timer",
    triggers: [
      cli(
        "submissions.list",
        ["admin", "submissions"],
        "fluncle admin submissions --json",
        `${SCRIPTS}/triage-sweep.ts`,
      ),
      cli(
        "track.admin-read",
        ["admin", "tracks", "get"],
        "fluncle admin tracks get <id> --json",
        `${SCRIPTS}/triage-sweep.ts`,
      ),
      cli(
        "submissions.triage",
        ["admin", "submissions", "triage"],
        "fluncle admin submissions triage <id> --verdict-file <file> --json",
        `${SCRIPTS}/triage-sweep.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/triage-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("17min", "30min"),
    directory: "verify-captures-timer",
    heavy: false,
    operationId: "catalogue.verify-captures",
    service: "fluncle-verify-captures.service",
    telemetryUnit: "verify-captures",
    timer: "fluncle-verify-captures.timer",
    triggers: [
      endpoint(
        "catalogue.verify-captures.queue",
        "GET",
        "/api/v1/admin/catalogue/captures/unverified",
        `${SCRIPTS}/verify-captures.ts`,
      ),
      endpoint(
        "catalogue.verify-captures.write",
        "POST",
        "/api/v1/admin/catalogue/captures/verify",
        `${SCRIPTS}/verify-captures.ts`,
      ),
    ],
    wrapperSource: `${SCRIPTS}/verify-captures.sh`,
  }),
];

const operationByOwner = new Map<string, RecurringDatabaseOperation>();

for (const operation of DATABASE_OPERATION_REGISTRY) {
  const aliases = [
    operation.owner.service,
    operation.owner.service.replace(/\.service$/, ""),
    operation.owner.telemetryUnit,
    operation.owner.timer,
    operation.owner.timer.replace(/\.timer$/, ""),
  ];

  for (const alias of aliases) {
    operationByOwner.set(alias, operation);
  }
}

export type ResolvedDatabaseOperationOwner = Readonly<{
  accessClass: DatabaseAccessClass | null;
  heavy: boolean;
  operationId: string;
}>;

/** Resolve an exact committed unit/timer alias. Unknown external values stay unknown. */
export function resolveDatabaseOperationOwner(
  owner: string,
): ResolvedDatabaseOperationOwner | undefined {
  const operation = operationByOwner.get(owner);

  if (!operation || !isDatabaseOperationId(operation.operationId)) {
    return undefined;
  }

  return {
    accessClass: operation.accessClass,
    heavy: operation.heavy,
    operationId: operation.operationId,
  };
}
