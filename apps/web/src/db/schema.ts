import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tracks = sqliteTable("tracks", {
  addedAt: text("added_at").notNull(),
  addedToSpotify: integer("added_to_spotify", { mode: "boolean" }).notNull().default(false),
  addedToSpotifyAt: text("added_to_spotify_at"),
  album: text("album"),
  albumImageUrl: text("album_image_url"),
  artistsJson: text("artists_json").notNull(),
  // Per-finding backfill reliability state for the two Worker-paced catalogue
  // sweeps (Discogs release-id resolve, Last.fm love), one column-set per source.
  // The sweeps are best-effort side-channels over already-published findings; this
  // state makes them RESUMABLE and keeps them from re-storming a vendor API:
  //   - *AttemptedAt — ISO of the last attempt; the sweep skips a finding tried
  //     within a cooldown window (the window grows with the failure count, so a
  //     repeatedly-failing finding backs off instead of being retried every tick).
  //   - *Attempts    — total attempts (diagnostic / unbounded-retry guard).
  //   - *Failures    — CONSECUTIVE failures (reset to 0 on success); drives the
  //     exponential backoff window. A done/resolved finding has 0.
  //   - *DoneAt      — ISO when the source completed for this finding (Discogs:
  //     ids written; Last.fm: loved). Set ⇒ the sweep skips it forever (idempotent
  //     no-op). Null until done. All four are null on rows that predate the column.
  backfillDiscogsAttemptedAt: text("backfill_discogs_attempted_at"),
  backfillDiscogsAttempts: integer("backfill_discogs_attempts").notNull().default(0),
  backfillDiscogsDoneAt: text("backfill_discogs_done_at"),
  backfillDiscogsFailures: integer("backfill_discogs_failures").notNull().default(0),
  backfillLastfmAttemptedAt: text("backfill_lastfm_attempted_at"),
  backfillLastfmAttempts: integer("backfill_lastfm_attempts").notNull().default(0),
  backfillLastfmDoneAt: text("backfill_lastfm_done_at"),
  backfillLastfmFailures: integer("backfill_lastfm_failures").notNull().default(0),
  // The auto-note authoring "ran" stamp (the written-note sibling of the observation
  // pipeline). Unlike Discogs/Last.fm this is NOT a vendor sweep — `note_track`
  // (agent tier) stamps `backfill_note_attempted_at` on EVERY authoring attempt and
  // `backfill_note_done_at` only when an empty `note` was actually FILLED. It reuses
  // the same backfill_* column convention purely so the admin board's "done-when-ran"
  // semantics and `listBackfillRanForTracks` machinery work for the Note cell exactly
  // like Discogs/Last.fm: grey/`open` = never run, `done` = the workflow ran (a note
  // exists). The operator override always wins — the handler fills an EMPTY note only,
  // never clobbering an operator-written one, so a hand-written note can carry no
  // attempt stamp and still read `done` off the `note` column itself.
  backfillNoteAttemptedAt: text("backfill_note_attempted_at"),
  backfillNoteAttempts: integer("backfill_note_attempts").notNull().default(0),
  backfillNoteDoneAt: text("backfill_note_done_at"),
  backfillNoteFailures: integer("backfill_note_failures").notNull().default(0),
  bpm: real("bpm"),
  // Firecrawl-derived FACTUAL context about the track (label/year/release
  // context/artist background), gathered during the observe step as CREATIVE
  // FUEL for the observation script and the video agent. Internal only: never
  // rendered on /log, never in JSON-LD/RSS/llms.txt, never quotes lyrics. This
  // is NOT the editorial `note` (the operator's public "why").
  contextNote: text("context_note"),
  // The context-fetch reliability marker (mirrors the backfill_* state above). The
  // `context_track` queue picks `pending` rows (never-attempted); this column lets a
  // CONFIRMED-EMPTY fetch (`empty`) be distinct from never-attempted, so the cron does
  // not re-burn Firecrawl + the distil LLM on a hopeless find every tick. States:
  //   - pending  — never attempted (the default; the queue's pick set).
  //   - resolved — a distilled (or cleaned-raw fallback) note was stored.
  //   - empty    — the fetch returned nothing usable; intentionally left blank. The
  //                queue skips it unless `--retry-empty` widens the pick set.
  //   - failed   — the attempt threw (vendor down); eligible for a later retry.
  // Internal only — never surfaced through public DTOs. Rows that predate the column
  // read NULL and are treated as `pending`.
  contextStatus: text("context_status", {
    enum: ["pending", "resolved", "empty", "failed"],
  }),
  durationMs: integer("duration_ms").notNull(),
  enrichmentStatus: text("enrichment_status").notNull().default("pending"),
  featuresJson: text("features_json"),
  // The Discogs release the finding resolves to (read-only enrichment, best-effort,
  // matched by artist + title since Discogs has no ISRC search). inMasterId is the
  // master that groups a release's versions (Discogs returns it on the search hit);
  // inReleaseId is the specific release. The `discogs.com/release/{inReleaseId}` URL
  // is a per-finding `sameAs` for the track (distinct from the artist-level sameAs).
  // Both null until a confident match writes them on add. See docs/track-lifecycle.md.
  inMasterId: integer("in_master_id"),
  inReleaseId: integer("in_release_id"),
  isrc: text("isrc"),
  key: text("key"),
  label: text("label"),
  logId: text("log_id").unique(),
  note: text("note"),
  // Word-level caption timings for the spoken observation, as a JSON string
  // (`{ source, words: [{ text, startMs, endMs }] }` — see lib/server/observation.ts
  // `ObservationAlignment`). Drives the synced subtitles on the radio player (and,
  // later, /log): the current word is highlighted off `audio.currentTime`. Captured
  // at render time from Cartesia's word timestamps (a retired one-off `/forced-alignment`
  // backfill seeded older rows). Internal-but-PUBLIC: unlike the script, the
  // word timings ARE surfaced (the public TrackListItem carries them so the radio
  // caption render can read them), but they describe an EXISTING artifact, so writing
  // them does NOT bump updated_at (a backfill must move no public lastmod).
  observationAlignmentJson: text("observation_alignment_json"),
  // The audio observation (Fluncle's recovered field observation, spoken).
  // observationAudioUrl is the R2 read URL for <log-id>/observation.mp3 — set
  // when the render is uploaded; its presence is the "has observation" flag. The
  // script (observation.txt) and the structured artifact + render metadata
  // (observation.json) live by CONVENTION at <log-id>/<name> with no column,
  // exactly like poster.jpg / footage-silent.mp4 (see lib/media.ts).
  observationAudioUrl: text("observation_audio_url"),
  observationDurationMs: integer("observation_duration_ms"),
  observationGeneratedAt: text("observation_generated_at"),
  // The spoken observation SCRIPT — the voice-gated prose the agent authored and
  // passed to the observe render. It already lives
  // in the R2 `observation.json` (field `text`) + `observation.txt`; this column
  // mirrors it on the row so the admin observation dialog can show the transcript
  // without an R2 round-trip, and (future) radio.fluncle.com can render line-by-line
  // subtitles synced over the video. Internal like `context_note`: never on the
  // public TrackListItem contract — surfaced only through the admin-only board path.
  observationScript: text("observation_script"),
  popularity: integer("popularity"),
  postedToTelegram: integer("posted_to_telegram", { mode: "boolean" }).notNull().default(false),
  postedToTelegramAt: text("posted_to_telegram_at"),
  // Operator-only archive path for the one official 30s preview preserved for
  // private analysis/model training. Never exposed through public DTOs and
  // never used by /api/preview playback.
  previewArchiveKey: text("preview_archive_key"),
  previewArchiveMime: text("preview_archive_mime"),
  previewArchiveSource: text("preview_archive_source"),
  previewArchivedAt: text("preview_archived_at"),
  previewUrl: text("preview_url"),
  releaseDate: text("release_date"),
  spotifyError: text("spotify_error"),
  spotifyUri: text("spotify_uri").notNull(),
  spotifyUrl: text("spotify_url").notNull(),
  telegramError: text("telegram_error"),
  title: text("title").notNull(),
  trackId: text("track_id").primaryKey(),
  // Last content change to the finding's record: every write path (publish,
  // curation/enrichment update, social-post state) bumps it. Null for rows that
  // predate the column; readers fall back to added_at (sitemap lastmod).
  updatedAt: text("updated_at"),
  // The finding's place in vibe-space (the admin tagging map; see
  // docs/admin-tagging.md): vibeX = Light(-1)↔Dark(+1) mood, vibeY =
  // Floaty(-1)↔Driving(+1) energy, each roughly -1..1. The quadrant is the
  // finding's galaxy (Solar/Nebular/Lunar/Deep). Null = not yet placed; the
  // operator drops it on the map. Replaces sub-genre tags as the grouping.
  vibeX: real("vibe_x"),
  vibeY: real("vibe_y"),
  // The grain FAMILY of the track's video (e.g. "grainCoarseSilver"). Set when the
  // video is uploaded; surfaced in /api/tracks beside the vehicle so the next agent
  // reads recent grain families and diversifies (the grain ledger).
  videoGrain: text("video_grain"),
  // The AI model that authored the track's video, in <provider>/<model> notation
  // (e.g. "anthropic/claude-opus-4-8"). Set when the video is uploaded; surfaced
  // in /api/tracks alongside the vehicle. Defaults so existing rows backfill.
  videoModel: text("video_model").default("anthropic/claude-opus-4-8"),
  // The reasoning/thinking effort the authoring model ran at (e.g. "high",
  // "medium", "low"). Set when the video is uploaded; surfaced in /api/tracks so
  // we can compare model × thinking level. Defaults to "high" — the existing
  // videos were authored at high reasoning, so existing rows backfill.
  videoModelReasoning: text("video_model_reasoning").default("high"),
  // The two-master video layout signal (see docs/video-variants.md). NON-NULL once
  // the SQUARE crop source has been uploaded as footage.mp4 — i.e. this finding's
  // footage.mp4 is now the clean 1920×1920 master MT crops on the fly, and a baked
  // portrait footage.social.mp4 rides alongside. NULL = the legacy single-file
  // layout (footage.mp4 is still the old portrait+text cut); consumers fall back to
  // today's behavior. Set by the video finalize/upload path, never by the
  // footage.mp4 → footage.social.mp4 R2 rename migration (that copy alone doesn't
  // make footage.mp4 square). The presence of the timestamp is the only thing read.
  videoSquaredAt: text("video_squared_at"),
  videoUrl: text("video_url"),
  // The travelling vehicle of the track's video (e.g. "voronoi cellular",
  // "caustic web"). Set when the video is uploaded; surfaced in /api/tracks so
  // the next (ephemeral) video agent can read recent vehicles and diversify.
  videoVehicle: text("video_vehicle"),
});

