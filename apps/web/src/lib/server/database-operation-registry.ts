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

export type DatabaseMutationTarget = "derived-local" | "derived-remote" | "primary";

export type OperationDatabaseProfile = Readonly<{
  /** Access against the primary application database, independent of any derived target. */
  accessClass: DatabaseAccessClass | null;
  mutationDisposition: OperationMutationDisposition;
  mutationTarget: DatabaseMutationTarget | null;
}>;

export type OperationCadence = Readonly<{
  kind: "daemon" | "timer";
  interval?: Readonly<{ defaultSeconds: number; environment: string }>;
  onBootSec?: string;
  onCalendar?: string;
  onUnitActiveSec?: string;
  persistent: boolean;
  randomizedDelaySec?: string;
  reconcileInterval?: Readonly<{ defaultSeconds: number; environment: string }>;
}>;

export type OperationTrigger = OperationDatabaseProfile &
  Readonly<{
    /** The stable ID of this step. A scheduled run may contain several steps. */
    operationId: string;
    /** The retained flag-off path when it differs from the final operation profile. */
    compatibility?: OperationDatabaseProfile;
    /** Exact command template, HTTP method/path, or non-database action. */
    target: string;
    kind: OperationTriggerKind;
    /** Commander route tokens, without arguments or options. */
    cliRoute?: readonly string[];
    /** Checked-in implementation that issues this trigger. */
    source: string;
  }>;

export type IncidentOperation = Readonly<{
  accessClass: DatabaseAccessClass;
  functionName: string;
  mutationDisposition: OperationMutationDisposition;
  operationId: string;
  source: string;
}>;

export type RecurringDatabaseOperation = OperationDatabaseProfile &
  Readonly<{
    /** Stable run-level ID used by spans and fleet telemetry. */
    operationId: string;
    cadence: OperationCadence;
    cadenceSource: string;
    /** The retained flag-off path when its aggregate profile differs from the final one. */
    compatibility?: OperationDatabaseProfile;
    heavy: boolean;
    incidents: readonly IncidentOperation[];
    owner: Readonly<{
      service: string;
      telemetryUnit: string;
      timer: string | null;
    }>;
    serviceSource: string;
    timerSource: string | null;
    triggers: readonly OperationTrigger[];
    wrapperSource: string;
  }>;

type DatabaseProfileDefinition = Readonly<{
  accessClass: DatabaseAccessClass | null;
  mutationPolicyId?: MutationPolicyId;
  mutationTarget: DatabaseMutationTarget | null;
}>;

type OperationDefinition = Omit<
  RecurringDatabaseOperation,
  | "cadenceSource"
  | "compatibility"
  | "incidents"
  | "mutationDisposition"
  | "mutationTarget"
  | "owner"
  | "serviceSource"
  | "timerSource"
> & {
  cadenceSource?: string;
  compatibility?: DatabaseProfileDefinition;
  directory?: string;
  incidents?: readonly IncidentOperation[];
  mutationPolicyId?: MutationPolicyId;
  mutationTarget: DatabaseMutationTarget | null;
  service?: string;
  serviceSource?: string;
  telemetryUnit?: string;
  timer?: string | null;
  timerSource?: string | null;
};

const HERMES_ROOT = "docs/agents/hermes";

type MutationPolicy = Omit<OperationMutationDisposition, "evidenceSource"> & {
  evidenceSource: string;
};