// The radio.fluncle.com shared-schedule anchor (RFC radio-broadcast.md, Unit A).
// ONE row (PK = service = "radio") holding the wall-clock `epoch` the modulo
// schedule is measured from and the `version` fingerprint of the eligible set it
// was computed for (`${count}:${maxObservationGeneratedAt}`). The broadcast is a
// pure function of (deterministic eligible list, per-segment duration, epoch):
// `p = (now − epoch) mod T`. The stored epoch is the ONE thing a pure function
// can't derive — *when* a catalogue change takes effect. When the eligible set
// changes (`version` no longer matches the live fingerprint), `now-playing`
// rolls the epoch forward to the next loop boundary (`epoch += ⌈(now−epoch)/T⌉·T`)
// and rewrites this row, so a grown catalogue applies at the seam and no current
// listener's playhead jumps. This is a lazy self-heal on the READ path — the
// eligibility-changing agent writes (observe / square backfill) never touch it.
export const radioSchedule = sqliteTable("radio_schedule", {
  // The wall-clock anchor (ms since epoch) the modulo schedule is measured from.
  epochMs: integer("epoch_ms").notNull(),
  // When this row was last (re)computed — provenance for the boundary roll.
  generatedAt: text("generated_at").notNull(),
  // Single-row table: a fixed PK so the row is upserted, never duplicated.
  service: text("service").primaryKey(),
  // The eligible-set fingerprint this epoch was computed for:
  // `${count}:${maxObservationGeneratedAt}`. A mismatch with the live fingerprint
  // is the "the schedule changed" trigger.
  version: text("version").notNull(),
});

// The public status dashboard's current-state snapshot — ONE row per probed
// service (PK = `service`, so each check upserts its single row, the
// `radio_schedule`/`spotify_auth` single-row precedent). A Hermes cron probes
// the services and POSTs a snapshot to the agent-tier `record_health` op; this
// table is what /status reads. `status` is the three-state health enum (plain
// TEXT, the enum only narrows the type — widening needs no migration). `since`
// is when the CURRENT status began (carried forward across an upsert while the
// status is unchanged, reset to `checked_at` on a transition), so the page can
// render "up 3d" / "down 12m". PUBLIC-SAFE by construction: only the service
// name, status, a short message, latency, and timestamps live here — never an
// IP, hostname, op-path, or raw error body.
export const serviceStatus = sqliteTable("service_status", {
  // When this row was last refreshed by a probe (ISO). Equals the POSTed `at`.
  checkedAt: text("checked_at").notNull(),
  // Round-trip latency of the last probe, in ms. Null when not measured.
  latencyMs: integer("latency_ms"),
  // A short, public-safe human message (e.g. "elevated p95", "timed out"). Null
  // when nothing to say. NEVER a raw error body / internal address.
  message: text("message"),
  // The probed service (PK): one of web/db/r2/dns/ssh/onion/hermes/render-box,
  // but plain TEXT so a new service needs no migration.
  service: text("service").primaryKey(),
  // When the CURRENT status began (ISO) — preserved across upserts while the
  // status is unchanged, reset to `checked_at` on a transition. Drives the
  // human "up 3d" / "down 12m" uptime/downtime read on /status.
  since: text("since").notNull(),
  // The three-state health enum (plain TEXT; the enum only narrows the type).
  status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
});