export const DATABASE_MUTATION_POLICIES = {
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
  "due-work.queue-maintenance": {
    evidenceSource: "apps/web/src/lib/server/due-work-cutover.ts",
    kind: "replay-safe-idempotent",
    rationale:
      "Bounded source repair and elapsed-retry promotion converge due_work onto current source truth.",
    reconciliation: "Read the same bounded ready page after repeating maintenance.",
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
  "health.snapshot.compatibility": {
    evidenceSource: "apps/web/src/lib/server/orpc/admin-health.ts",
    kind: "deliberately-non-replayable",
    rationale:
      "The flag-off writer appends random-ID events and samples without an atomic terminal receipt.",
    reconciliation:
      "Inspect the stored snapshot, events, and samples before repeating the request.",
  },
  "live.snapshot": {
    evidenceSource: "apps/web/src/lib/server/live.ts",
    kind: "deliberately-non-replayable",
    rationale:
      "Telegram post, pin, and unpin effects occur before the singleton database upsert and cannot share its transaction.",
    reconciliation:
      "Read the singleton live-state row and stored Telegram message ID, then inspect that one message and pin before replaying the transition.",
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
  "ops.rave-watchdog": {
    evidenceSource: "apps/ssh/watchdog/fluncle-rave-watchdog.sh",
    kind: "deliberately-non-replayable",
    rationale: "External probes and alerts cannot share the health database transaction.",
    reconciliation: "Inspect the watchdog state and current service health before rerunning it.",
  },
  "ops.sonar-freshen": {
    evidenceSource: "apps/sonar/deploy/fluncle-sonar-freshen.sh",
    kind: "deliberately-non-replayable",
    rationale: "Binary download, smoke, swap, and restart cannot share a database transaction.",
    reconciliation: "Inspect the published and running release before rerunning deployment.",
  },
  "ops.ssh-freshen": {
    evidenceSource: "apps/ssh/deploy/fluncle-ssh-freshen.sh",
    kind: "deliberately-non-replayable",
    rationale: "Repository sync, build, swap, and restart cannot share a database transaction.",
    reconciliation: "Inspect the source and running release before rerunning deployment.",
  },
  "reach.collect": {
    evidenceSource: "apps/web/src/lib/server/platform-stats.ts",
    kind: "replay-safe-idempotent",
    rationale:
      "Snapshot rows use deterministic platform, metric, and UTC-day IDs with conflict suppression.",
    reconciliation:
      "Read that UTC day's platform/metric rows; replay only inserts identities still absent.",
  },
  "render.conductor": {
    evidenceSource: "docs/agents/hermes/scripts/render-conductor.sh",
    kind: "deliberately-non-replayable",
    rationale:
      "Render-box provision, trigger, and park effects cannot share the due-work queue maintenance transaction.",
    reconciliation:
      "Inspect the bounded queue item and the conductor's single render-box state before replaying the tick.",
  },
  "social.capture": {
    evidenceSource: "apps/web/src/lib/server/orpc/admin-social.ts",
    kind: "deliberately-non-replayable",
    rationale:
      "The fill-empty URL write removes a post from the worklist before its external release-ID link and TikTok status update complete.",
    reconciliation:
      "Inspect the bounded post row, its Postiz release-ID link, and its TikTok status before recapturing that item.",
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
  "sonar.service": {
    evidenceSource: "apps/sonar/src/consumer.rs",
    kind: "replay-safe-idempotent",
    rationale:
      "Replica reconciliation replaces durable local state by checkpoint and publishes only a validated generation.",
    reconciliation:
      "Restart from the durable checkpoint; the last good local generation remains servable.",
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

export type MutationPolicyId = keyof typeof DATABASE_MUTATION_POLICIES;

/** Every concrete recurring mutation trigger maps explicitly to its own mutation policy. */
export const TRIGGER_MUTATION_POLICY_IDS = {
  "analytics.funnel-snapshot": "analytics.funnel-snapshot",
  "artist.resolve": "artist.resolve",
  "backfill.apple-catalogue": "backfill.vendor-sweep",
  "backfill.apple-music": "backfill.vendor-sweep",
  "backfill.artist-credits": "backfill.artist-credits",
  "backfill.artist-edges": "backfill.artist-edges",
  "backfill.artist-images": "artist.resolve",
  "backfill.beatport": "backfill.vendor-sweep",
  "backfill.cover-masters.album": "backfill.cover-masters",
  "backfill.cover-masters.artist": "backfill.cover-masters",
  "backfill.deezer": "backfill.vendor-sweep",
  "backfill.discogs": "backfill.vendor-sweep",
  "backfill.discogs-facts": "backfill.vendor-sweep",
  "backfill.label-images": "backfill.label-images",
  "backfill.label-lineage": "backfill.label-lineage",
  "backfill.lastfm": "backfill.vendor-sweep",
  "backfill.recording-mbids": "backfill.recording-mbids",
  "bio.album.describe": "bio.album",
  "bio.album.queue": "due-work.queue-maintenance",
  "bio.artist.describe": "bio.artist",
  "bio.artist.queue": "due-work.queue-maintenance",
  "bio.label.describe": "bio.label",
  "bio.label.queue": "due-work.queue-maintenance",
  "catalogue.anchor.queue": "due-work.queue-maintenance",
  "catalogue.anchor.resolve": "catalogue.anchor",
  "catalogue.anchor.search": "catalogue.anchor",
  "catalogue.crawl": "catalogue.crawl",
  "catalogue.demand": "catalogue.demand",
  "catalogue.isrc-recovery.queue": "due-work.queue-maintenance",
  "catalogue.isrc-recovery.resolve": "catalogue.isrc-recovery",
  "catalogue.label-releases": "catalogue.label-releases",
  "catalogue.rank": "catalogue.rank",
  "catalogue.reconcile-hub-counts": "catalogue.reconcile-hub-counts",
  "catalogue.verify-captures.queue": "due-work.queue-maintenance",
  "catalogue.verify-captures.write": "catalogue.verify-captures",
  "clips.cut": "clips.studio",
  "device.mirror": "device.mirror",
  "frontier.refresh": "frontier.refresh",
  "galaxies.map.write": "galaxies.cluster",
  "health.snapshot": "health.snapshot",
  "live.snapshot": "live.snapshot",
  "logbook.create": "logbook.draft",
  "newsletter.draft": "newsletter.draft",
  "reach.collect": "reach.collect",
  "render.tracks.queue-read": "due-work.queue-maintenance",
  "social.capture": "social.capture",
  "social.metrics": "social.metrics",
  "social.publish-advance": "social.publish-advance",
  "sonar.service": "sonar.service",
  "submissions.triage": "submissions.triage",
  "track.capture.queue": "due-work.queue-maintenance",
  "track.capture.write": "track.capture",
  "track.context.fill": "track.context",
  "track.context.queue": "due-work.queue-maintenance",
  "track.embed.queue": "due-work.queue-maintenance",
  "track.enrich.catalogue-queue": "due-work.queue-maintenance",
  "track.enrich.queue": "due-work.queue-maintenance",
  "track.note.queue": "due-work.queue-maintenance",
  "track.note.write": "track.note",
  "track.observe.queue": "due-work.queue-maintenance",
  "track.observe.write": "track.observe",
  "track.update.analysis": "track.enrich",
  "track.update.embedding": "track.embed",
  "track.update.galaxy": "galaxies.cluster",
} as const satisfies Record<string, MutationPolicyId>;

export const INCIDENT_MUTATION_POLICIES = {
  fillEmptyAlbumBio: {
    kind: "replay-safe-idempotent",
    rationale: "The fill-empty predicate cannot overwrite an existing album bio.",
    reconciliation: "Read the album bio before repeating the fill.",
  },
  listDeezerWork: {
    kind: "not-applicable",
    rationale: "The function is a read-only bounded worklist and has no effect to duplicate.",
    reconciliation: "Read the same bounded worklist again.",
  },
  markResolved: {
    kind: "replay-safe-idempotent",
    rationale:
      "Resolved MBID uses non-clobbering coalesce; only the attempt timestamp may refresh.",
    reconciliation: "Read the recording MBID before repeating the resolution stamp.",
  },
  rearmStaleAllowedArtists: {
    kind: "replay-safe-idempotent",
    rationale: "Only allowed rows without the current rearm stamp are changed.",
    reconciliation: "Read the artist's rearm stamp before repeating the bounded rearm.",
  },
  stripCrawlerPrefixes: {
    kind: "replay-safe-idempotent",
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

export function mutationDispositionForPolicy(policyId: string): OperationMutationDisposition {
  const policy = DATABASE_MUTATION_POLICIES[policyId as MutationPolicyId];
  if (policy === undefined) {
    throw new Error(`database mutation policy ${policyId} is not registered`);
  }

  return policy;
}

export function triggerMutationPolicyId(operationId: string): MutationPolicyId {
  const policyId =
    TRIGGER_MUTATION_POLICY_IDS[operationId as keyof typeof TRIGGER_MUTATION_POLICY_IDS];
  if (policyId === undefined) {
    throw new Error(`mutating trigger ${operationId} has no mutation policy mapping`);
  }
  return policyId;
}

function profile(
  operationId: string,
  definition: DatabaseProfileDefinition,
  evidenceSource: string,
  fallbackPolicyId?: MutationPolicyId,
): OperationDatabaseProfile {
  const mutationTarget = definition.mutationTarget;

  if (definition.accessClass === "write" && mutationTarget === null) {
    throw new Error(`write operation ${operationId} has no mutation target`);
  }
  if (mutationTarget === "primary" && definition.accessClass !== "write") {
    throw new Error(`primary mutation ${operationId} must have write access`);
  }

  const policyId =
    mutationTarget === null
      ? definition.mutationPolicyId
      : (definition.mutationPolicyId ?? fallbackPolicyId);
  if (mutationTarget === null) {
    if (policyId !== undefined) {
      throw new Error(`non-mutating operation ${operationId} declares mutation policy ${policyId}`);
    }
    return {
      accessClass: definition.accessClass,
      mutationDisposition: makeMutationDisposition("not-applicable", evidenceSource),
      mutationTarget,
    };
  }
  if (policyId === undefined) {
    throw new Error(`mutating operation ${operationId} has no mutation policy`);
  }

  return {
    accessClass: definition.accessClass,
    mutationDisposition: mutationDispositionForPolicy(policyId),
    mutationTarget,
  };
}

function incident(
  functionName: string,
  operationId: string,
  accessClass: DatabaseAccessClass,
  source: string,
): IncidentOperation {
  const policy =
    INCIDENT_MUTATION_POLICIES[functionName as keyof typeof INCIDENT_MUTATION_POLICIES];
  if (policy === undefined) {
    throw new Error(`incident function ${functionName} has no mutation policy`);
  }

  if (
    (accessClass === "write" && policy.kind !== "replay-safe-idempotent") ||
    (accessClass !== "write" && policy.kind !== "not-applicable")
  ) {
    throw new Error(`incident function ${functionName} has an incompatible mutation policy`);
  }

  return {
    accessClass,
    functionName,
    mutationDisposition: {
      evidenceSource: source,
      ...policy,
    },
    operationId,
    source,
  };
}

function defineOperation(definition: OperationDefinition): RecurringDatabaseOperation {
  const timer =
    definition.timer === null ? null : (definition.timer ?? `${definition.telemetryUnit}.timer`);
  const service = definition.service ?? timer?.replace(/\.timer$/, ".service");
  if (service === undefined) {
    throw new Error(`recurring operation ${definition.operationId} has no service owner`);
  }
  const directory = definition.directory ? `${HERMES_ROOT}/${definition.directory}` : undefined;
  const serviceSource =
    definition.serviceSource ?? (directory ? `${directory}/${service}` : undefined);
  const timerSource =
    timer === null
      ? null
      : (definition.timerSource ?? (directory ? `${directory}/${timer}` : undefined));
  if (serviceSource === undefined || timerSource === undefined) {
    throw new Error(`recurring operation ${definition.operationId} has no unit sources`);
  }
  const cadenceSource = definition.cadenceSource ?? timerSource;
  if (cadenceSource === null) {
    throw new Error(`recurring operation ${definition.operationId} has no cadence source`);
  }
  const operationProfile = profile(
    definition.operationId,
    {
      accessClass: definition.accessClass,
      mutationPolicyId: definition.mutationPolicyId,
      mutationTarget: definition.mutationTarget,
    },
    definition.wrapperSource,
    definition.operationId as MutationPolicyId,
  );
  const compatibility = definition.compatibility
    ? profile(
        definition.operationId,
        definition.compatibility,
        definition.wrapperSource,
        definition.operationId as MutationPolicyId,
      )
    : undefined;

  return {
    ...operationProfile,
    cadence: definition.cadence,
    cadenceSource,
    ...(compatibility ? { compatibility } : {}),
    heavy: definition.heavy,
    incidents: definition.incidents ?? [],
    operationId: definition.operationId,
    owner: {
      service,
      telemetryUnit: definition.telemetryUnit ?? service.replace(/\.service$/, ""),
      timer,
    },
    serviceSource,
    timerSource,
    triggers: definition.triggers,
    wrapperSource: definition.wrapperSource,
  };
}

type TriggerOptions = Readonly<{
  compatibility?: DatabaseProfileDefinition;
  mutationPolicyId?: MutationPolicyId;
  mutationTarget: DatabaseMutationTarget | null;
}>;

function triggerProfile(
  operationId: string,
  accessClass: DatabaseAccessClass | null,
  source: string,
  options: TriggerOptions,
): Pick<
  OperationTrigger,
  "accessClass" | "compatibility" | "mutationDisposition" | "mutationTarget"
> {
  const definition = {
    accessClass,
    mutationPolicyId: options.mutationPolicyId,
    mutationTarget: options.mutationTarget,
  };
  const mutationTarget = definition.mutationTarget;
  const finalProfile = profile(
    operationId,
    definition,
    source,
    mutationTarget === null ? undefined : triggerMutationPolicyId(operationId),
  );
  const compatibility = options.compatibility
    ? profile(
        operationId,
        options.compatibility,
        source,
        options.compatibility.mutationTarget === null
          ? undefined
          : triggerMutationPolicyId(operationId),
      )
    : undefined;

  return { ...finalProfile, ...(compatibility ? { compatibility } : {}) };
}

function cli(
  operationId: string,
  accessClass: DatabaseAccessClass | null,
  route: readonly string[],
  target: string,
  source: string,
  options: TriggerOptions,
): OperationTrigger {
  return {
    ...triggerProfile(operationId, accessClass, source, options),
    cliRoute: route,
    kind: "cli",
    operationId,
    source,
    target,
  };
}

function endpoint(
  operationId: string,
  accessClass: DatabaseAccessClass | null,
  method: "GET" | "PATCH" | "POST" | "PUT",
  path: string,
  source: string,
  options: TriggerOptions,
): OperationTrigger {
  return {
    ...triggerProfile(operationId, accessClass, source, options),
    kind: "worker-endpoint",
    operationId,
    source,
    target: `${method} ${path}`,
  };
}

function direct(
  operationId: string,
  accessClass: DatabaseAccessClass | null,
  target: string,
  source: string,
  options: TriggerOptions,
): OperationTrigger {
  return {
    ...triggerProfile(operationId, accessClass, source, options),
    kind: "direct-database",
    operationId,
    source,
    target,
  };
}

function noDatabase(
  operationId: string,
  accessClass: null,
  target: string,
  source: string,
  options: TriggerOptions,
): OperationTrigger {
  return {
    ...triggerProfile(operationId, accessClass, source, options),
    kind: "no-database",
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
  kind: "timer",
  onBootSec,
  onUnitActiveSec,
  persistent,
  ...(randomizedDelaySec ? { randomizedDelaySec } : {}),
});

const calendar = (
  onCalendar: string,
  randomizedDelaySec = "60",
  persistent = true,
): OperationCadence => ({ kind: "timer", onCalendar, persistent, randomizedDelaySec });

const daemon = (
  environment: string,
  defaultSeconds: number,
  reconcileEnvironment: string,
  reconcileDefaultSeconds: number,
): OperationCadence => ({
  interval: { defaultSeconds, environment },
  kind: "daemon",
  persistent: true,
  reconcileInterval: {
    defaultSeconds: reconcileDefaultSeconds,
    environment: reconcileEnvironment,
  },
});

const SCRIPTS = `${HERMES_ROOT}/scripts`;

const DUE_WORK_FLAG_OFF_COMPATIBILITY: DatabaseProfileDefinition = {
  accessClass: "read",
  mutationTarget: null,
};

const HEALTH_RECEIPT_FLAG_OFF_COMPATIBILITY: DatabaseProfileDefinition = {
  accessClass: "write",
  mutationPolicyId: "health.snapshot.compatibility",
  mutationTarget: "primary",
};

/**
 * Complete roster of recurring database-touching timers and continuous daemons
 * across the Hermes and satellite deployment/watchdog roots. The classification
 * describes each operation's product-database effect; the standard run-ledger
 * receipt is telemetry and deliberately does not turn a no-database operation into a write.
 */
export const DATABASE_OPERATION_REGISTRY: readonly RecurringDatabaseOperation[] = [
  defineOperation({
    accessClass: "write",
    cadence: every("9min", "30min"),
    directory: "album-bio-timer",
    heavy: false,
    incidents: [
      incident(
        "fillEmptyAlbumBio",
        "bio.album.describe",
        "write",
        "apps/web/src/lib/server/albums.ts",
      ),
    ],
    mutationTarget: "primary",
    operationId: "bio.album",
    service: "fluncle-album-bio.service",
    telemetryUnit: "album-bio",
    timer: "fluncle-album-bio.timer",
    triggers: [
      cli(
        "bio.album.queue",
        "write",
        ["admin", "albums", "describe"],
        "fluncle admin albums describe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "bio.album.draft",
        "read",
        ["admin", "albums", "draft-bio"],
        "fluncle admin albums draft-bio <slug> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "bio.album.describe",
        "write",
        ["admin", "albums", "describe"],
        "fluncle admin albums describe <slug> --bio-file <file> --prompt-version <version> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/album-bio-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "1h"),
    directory: "anchor-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "catalogue.anchor",
    service: "fluncle-anchor.service",
    telemetryUnit: "anchor",
    timer: "fluncle-anchor.timer",
    triggers: [
      endpoint(
        "catalogue.anchor.queue",
        "write",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/anchor-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      endpoint(
        "catalogue.anchor.search",
        "write",
        "POST",
        "/api/v1/admin/catalogue/anchor",
        `${SCRIPTS}/anchor-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      endpoint(
        "catalogue.anchor.resolve",
        "write",
        "POST",
        "/api/v1/admin/catalogue/anchor/resolve",
        `${SCRIPTS}/anchor-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/anchor-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("5min", "30min"),
    directory: "artist-bio-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "bio.artist",
    service: "fluncle-artist-bio.service",
    telemetryUnit: "artist-bio",
    timer: "fluncle-artist-bio.timer",
    triggers: [
      cli(
        "bio.artist.queue",
        "write",
        ["admin", "artists", "describe"],
        "fluncle admin artists describe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "bio.artist.draft",
        "read",
        ["admin", "artists", "draft-bio"],
        "fluncle admin artists draft-bio <slug> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "bio.artist.describe",
        "write",
        ["admin", "artists", "describe"],
        "fluncle admin artists describe <slug> --bio-file <file> --prompt-version <version> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-bio-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("4min", "5min"),
    directory: "artist-credits-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "backfill.artist-credits",
    service: "fluncle-artist-credits.service",
    telemetryUnit: "artist-credits",
    timer: "fluncle-artist-credits.timer",
    triggers: [
      cli(
        "backfill.artist-credits",
        "write",
        ["admin", "backfills", "artist-credits"],
        "fluncle admin backfills artist-credits --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-credits-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-credits-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("17min", "60min"),
    directory: "artist-edges-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "backfill.artist-edges",
    service: "fluncle-artist-edges.service",
    telemetryUnit: "artist-edges",
    timer: "fluncle-artist-edges.timer",
    triggers: [
      cli(
        "backfill.artist-edges",
        "write",
        ["admin", "backfills", "artist-edges"],
        "fluncle admin backfills artist-edges --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-edges-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-edges-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("7min", "60min"),
    directory: "artist-sweep-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "artist.resolve",
    service: "fluncle-artist-sweep.service",
    telemetryUnit: "artist-sweep",
    timer: "fluncle-artist-sweep.timer",
    triggers: [
      cli(
        "artist.resolve.queue",
        "read",
        ["admin", "artists", "resolve"],
        "fluncle admin artists resolve --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "artist.resolve",
        "write",
        ["admin", "artists", "resolve"],
        "fluncle admin artists resolve <id> --json",
        `${SCRIPTS}/artist-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "backfill.artist-images",
        "write",
        ["admin", "backfills", "artist-images"],
        "fluncle admin backfills artist-images --limit <bounded-limit> --json",
        `${SCRIPTS}/artist-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/artist-sweep.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*-*-* 05:00:00 Europe/Amsterdam"),
    directory: "audit-review-timer",
    heavy: false,
    mutationTarget: null,
    operationId: "ops.audit-review",
    service: "fluncle-audit-review.service",
    telemetryUnit: "audit-review",
    timer: "fluncle-audit-review.timer",
    triggers: [
      noDatabase(
        "ops.audit-review",
        null,
        "review the newest audit pull request",
        `${SCRIPTS}/audit-review-sweep.sh`,
        { mutationTarget: null },
      ),
    ],
    wrapperSource: `${SCRIPTS}/audit-review-sweep.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*-*-* 01:00:00 Europe/Amsterdam"),
    directory: "audit-timer",
    heavy: false,
    mutationTarget: null,
    operationId: "ops.audit",
    service: "fluncle-audit.service",
    telemetryUnit: "audit",
    timer: "fluncle-audit.timer",
    triggers: [
      noDatabase(
        "ops.audit",
        null,
        "run the nightly repository audit",
        `${SCRIPTS}/audit-sweep.sh`,
        { mutationTarget: null },
      ),
    ],
    wrapperSource: `${SCRIPTS}/audit-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("5min", "30min"),
    directory: "backfill-timer",
    heavy: false,
    incidents: [
      incident("listDeezerWork", "backfill.deezer", "read", "apps/web/src/lib/server/backfill.ts"),
    ],
    mutationTarget: "primary",
    operationId: "backfill.vendor-sweep",
    service: "fluncle-backfill.service",
    telemetryUnit: "backfill",
    timer: "fluncle-backfill.timer",
    triggers: [
      endpoint(
        "backfill.discogs",
        "write",
        "POST",
        "/api/v1/admin/backfill/discogs",
        `${SCRIPTS}/backfill-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "backfill.lastfm",
        "write",
        ["admin", "backfills", "lastfm"],
        "fluncle admin backfills lastfm --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "backfill.apple-music",
        "write",
        ["admin", "backfills", "apple-music"],
        "fluncle admin backfills apple-music --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "backfill.apple-catalogue",
        "write",
        ["admin", "backfills", "apple-catalogue"],
        "fluncle admin backfills apple-catalogue --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "backfill.beatport",
        "write",
        ["admin", "backfills", "beatport"],
        "fluncle admin backfills beatport --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      endpoint(
        "backfill.discogs-facts",
        "write",
        "POST",
        "/api/v1/admin/backfill/discogs-facts",
        `${SCRIPTS}/backfill-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "backfill.deezer",
        "write",
        ["admin", "backfills", "deezer"],
        "fluncle admin backfills deezer --limit <bounded-limit> --json",
        `${SCRIPTS}/backfill-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/backfill-sweep.sh`,
  }),
  defineOperation({
    accessClass: "heavy-read",
    cadence: calendar("*-*-* 03:00:00 Europe/Amsterdam"),
    directory: "backup-timer",
    heavy: true,
    mutationTarget: null,
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
        { mutationTarget: null },
      ),
    ],
    wrapperSource: `${SCRIPTS}/backup-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("3min", "5min"),
    directory: "capture-timer",
    heavy: true,
    mutationTarget: "primary",
    operationId: "track.capture",
    service: "fluncle-capture.service",
    telemetryUnit: "capture",
    timer: "fluncle-capture.timer",
    triggers: [
      endpoint(
        "track.capture.queue",
        "write",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/capture-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      endpoint(
        "track.capture.write",
        "write",
        "PATCH",
        "/api/v1/admin/tracks/{trackId}",
        `${SCRIPTS}/capture-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/capture-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 02:20:00 Europe/Amsterdam"),
    directory: "cluster-timer",
    heavy: true,
    mutationTarget: "primary",
    operationId: "galaxies.cluster",
    service: "fluncle-cluster.service",
    telemetryUnit: "cluster",
    timer: "fluncle-cluster.timer",
    triggers: [
      cli(
        "galaxies.map.read",
        "read",
        ["admin", "galaxies", "map"],
        "fluncle admin galaxies map --json",
        `${SCRIPTS}/cluster-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "galaxies.embeddings.read",
        "heavy-read",
        ["admin", "galaxies", "embeddings"],
        "fluncle admin galaxies embeddings --cursor <cursor> --json",
        `${SCRIPTS}/cluster-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "galaxies.map.write",
        "write",
        ["admin", "galaxies", "set-map"],
        "fluncle admin galaxies set-map --file <file> --json",
        `${SCRIPTS}/cluster-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "track.update.galaxy",
        "write",
        ["admin", "tracks", "update"],
        "fluncle admin tracks update <id> --galaxy-id <id> --json",
        `${SCRIPTS}/cluster-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/cluster-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("2min", "5min"),
    directory: "context-note-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "track.context",
    service: "fluncle-context-note.service",
    telemetryUnit: "context-note",
    timer: "fluncle-context-note.timer",
    triggers: [
      cli(
        "track.context.queue",
        "write",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/context-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "track.context.fill",
        "write",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context <id> --json",
        `${SCRIPTS}/context-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/context-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "60min"),
    directory: "cover-masters-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "backfill.cover-masters",
    service: "fluncle-cover-masters.service",
    telemetryUnit: "cover-masters",
    timer: "fluncle-cover-masters.timer",
    triggers: [
      cli(
        "backfill.cover-masters.album",
        "write",
        ["admin", "backfills", "cover-masters"],
        "fluncle admin backfills cover-masters --kind album --limit <bounded-limit> --json",
        `${SCRIPTS}/cover-masters-sweep.ts`,
        { mutationTarget: "primary" },
      ),
      cli(
        "backfill.cover-masters.artist",
        "write",
        ["admin", "backfills", "cover-masters"],
        "fluncle admin backfills cover-masters --kind artist --limit <bounded-limit> --json",
        `${SCRIPTS}/cover-masters-sweep.ts`,
        { mutationTarget: "primary" },
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
      incident(
        "rearmStaleAllowedArtists",
        "catalogue.crawl",
        "write",
        "apps/web/src/lib/server/crawl.ts",
      ),
    ],
    mutationTarget: "primary",
    operationId: "catalogue.crawl",
    service: "fluncle-crawl.service",
    telemetryUnit: "crawl",
    timer: "fluncle-crawl.timer",
    triggers: [
      cli(
        "catalogue.crawl",
        "write",
        ["admin", "catalogue", "crawl"],
        "fluncle admin catalogue crawl --limit 60 --json",
        `${SCRIPTS}/crawl-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/crawl-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 04:40:00 Europe/Amsterdam"),
    directory: "demand-timer",
    heavy: true,
    mutationTarget: "primary",
    operationId: "catalogue.demand",
    service: "fluncle-demand.service",
    telemetryUnit: "demand",
    timer: "fluncle-demand.timer",
    triggers: [
      cli(
        "catalogue.demand",
        "write",
        ["admin", "catalogue", "demand"],
        "fluncle admin catalogue demand --json",
        `${SCRIPTS}/demand-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/demand-sweep.sh`,
  }),
  defineOperation({
    accessClass: "heavy-read",
    cadence: every("23min", "1h"),
    directory: "device-mirror-timer",
    heavy: true,
    mutationTarget: "derived-remote",
    operationId: "device.mirror",
    service: "fluncle-device-mirror.service",
    telemetryUnit: "device-mirror",
    timer: "fluncle-device-mirror.timer",
    triggers: [
      direct(
        "device.mirror",
        "heavy-read",
        "diff the source database into the device mirror database",
        `${SCRIPTS}/device-mirror.ts`,
        { mutationTarget: "derived-remote" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/device-mirror.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("3min", "5min"),
    directory: "embed-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "track.embed",
    service: "fluncle-embed.service",
    telemetryUnit: "embed",
    timer: "fluncle-embed.timer",
    triggers: [
      endpoint(
        "track.embed.queue",
        "write",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/embed-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "track.update.embedding",
        "write",
        ["admin", "tracks", "update"],
        "fluncle admin tracks update <id> --embedding-file <file> --json",
        `${SCRIPTS}/embed-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/embed-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("1min", "5min"),
    directory: "enrich-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "track.enrich",
    service: "fluncle-enrich.service",
    telemetryUnit: "enrich",
    timer: "fluncle-enrich.timer",
    triggers: [
      cli(
        "track.enrich.queue",
        "write",
        ["admin", "tracks", "enrich"],
        "fluncle admin tracks enrich --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/enrich-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "track.read",
        "read",
        ["tracks", "get"],
        "fluncle tracks get <id> --json",
        `${SCRIPTS}/enrich-sweep.ts`,
        { mutationTarget: null },
      ),
      endpoint(
        "track.enrich.catalogue-queue",
        "write",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/enrich-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "track.update.analysis",
        "write",
        ["admin", "tracks", "update"],
        "fluncle admin tracks update <id> <analysis-fields> --json",
        `${SCRIPTS}/enrich-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/enrich-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*:0/15"),
    directory: "frontier-refresh-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "frontier.refresh",
    service: "fluncle-frontier-refresh.service",
    telemetryUnit: "frontier-refresh",
    timer: "fluncle-frontier-refresh.timer",
    triggers: [
      cli(
        "frontier.refresh",
        "write",
        ["admin", "frontier", "refresh"],
        "fluncle admin frontier refresh --json",
        `${SCRIPTS}/frontier-refresh-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/frontier-refresh-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 23:45:00 UTC"),
    directory: "funnel-snapshot-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "analytics.funnel-snapshot",
    service: "fluncle-funnel-snapshot.service",
    telemetryUnit: "funnel-snapshot",
    timer: "fluncle-funnel-snapshot.timer",
    triggers: [
      endpoint(
        "analytics.funnel-snapshot",
        "write",
        "POST",
        "/api/v1/admin/funnel/snapshot",
        `${SCRIPTS}/funnel-snapshot-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/funnel-snapshot-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("2min", "10min"),
    compatibility: {
      accessClass: "write",
      mutationPolicyId: "health.snapshot.compatibility",
      mutationTarget: "primary",
    },
    directory: "healthcheck-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "health.snapshot",
    service: "fluncle-healthcheck.service",
    telemetryUnit: "healthcheck",
    timer: "fluncle-healthcheck.timer",
    triggers: [
      endpoint("health.web", "read", "GET", "/api/v1/health", `${SCRIPTS}/fluncle-healthcheck.ts`, {
        mutationTarget: null,
      }),
      endpoint(
        "health.database",
        "read",
        "GET",
        "/api/v1/status",
        `${SCRIPTS}/fluncle-healthcheck.ts`,
        { mutationTarget: null },
      ),
      endpoint(
        "health.snapshot",
        "write",
        "POST",
        "/api/v1/admin/health",
        `${SCRIPTS}/fluncle-healthcheck.ts`,
        {
          compatibility: HEALTH_RECEIPT_FLAG_OFF_COMPATIBILITY,
          mutationTarget: "primary",
        },
      ),
    ],
    wrapperSource: `${SCRIPTS}/fluncle-healthcheck.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("12min", "1h"),
    directory: "isrc-recovery-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "catalogue.isrc-recovery",
    service: "fluncle-isrc-recovery.service",
    telemetryUnit: "isrc-recovery",
    timer: "fluncle-isrc-recovery.timer",
    triggers: [
      endpoint(
        "catalogue.isrc-recovery.queue",
        "write",
        "GET",
        "/api/v1/admin/tracks/work",
        `${SCRIPTS}/isrc-recovery-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      endpoint(
        "catalogue.isrc-recovery.resolve",
        "write",
        "POST",
        "/api/v1/admin/catalogue/anchor/resolve",
        `${SCRIPTS}/isrc-recovery-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/isrc-recovery-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("7min", "30min"),
    directory: "label-bio-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "bio.label",
    service: "fluncle-label-bio.service",
    telemetryUnit: "label-bio",
    timer: "fluncle-label-bio.timer",
    triggers: [
      cli(
        "bio.label.queue",
        "write",
        ["admin", "labels", "describe"],
        "fluncle admin labels describe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "bio.label.draft",
        "read",
        ["admin", "labels", "draft-bio"],
        "fluncle admin labels draft-bio <slug> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "bio.label.describe",
        "write",
        ["admin", "labels", "describe"],
        "fluncle admin labels describe <slug> --bio-file <file> --prompt-version <version> --json",
        `${SCRIPTS}/entity-bio-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-bio-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("8min", "60min"),
    directory: "label-images-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "backfill.label-images",
    service: "fluncle-label-images.service",
    telemetryUnit: "label-images",
    timer: "fluncle-label-images.timer",
    triggers: [
      cli(
        "backfill.label-images",
        "write",
        ["admin", "backfills", "label-images"],
        "fluncle admin backfills label-images --limit <bounded-limit> --json",
        `${SCRIPTS}/label-images-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-images-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("13min", "60min"),
    directory: "label-lineage-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "backfill.label-lineage",
    service: "fluncle-label-lineage.service",
    telemetryUnit: "label-lineage",
    timer: "fluncle-label-lineage.timer",
    triggers: [
      cli(
        "backfill.label-lineage",
        "write",
        ["admin", "backfills", "label-lineage"],
        "fluncle admin backfills label-lineage --limit <bounded-limit> --json",
        `${SCRIPTS}/label-lineage-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-lineage-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("23min", "24h"),
    directory: "label-releases-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "catalogue.label-releases",
    service: "fluncle-label-releases.service",
    telemetryUnit: "label-releases",
    timer: "fluncle-label-releases.timer",
    triggers: [
      endpoint(
        "catalogue.label-releases",
        "write",
        "POST",
        "/api/v1/admin/backfill/label-releases",
        `${SCRIPTS}/label-releases-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/label-releases-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("30s", "1min", "90", false),
    directory: "live-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "live.snapshot",
    service: "fluncle-live.service",
    telemetryUnit: "live",
    timer: "fluncle-live.timer",
    triggers: [
      endpoint(
        "live.snapshot",
        "write",
        "POST",
        "/api/v1/admin/twitch/live",
        `${SCRIPTS}/fluncle-live.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/fluncle-live.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 00:40:00 Europe/Amsterdam"),
    directory: "logbook-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "logbook.draft",
    service: "fluncle-logbook.service",
    telemetryUnit: "logbook",
    timer: "fluncle-logbook.timer",
    triggers: [
      cli(
        "logbook.gaps",
        "read",
        ["admin", "logbook", "gaps"],
        "fluncle admin logbook gaps --limit <bounded-limit> --json",
        `${SCRIPTS}/logbook-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "logbook.create",
        "write",
        ["admin", "logbook", "create"],
        "fluncle admin logbook create <sector> --title <title> --body-file <file> --json",
        `${SCRIPTS}/logbook-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/logbook-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("Fri 15:00 Europe/Amsterdam"),
    directory: "newsletter-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "newsletter.draft",
    service: "fluncle-newsletter.service",
    telemetryUnit: "newsletter",
    timer: "fluncle-newsletter.timer",
    triggers: [
      cli(
        "newsletter.list",
        "read",
        ["admin", "newsletter", "list"],
        "fluncle admin newsletter list --json",
        `${SCRIPTS}/newsletter-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "newsletter.draft",
        "write",
        ["admin", "newsletter", "draft"],
        "fluncle admin newsletter draft --content-file <file> --subject <subject> --window-since <iso> --window-until <iso> --json",
        `${SCRIPTS}/newsletter-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/newsletter-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("3min", "10min"),
    directory: "note-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "track.note",
    service: "fluncle-note.service",
    telemetryUnit: "note",
    timer: "fluncle-note.timer",
    triggers: [
      cli(
        "track.note.queue",
        "write",
        ["admin", "tracks", "note"],
        "fluncle admin tracks note --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/note-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "track.read",
        "read",
        ["tracks", "get"],
        "fluncle tracks get <id> --json",
        `${SCRIPTS}/note-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "track.similar",
        "read",
        ["tracks", "similar"],
        "fluncle tracks similar <id> --limit <bounded-limit> --json",
        `${SCRIPTS}/note-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "track.context.read",
        "read",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context <id> --json",
        `${SCRIPTS}/note-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "track.note.write",
        "write",
        ["admin", "tracks", "note"],
        "fluncle admin tracks note <id> --script-file <file> --json",
        `${SCRIPTS}/note-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/note-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("4min", "60min"),
    directory: "observation-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "track.observe",
    service: "fluncle-observation.service",
    telemetryUnit: "observation",
    timer: "fluncle-observation.timer",
    triggers: [
      cli(
        "track.observe.queue",
        "write",
        ["admin", "tracks", "observe"],
        "fluncle admin tracks observe --queue --limit <bounded-limit> --json",
        `${SCRIPTS}/observe-sweep.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "track.read",
        "read",
        ["tracks", "get"],
        "fluncle tracks get <id> --json",
        `${SCRIPTS}/observe-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "track.context.read",
        "read",
        ["admin", "tracks", "context"],
        "fluncle admin tracks context <id> --json",
        `${SCRIPTS}/observe-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "track.observe.write",
        "write",
        ["admin", "tracks", "observe"],
        "fluncle admin tracks observe <id> --script-file <file> --json",
        `${SCRIPTS}/observe-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/observe-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("10min", "1h", "90", true),
    directory: "pin-watch",
    heavy: false,
    mutationTarget: "primary",
    operationId: "ops.pin-watch",
    service: "pin-watch.service",
    telemetryUnit: "pin-watch",
    timer: "pin-watch.timer",
    triggers: [
      endpoint(
        "health.snapshot",
        "write",
        "POST",
        "/api/v1/admin/health",
        `${HERMES_ROOT}/pin-watch/rebuild-hermes.sh`,
        {
          compatibility: HEALTH_RECEIPT_FLAG_OFF_COMPATIBILITY,
          mutationTarget: "primary",
        },
      ),
    ],
    wrapperSource: `${HERMES_ROOT}/pin-watch/rebuild-hermes.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("9min", "30min"),
    directory: "publish-advance-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "social.publish-advance",
    service: "fluncle-publish-advance.service",
    telemetryUnit: "publish-advance",
    timer: "fluncle-publish-advance.timer",
    triggers: [
      endpoint(
        "social.publish-advance",
        "write",
        "POST",
        "/api/v1/admin/social/publish/advance",
        `${SCRIPTS}/publish-advance-sweep.sh`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/publish-advance-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "30min"),
    directory: "rank-timer",
    heavy: true,
    mutationTarget: "primary",
    operationId: "catalogue.rank",
    service: "fluncle-rank.service",
    telemetryUnit: "rank",
    timer: "fluncle-rank.timer",
    triggers: [
      cli(
        "catalogue.rank",
        "write",
        ["admin", "catalogue", "rank"],
        "fluncle admin catalogue rank --limit <bounded-limit> --json",
        `${SCRIPTS}/rank-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/rank-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 04:00:00 Europe/Amsterdam"),
    directory: "reach-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "reach.collect",
    service: "fluncle-reach.service",
    telemetryUnit: "reach",
    timer: "fluncle-reach.timer",
    triggers: [
      cli(
        "reach.collect",
        "write",
        ["admin", "reach", "collect"],
        "fluncle admin reach collect --json",
        `${SCRIPTS}/reach-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/reach-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 04:10:00 Europe/Amsterdam"),
    directory: "reconcile-hub-counts-timer",
    heavy: true,
    mutationTarget: "primary",
    operationId: "catalogue.reconcile-hub-counts",
    service: "fluncle-reconcile-hub-counts.service",
    telemetryUnit: "reconcile-hub-counts",
    timer: "fluncle-reconcile-hub-counts.timer",
    triggers: [
      endpoint(
        "catalogue.reconcile-hub-counts",
        "write",
        "POST",
        "/api/v1/admin/hub-counts/reconcile",
        `${SCRIPTS}/reconcile-hub-counts.ts`,
        { mutationTarget: "primary" },
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
        "write",
        "apps/web/src/lib/server/recording-mbids.ts",
      ),
      incident(
        "markResolved",
        "backfill.recording-mbids",
        "write",
        "apps/web/src/lib/server/recording-mbids.ts",
      ),
    ],
    mutationTarget: "primary",
    operationId: "backfill.recording-mbids",
    service: "fluncle-recording-mbids.service",
    telemetryUnit: "recording-mbids",
    timer: "fluncle-recording-mbids.timer",
    triggers: [
      cli(
        "backfill.recording-mbids",
        "write",
        ["admin", "backfills", "recording-mbids"],
        "fluncle admin backfills recording-mbids --limit <bounded-limit> --json",
        `${SCRIPTS}/recording-mbids-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/recording-mbids-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("9min", "60min"),
    compatibility: { accessClass: "read", mutationTarget: null },
    directory: "render-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "render.conductor",
    service: "fluncle-render.service",
    telemetryUnit: "render",
    timer: "fluncle-render.timer",
    triggers: [
      cli(
        "render.track-read",
        "read",
        ["admin", "tracks", "get"],
        "fluncle admin tracks get <id> --json",
        `${SCRIPTS}/render-conductor.sh`,
        { mutationTarget: null },
      ),
      cli(
        "render.tracks.queue-read",
        "write",
        ["admin", "tracks", "queue"],
        "fluncle admin tracks queue --limit 25 --json",
        `${SCRIPTS}/render-conductor.sh`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      cli(
        "render.vehicles-read",
        "read",
        ["admin", "tracks", "vehicles"],
        "fluncle admin tracks vehicles --json",
        `${SCRIPTS}/render-conductor.sh`,
        { mutationTarget: null },
      ),
    ],
    wrapperSource: `${SCRIPTS}/render-conductor.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: every("1min", "15min", ""),
    directory: "secrets",
    heavy: false,
    mutationTarget: null,
    operationId: "ops.secrets-sync",
    service: "fluncle-secrets-sync.service",
    telemetryUnit: "fluncle-secrets-sync",
    timer: "fluncle-secrets-sync.timer",
    triggers: [
      noDatabase(
        "ops.secrets-sync",
        null,
        "materialize the box secret files",
        `${HERMES_ROOT}/secrets/fluncle-secrets-sync.sh`,
        { mutationTarget: null },
      ),
    ],
    wrapperSource: `${HERMES_ROOT}/secrets/fluncle-secrets-sync.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*-*-* 03:30:00 Europe/Amsterdam"),
    directory: "sentry-triage-timer",
    heavy: false,
    mutationTarget: null,
    operationId: "ops.sentry-triage",
    service: "fluncle-sentry-triage.service",
    telemetryUnit: "sentry-triage",
    timer: "fluncle-sentry-triage.timer",
    triggers: [
      noDatabase(
        "ops.sentry-triage",
        null,
        "triage the Sentry issue queue",
        `${SCRIPTS}/sentry-triage-sweep.ts`,
        { mutationTarget: null },
      ),
    ],
    wrapperSource: `${SCRIPTS}/sentry-triage-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("6min", "10min"),
    directory: "social-capture-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "social.capture",
    service: "fluncle-social-capture.service",
    telemetryUnit: "social-capture",
    timer: "fluncle-social-capture.timer",
    triggers: [
      endpoint(
        "social.capture",
        "write",
        "POST",
        "/api/v1/admin/social/posts/capture",
        `${SCRIPTS}/social-capture-sweep.sh`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/social-capture-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: calendar("*-*-* 22:15:00 UTC"),
    directory: "social-metrics-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "social.metrics",
    service: "fluncle-social-metrics.service",
    telemetryUnit: "social-metrics",
    timer: "fluncle-social-metrics.timer",
    triggers: [
      endpoint(
        "social.metrics",
        "write",
        "POST",
        "/api/v1/admin/social/metrics/record",
        `${SCRIPTS}/social-metrics-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/social-metrics-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("10min", "15min"),
    directory: "studio-clip-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "clips.studio",
    service: "fluncle-studio-clip.service",
    telemetryUnit: "studio-clip",
    timer: "fluncle-studio-clip.timer",
    triggers: [
      cli(
        "clips.pending.read",
        "read",
        ["admin", "clips", "list"],
        "fluncle admin clips list --status pending --json",
        `${SCRIPTS}/clip-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "clips.cut",
        "write",
        ["admin", "clips", "cut"],
        "fluncle admin clips cut <id> --json",
        `${SCRIPTS}/clip-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/clip-sweep.sh`,
  }),
  defineOperation({
    accessClass: null,
    cadence: calendar("*:0/15", "90"),
    directory: "timer-watchdog",
    heavy: false,
    mutationTarget: null,
    operationId: "ops.timer-watchdog",
    service: "fluncle-timer-watchdog.service",
    telemetryUnit: "fluncle-timer-watchdog",
    timer: "fluncle-timer-watchdog.timer",
    triggers: [
      noDatabase(
        "ops.timer-watchdog",
        null,
        "inspect and re-arm stranded systemd timers",
        `${HERMES_ROOT}/timer-watchdog/timer-watchdog.sh`,
        { mutationTarget: null },
      ),
    ],
    wrapperSource: `${HERMES_ROOT}/timer-watchdog/timer-watchdog.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("5min", "15min"),
    directory: "triage-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "submissions.triage",
    service: "fluncle-triage.service",
    telemetryUnit: "triage",
    timer: "fluncle-triage.timer",
    triggers: [
      cli(
        "submissions.list",
        "read",
        ["admin", "submissions"],
        "fluncle admin submissions --json",
        `${SCRIPTS}/triage-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "track.admin-read",
        "read",
        ["admin", "tracks", "get"],
        "fluncle admin tracks get <id> --json",
        `${SCRIPTS}/triage-sweep.ts`,
        { mutationTarget: null },
      ),
      cli(
        "submissions.triage",
        "write",
        ["admin", "submissions", "triage"],
        "fluncle admin submissions triage <id> --verdict-file <file> --json",
        `${SCRIPTS}/triage-sweep.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/triage-sweep.sh`,
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("17min", "30min"),
    directory: "verify-captures-timer",
    heavy: false,
    mutationTarget: "primary",
    operationId: "catalogue.verify-captures",
    service: "fluncle-verify-captures.service",
    telemetryUnit: "verify-captures",
    timer: "fluncle-verify-captures.timer",
    triggers: [
      endpoint(
        "catalogue.verify-captures.queue",
        "write",
        "GET",
        "/api/v1/admin/catalogue/captures/unverified",
        `${SCRIPTS}/verify-captures.ts`,
        { compatibility: DUE_WORK_FLAG_OFF_COMPATIBILITY, mutationTarget: "primary" },
      ),
      endpoint(
        "catalogue.verify-captures.write",
        "write",
        "POST",
        "/api/v1/admin/catalogue/captures/verify",
        `${SCRIPTS}/verify-captures.ts`,
        { mutationTarget: "primary" },
      ),
    ],
    wrapperSource: `${SCRIPTS}/verify-captures.sh`,
  }),
  defineOperation({
    accessClass: "read",
    cadence: daemon("SONAR_DELTA_SECS", 30, "SONAR_RECONCILE_SECS", 3600),
    cadenceSource: "apps/sonar/src/config.rs",
    heavy: false,
    mutationTarget: "derived-local",
    operationId: "sonar.service",
    service: "sonar.service",
    serviceSource: "apps/sonar/deploy/sonar.service",
    telemetryUnit: "sonar-service",
    timer: null,
    timerSource: null,
    triggers: [
      direct(
        "sonar.service",
        "read",
        "sync the primary replica and consume artifacts into the durable local index",
        "apps/sonar/src/main.rs",
        { mutationTarget: "derived-local" },
      ),
    ],
    wrapperSource: "apps/sonar/src/main.rs",
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("11min", "1h", "420"),
    heavy: false,
    mutationTarget: "primary",
    operationId: "ops.sonar-freshen",
    service: "fluncle-sonar-freshen.service",
    serviceSource: "apps/sonar/deploy/fluncle-sonar-freshen.service",
    telemetryUnit: "sonar-freshen",
    timer: "fluncle-sonar-freshen.timer",
    timerSource: "apps/sonar/deploy/fluncle-sonar-freshen.timer",
    triggers: [
      noDatabase(
        "ops.sonar-freshen",
        null,
        "verify and swap the current sonar release",
        "apps/sonar/deploy/fluncle-sonar-freshen.sh",
        { mutationTarget: null },
      ),
      endpoint(
        "health.snapshot",
        "write",
        "POST",
        "/api/v1/admin/health",
        "apps/sonar/deploy/fluncle-sonar-freshen.sh",
        {
          compatibility: HEALTH_RECEIPT_FLAG_OFF_COMPATIBILITY,
          mutationTarget: "primary",
        },
      ),
    ],
    wrapperSource: "apps/sonar/deploy/fluncle-sonar-freshen.sh",
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("5min", "1h"),
    heavy: false,
    mutationTarget: "primary",
    operationId: "ops.ssh-freshen",
    service: "fluncle-ssh-freshen.service",
    serviceSource: "apps/ssh/deploy/fluncle-ssh-freshen.service",
    telemetryUnit: "ssh-freshen",
    timer: "fluncle-ssh-freshen.timer",
    timerSource: "apps/ssh/deploy/fluncle-ssh-freshen.timer",
    triggers: [
      noDatabase(
        "ops.ssh-freshen",
        null,
        "build, verify, and swap the SSH terminal release",
        "apps/ssh/deploy/fluncle-ssh-freshen.sh",
        { mutationTarget: null },
      ),
      endpoint(
        "health.snapshot",
        "write",
        "POST",
        "/api/v1/admin/health",
        "apps/ssh/deploy/fluncle-ssh-freshen.sh",
        {
          compatibility: HEALTH_RECEIPT_FLAG_OFF_COMPATIBILITY,
          mutationTarget: "primary",
        },
      ),
    ],
    wrapperSource: "apps/ssh/deploy/fluncle-ssh-freshen.sh",
  }),
  defineOperation({
    accessClass: "write",
    cadence: every("2min", "10min", "30"),
    heavy: false,
    mutationTarget: "primary",
    operationId: "ops.rave-watchdog",
    service: "fluncle-rave-watchdog.service",
    serviceSource: "apps/ssh/watchdog/fluncle-rave-watchdog.service",
    telemetryUnit: "rave-watchdog",
    timer: "fluncle-rave-watchdog.timer",
    timerSource: "apps/ssh/watchdog/fluncle-rave-watchdog.timer",
    triggers: [
      noDatabase(
        "ops.rave-watchdog",
        null,
        "probe the remote box and Tor surface",
        "apps/ssh/watchdog/fluncle-rave-watchdog.sh",
        { mutationTarget: null },
      ),
      endpoint(
        "health.snapshot",
        "write",
        "POST",
        "/api/v1/admin/health",
        "apps/ssh/watchdog/fluncle-rave-watchdog.sh",
        {
          compatibility: HEALTH_RECEIPT_FLAG_OFF_COMPATIBILITY,
          mutationTarget: "primary",
        },
      ),
    ],
    wrapperSource: "apps/ssh/watchdog/fluncle-rave-watchdog.sh",
  }),
];

const operationByOwner = new Map<string, RecurringDatabaseOperation>();

for (const operation of DATABASE_OPERATION_REGISTRY) {
  const aliases = [
    operation.owner.service,
    operation.owner.service.replace(/\.service$/, ""),
    operation.owner.telemetryUnit,
    ...(operation.owner.timer
      ? [operation.owner.timer, operation.owner.timer.replace(/\.timer$/, "")]
      : []),
  ];

  for (const alias of aliases) {
    operationByOwner.set(alias, operation);
  }
}

export type ResolvedDatabaseOperationOwner = Readonly<{
  accessClass: DatabaseAccessClass | null;
  heavy: boolean;
  heavyRead: boolean;
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
    heavyRead: operation.triggers.some((trigger) => trigger.accessClass === "heavy-read"),
    operationId: operation.operationId,
  };
}