// The append-only status TRANSITION ledger — one row per status change (the
// probe POSTs `transitioned: true` for the check that flipped). Feeds the
// compact "recent events" feed on /status. Pruned to the most recent 200 rows
// on every write (a status page never needs deep history), indexed on `at` for
// the recent-first read + the prune's keep-set. PUBLIC-SAFE like
// `service_status`: service + status + short message + time only.
export const statusEvents = sqliteTable(
  "status_events",
  {
    // When the transition happened (ISO). Equals the POSTed snapshot `at`.
    at: text("at").notNull(),
    id: text("id").primaryKey(),
    // A short, public-safe human message for the transition. Null when none.
    message: text("message"),
    // The service that transitioned.
    service: text("service").notNull(),
    // The status it transitioned INTO (same three-state enum as service_status).
    status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
  },
  (table) => [index("status_events_at_idx").on(table.at)],
);

// The append-only per-check SAMPLE ledger — one row per probed service per snapshot
// (every ~10m tick). Drives the recent-uptime bar on /status: a strip of the last N
// checks per service, coloured by status, that fills in over time. Pruned per-service
// to the most recent samples on every write (bounded without a cron), indexed on
// (service, at) for the per-service recent-first read + the prune's keep-set.
// PUBLIC-SAFE like the others: service + status + latency + time only.
export const serviceCheckSamples = sqliteTable(
  "service_check_samples",
  {
    // When the sample was taken (ISO). Equals the POSTed snapshot `at`.
    at: text("at").notNull(),
    id: text("id").primaryKey(),
    // Round-trip latency of this probe, in ms. Null when not measured.
    latencyMs: integer("latency_ms"),
    // The probed service.
    service: text("service").notNull(),
    // The three-state health enum at this sample (same enum as service_status).
    status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
  },
  (table) => [index("service_check_samples_service_at_idx").on(table.service, table.at)],
);

export const spotifyAuth = sqliteTable("spotify_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

// Our own YouTube OAuth for mixtape video distribution — same shape as
// spotify_auth. The Worker holds the durable refresh token here and mints a
// short-lived access token for the CLI's resumable upload PUT + the server-side
// unlisted→public flip (videos.update). Single row, service PK = "youtube".
export const youtubeAuth = sqliteTable("youtube_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

// Our own Mixcloud OAuth for mixtape audio distribution — kept server-side like
// spotify_auth / youtube_auth (the CLI stays a thin client). Mixcloud tokens don't
// expire and there's no refresh token, so the table is just the durable access
// token; the Worker hands it to the CLI just-in-time for the direct upload (the
// bytes are CLI-direct; the credential is not). Single row, service PK = "mixcloud".
export const mixcloudAuth = sqliteTable("mixcloud_auth", {
  accessToken: text("access_token").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const submissions = sqliteTable(
  "submissions",
  {
    album: text("album"),
    artistsJson: text("artists_json").notNull(),
    artworkUrl: text("artwork_url"),
    contact: text("contact"),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    note: text("note"),
    reviewedAt: text("reviewed_at"),
    source: text("source", { enum: ["web", "cli", "ssh"] }).notNull(),
    spotifyTrackId: text("spotify_track_id").notNull(),
    spotifyUrl: text("spotify_url").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    submitterHash: text("submitter_hash").notNull(),
    title: text("title").notNull(),
    userId: text("user_id"),
  },
  (table) => [
    index("submissions_status_created_at_idx").on(table.status, table.createdAt),
    index("submissions_spotify_track_id_idx").on(table.spotifyTrackId),
    index("submissions_submitter_hash_created_at_idx").on(table.submitterHash, table.createdAt),
    index("submissions_user_id_created_at_idx").on(table.userId, table.createdAt),
  ],
);

export const user = sqliteTable("user", {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  displayUsername: text("display_username"),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  id: text("id").primaryKey(),
  image: text("image"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended", "deleted"] })
    .default("active")
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
  username: text("username").unique(),
});

export const session = sqliteTable(
  "session",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const rateLimitEvents = sqliteTable(
  "rate_limit_events",
  {
    action: text("action").notNull(),
    bucket: text("bucket").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    userId: text("user_id"),
  },
  (table) => [
    index("rate_limit_action_bucket_created_at_idx").on(
      table.action,
      table.bucket,
      table.createdAt,
    ),
    index("rate_limit_user_action_created_at_idx").on(table.userId, table.action, table.createdAt),
    index("rate_limit_ip_action_created_at_idx").on(table.ipHash, table.action, table.createdAt),
  ],
);

// Fixed-window rate-limit counters: one row per (action, bucket, window_start),
// incremented by a single atomic conditional upsert (see lib/server/rate-limit.ts).
// This is the durable, race-free backbone for every action limiter — the
// `count < max` guard lives in the upsert's `WHERE`, so two concurrent requests
// can never both pass the limit (unlike the old count-then-insert TOCTOU path).
// The `bucket` is `hash(cf-connecting-ip)` for anonymous callers or `userId` for
// authenticated ones — never the spoofable x-forwarded-for, never the User-Agent.
export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    action: text("action").notNull(),
    bucket: text("bucket").notNull(),
    count: integer("count").notNull().default(0),
    // ISO timestamp of the start of the current fixed window (windowMs-aligned).
    windowStart: text("window_start").notNull(),
  },
  (table) => [
    uniqueIndex("rate_limit_counter_action_bucket_window_idx").on(
      table.action,
      table.bucket,
      table.windowStart,
    ),
  ],
);

export const userGalaxyState = sqliteTable("user_galaxy_state", {
  createdAt: text("created_at").notNull(),
  deaths: integer("deaths").notNull().default(0),
  lastPlayedAt: text("last_played_at"),
  schemaVersion: integer("schema_version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  userId: text("user_id").primaryKey(),
  wins: integer("wins").notNull().default(0),
});

export const userGalaxyCollections = sqliteTable(
  "user_galaxy_collections",
  {
    firstCollectedAt: text("first_collected_at").notNull(),
    id: text("id").primaryKey(),
    lastCollectedAt: text("last_collected_at").notNull(),
    logId: text("log_id").notNull(),
    sourceSurface: text("source_surface", { enum: ["web", "cli", "ssh", "mcp"] }).notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    uniqueIndex("user_galaxy_collections_user_track_idx").on(table.userId, table.trackId),
    index("user_galaxy_collections_user_first_idx").on(table.userId, table.firstCollectedAt),
    index("user_galaxy_collections_track_first_idx").on(table.trackId, table.firstCollectedAt),
  ],
);

export const userSavedFindings = sqliteTable(
  "user_saved_findings",
  {
    id: text("id").primaryKey(),
    logId: text("log_id").notNull(),
    note: text("note"),
    savedAt: text("saved_at").notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [uniqueIndex("user_saved_findings_user_track_idx").on(table.userId, table.trackId)],
);

export const userDataExports = sqliteTable(
  "user_data_exports",
  {
    completedAt: text("completed_at"),
    expiresAt: text("expires_at").notNull(),
    id: text("id").primaryKey(),
    r2Key: text("r2_key"),
    requestedAt: text("requested_at").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] }).notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [index("user_data_exports_user_requested_idx").on(table.userId, table.requestedAt)],
);

export const userDeletionRequests = sqliteTable(
  "user_deletion_requests",
  {
    completedAt: text("completed_at"),
    id: text("id").primaryKey(),
    mode: text("mode", { enum: ["delete"] }).notNull(),
    requestedAt: text("requested_at").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] }).notNull(),
    summaryJson: text("summary_json").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("user_deletion_requests_user_requested_idx").on(table.userId, table.requestedAt),
  ],
);

// Per-platform publication state for a track's video. One row per (track,
// platform); the generic track pipeline tops out at "video in R2" (video_url),
// and publication is tracked here. Today: TikTok via Postiz (push draft → manual
// review/publish in-app → status updated by the operator) and YouTube Shorts
// (direct PUBLIC upload → `published`; the public `url` is auto-recorded from
// Postiz `/missing`, falling back to the operator's manual entry). The `platform`
// enum is plain TEXT, so widening it (e.g. to Instagram Reels) needs no migration.
// `external_id` holds the Postiz post id; `url` the public post URL.
export const socialPosts = sqliteTable(
  "social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"),
    id: text("id").primaryKey(),
    platform: text("platform", { enum: ["tiktok", "youtube"] }).notNull(),
    publishedAt: text("published_at"),
    scheduledFor: text("scheduled_for"),
    status: text("status", { enum: ["draft", "scheduled", "published", "failed"] }).notNull(),
    trackId: text("track_id").notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [uniqueIndex("social_posts_track_platform_idx").on(table.trackId, table.platform)],
);

// Distribution links no longer live here — they are the single source of truth in
// `mixtape_social_posts` (one row per platform, with status + external_id). The
// public DTO's `externalUrls` is derived from the published rows via a subquery in
// MIXTAPE_SELECT; nothing is dual-written onto the mixtape row.
export const mixtapes = sqliteTable("mixtapes", {
  addedAt: text("added_at"),
  createdAt: text("created_at").notNull(),
  durationMs: integer("duration_ms"),
  id: text("id").primaryKey(),
  logId: text("log_id").unique(),
  note: text("note"),
  // The scheduled date/time (ISO) of an upcoming live session this mixtape is the
  // draft of — distinct from `recorded_at` (which is what publish derives the Log
  // ID sector from). A future `planned_for` surfaces the mixtape as an upcoming
  // event in the subscribe-able /calendar.ics, even while it's still a draft.
  plannedFor: text("planned_for"),
  publishedAt: text("published_at"),
  recordedAt: text("recorded_at"),
  sequenceNumber: integer("sequence_number").unique(),
  // "distributing" is the minted-but-uploading state between draft and published
  // (see MixtapeStatus in @fluncle/contracts). Plain TEXT, the enum only narrows
  // the type.
  status: text("status", { enum: ["draft", "distributing", "published"] })
    .notNull()
    .default("draft"),
  title: text("title").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Per-platform distribution state for a mixtape's audio/video, mirroring
// `social_posts` for findings: one row per (mixtape, platform). This is the SINGLE
// source of truth for a mixtape's listen links — the public DTO's `externalUrls`
// derives from the `published` rows here (no `mixtapes.*_url` columns). YouTube +
// Mixcloud are recorded by the CLI `distribute` flow (it moves the multi-GB bytes
// the Worker can't proxy); SoundCloud is set manually from the admin editor.
// `external_id` holds the YouTube videoId / Mixcloud cloudcast key; `url` the
// public URL.
export const mixtapeSocialPosts = sqliteTable(
  "mixtape_social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"),
    id: text("id").primaryKey(),
    mixtapeId: text("mixtape_id").notNull(),
    platform: text("platform", { enum: ["youtube", "mixcloud", "soundcloud"] }).notNull(),
    publishedAt: text("published_at"),
    status: text("status", { enum: ["uploading", "published", "failed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [
    uniqueIndex("mixtape_social_posts_mixtape_platform_idx").on(table.mixtapeId, table.platform),
  ],
);

// Push-notification device registry (the mobile app):
// one row per Expo push token, which IS the natural key (the `userGalaxyState`
// natural-PK precedent, not a surrogate id). `token` is `ExponentPushToken[…]`;
// `userId` is nullable — the V1 app is anonymous, so it binds only once accounts
// arrive (a future "linked to user" privacy-label flip). `mutedJson` is a TEXT
// JSON array of muted categories (the `tracks.features_json` JSON-column
// precedent), e.g. `["mixtapes"]`. `lastSeenAt` is bumped on every re-register so
// a staleness reaper can prune long-dead anonymous rows. The send module reads
// this table; the GDPR sweep (account-data.ts) clears a deleted user's tokens.
export const pushTokens = sqliteTable(
  "push_tokens",
  {
    appVersion: text("app_version"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    mutedJson: text("muted_json"),
    platform: text("platform", { enum: ["android", "ios"] }).notNull(),
    token: text("token").primaryKey(),
    userId: text("user_id"),
  },
  (table) => [
    index("push_tokens_user_id_idx").on(table.userId),
    index("push_tokens_last_seen_at_idx").on(table.lastSeenAt),
  ],
);

// The pending push-receipt ledger. Expo's send
// returns one TICKET per message; an "ok" ticket carries a RECEIPT id you fetch
// ~15min+ later (getReceipts) to learn the real delivery outcome —
// `DeviceNotRegistered` (the dead-token signal) arrives HERE, not on the ticket.
// So each ok ticket's `{ receiptId → token }` is parked here at send time; the
// receipts-sweep admin op (an external cron) drains it: fetch the receipts, prune
// the tokens Expo reports gone, delete the resolved ledger rows. `id` is the Expo
// receipt id (its natural key); `token` is the device it was sent to.
export const pushReceipts = sqliteTable(
  "push_receipts",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    token: text("token").notNull(),
  },
  (table) => [index("push_receipts_created_at_idx").on(table.createdAt)],
);

export const mixtapeTracks = sqliteTable(
  "mixtape_tracks",
  {
    mixtapeId: text("mixtape_id").notNull(),
    position: integer("position").notNull(),
    startMs: integer("start_ms"),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    index("mixtape_tracks_mixtape_id_idx").on(table.mixtapeId),
    uniqueIndex("mixtape_tracks_mixtape_position_idx").on(table.mixtapeId, table.position),
    uniqueIndex("mixtape_tracks_mixtape_track_idx").on(table.mixtapeId, table.trackId),
  ],
);

// A newsletter EDITION — the weekly dispatch from the mothership, now persisted so
// every Friday letter has a permanent home.
// Modeled on the `mixtapes` table SHAPE (own table + counter + a draft→sent
// lifecycle) but NOT its identity: an edition is content, not a collectible, so its
// identity is a plain integer `number` minted on send (`max(number)+1`) — NO Log
// ID, no coordinate, no spine resolver branch. The stored `contentJson` is the
// single source that renders BOTH the web archive page and the email HTML.
export const editions = sqliteTable("editions", {
  // RSS/index ordering — set on send.
  addedAt: text("added_at"),
  // The structured JSON payload the agent authors (intro, galaxy-grouped finding
  // refs by logId + per-edition "why", the optional mixtape ref, the tidbits +
  // sources, the window, the subject). NOT raw LMX — the web page and the email
  // HTML both render FROM this one source. Stored as JSON text.
  contentJson: text("content_json").notNull(),
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),
  // The sequential edition number — minted on send (`max(number)+1`), null while a
  // draft. A plain integer never exhausts (no cap-54 like the mixtape spine).
  number: integer("number").unique(),
  // Provenance of the send so a re-send is idempotent and the archive records how
  // it went out. "resend" + the Resend broadcast id.
  sendExternalId: text("send_external_id"),
  sendProvider: text("send_provider"),
  sentAt: text("sent_at"),
  status: text("status", { enum: ["draft", "sent"] })
    .notNull()
    .default("draft"),
  subject: text("subject"),
  updatedAt: text("updated_at").notNull(),
  // The discovery window this edition covered — `windowUntil` anchors the next
  // window's self-heal (the agent reads the last SENT edition's cutoff).
  windowSince: text("window_since"),
  windowUntil: text("window_until"),
});
