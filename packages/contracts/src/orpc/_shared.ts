// Shared oRPC contract schemas — the Zod mirrors of the pure-types DTOs in
// `../index.ts`, kept structurally in lock-step with those types. Every domain
// contract module (`./tracks.ts`, `./health.ts`, …) imports the shapes it needs
// from here, so a DTO has exactly one Zod definition across the registry and the
// generated OpenAPI components stay deduplicated (`.meta({ id })`).
//
// Where a future op needs the full TS shape, derive it from the schema
// (`z.infer`) rather than maintaining two copies.

import * as z from "zod";

/** Enrichment's track-level spectral summary (`TrackFeatures` in ../index.ts). */
export const TrackFeaturesSchema = z
  .object({
    centroidHz: z.number().optional(),
    highRatio: z.number().optional(),
    midFlatness: z.number().optional(),
    onsetRate: z.number().optional(),
    subBassRatio: z.number().optional(),
  })
  .meta({ id: "TrackFeatures" });

/** A finding as the feed/log/admin board renders it (`TrackListItem` in ../index.ts). */
export const TrackListItemSchema = z
  .object({
    addedAt: z.string(),
    addedToSpotify: z.boolean(),
    album: z.string().optional(),
    albumImageUrl: z.string().optional(),
    // The `/album/<slug>` page this finding's record has, read through the `tracks.album_id`
    // pointer — so it is present ONLY when the album entity really exists (an album is minted
    // off a certified finding). This is what turns the album NAME into a graph link: a
    // `GraphLink` renders with the page, server-side, with no lookup of its own. Its absence
    // is the honest "there is nowhere to send you", and the name stays plain text.
    albumSlug: z.string().optional(),
    // ISO timestamp of the last analysis write (bpm/key/features); RFC bpm-key-accuracy.
    // Written on every successful analysis; ADMIN-ONLY like the sources — `toPublicTrackListItem`
    // strips it before any public read. Read-only observability: the freshness companion to
    // `analyzedFrom`/`keySource`, so a reader can tell WHEN a key was (re-)derived, not just by
    // whom. No sweep predicate keys on it. Absent on legacy rows (pre-provenance).
    analyzedAt: z.string().optional(),
    // Which audio class BPM/key were analyzed from — "full" (the captured full song) or
    // "preview" (a 30s preview); RFC bpm-key-accuracy. Internal capture/enrich provenance
    // on the admin-authed DTO — `toPublicTrackListItem` strips it before any public read, so
    // it is present only on admin reads (the capture sweep + the `requeue-analysis` command
    // read it to find preview-grade findings). Absent on legacy rows (pre-provenance).
    analyzedFrom: z.enum(["preview", "full"]).optional(),
    // The finding's Apple Music track URL — a PUBLIC listen link, the Spotify twin,
    // resolved EXACTLY by ISRC (the `apple-music` backfill). Present only once resolved;
    // a missing link is honest (Apple has no match, or the leg is unprovisioned), a wrong
    // one never renders — the resolve is exact-or-nothing. Feeds the /log "Listen on Apple
    // Music" link + the MusicRecording `sameAs`.
    appleMusicUrl: z.string().optional(),
    // The artist's own YouTube channel id(s) (`UC…`), gathered from the confirmed
    // `artist_socials` YouTube links of every artist on the finding. Populated ONLY on
    // the admin capture-queue read (`captureQueue=true`) — the full-song capture sweep
    // reads it as its STRONGEST trust tier: a candidate on one of these is the artist's
    // OWN upload. Absent on every other read (an internal, capture-only signal); absent
    // here too when no artist has a resolvable `/channel/UC…` link.
    artistYoutubeChannelIds: z.array(z.string()).optional(),
    artists: z.array(z.string()),
    // The best ≥1920 render source for this finding's cover — Apple's `{w}x{h}` artwork
    // template composed server-side at 2048² (clamped to native) from the album facts U1
    // stored (RFC musickit-second-authority U3a). Present ONLY when the album carries Apple
    // artwork; absent otherwise, and the render falls through to `albumImageUrl`. RENDER-TIME
    // ONLY (decision A: never persisted) — the video pipeline (`packages/video`) reads it as a
    // dumb consumer, so it never composes an Apple URL itself. Web/mobile ignore it (they
    // render `albumImageUrl` small).
    artworkMaxUrl: z.string().optional(),
    bpm: z.number().optional(),
    // Who last set bpm/key — the source-hierarchy provenance (operator > rekordbox > DSP;
    // apps/web track-update.ts). ADMIN-ONLY on this DTO: `toPublicTrackListItem` strips both
    // before any public read, so they arrive undefined on `/api/tracks` and are present only
    // on the admin path. The Rekordbox sync reads them to skip an operator-graded row and to
    // detect a matching-but-unstamped value that still needs a protective `rekordbox` stamp.
    bpmSource: z.string().optional(),
    discogsReleaseUrl: z.string().optional(),
    durationMs: z.number(),
    enrichmentStatus: z.string(),
    features: TrackFeaturesSchema.optional(),
    // The sonic galaxy this finding belongs to (browse-by-feel RFC): the operator-named
    // cluster over the MuQ embedding space, read from `tracks.galaxy_id`. A nullable
    // `{ name, slug }` — present ONLY when the finding is placed (assigned by the
    // `fluncle-cluster` cron) AND its galaxy is operator-NAMED. `slug` links to the
    // `/galaxies/<slug>` lens. Replaces the four fixed vibe-quadrant names (the dead
    // `{ key, name }` union), which were derived from the retired vibe axes.
    galaxy: z
      .object({
        name: z.string(),
        slug: z.string(),
      })
      .optional(),
    isrc: z.string().optional(),
    key: z.string().optional(),
    // Key provenance — see `bpmSource` above. Admin-only (public-stripped).
    keySource: z.string().optional(),
    label: z.string().optional(),
    // The `/label/<slug>` page this finding's imprint has — the `tracks.label_id` twin of
    // `albumSlug` above, and the same contract: present only when the label entity exists,
    // so a graph link never points at a 404.
    labelSlug: z.string().optional(),
    logId: z.string().optional(),
    logPageUrl: z.string().optional(),
    note: z.string().optional(),
    // Word-level caption timings for the spoken observation (ms windows), driving the
    // synced subtitles on the radio player. Present only once captured (a fresh
    // Cartesia timestamped render or a forced-alignment backfill); absent ⇒ no captions.
    observationAlignment: z
      .object({
        words: z.array(z.object({ endMs: z.number(), startMs: z.number(), text: z.string() })),
      })
      .optional(),
    observationAudioUrl: z.string().optional(),
    observationDurationMs: z.number().optional(),
    observationGeneratedAt: z.string().optional(),
    popularity: z.number().optional(),
    postedToTelegram: z.boolean(),
    previewUrl: z.string().optional(),
    releaseDate: z.string().optional(),
    // The consecutive full-song capture failures (RFC full-audio § Unit 1). Internal
    // capture state, surfaced so the `fluncle-capture` sweep reads the prior count and
    // increments truthfully — the queue's failure-cap backoff depends on it. Present only
    // when non-zero (a never-failed finding omits it).
    sourceAudioFailures: z.number().optional(),
    // The R2 key of the captured full song (`<logId>/<sha256>.<ext>`; RFC full-audio).
    // Presence = the song is captured. Internal capture state on the admin-authed DTO —
    // the key grants nothing without the private-bucket R2 creds. The enrich + embed
    // sweeps read it (the MuQ embed queue only embeds captured findings). Absent until
    // captured.
    sourceAudioKey: z.string().optional(),
    spotifyUrl: z.string(),
    tiktokUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
    type: z.literal("finding").optional(),
    updatedAt: z.string().optional(),
    videoGrain: z.string().optional(),
    videoModel: z.string().optional(),
    videoModelReasoning: z.string().optional(),
    videoRegister: z.string().optional(),
    videoSquaredAt: z.string().optional(),
    videoUrl: z.string().optional(),
    videoVehicle: z.string().optional(),
    youtubeUrl: z.string().optional(),
  })
  .meta({ id: "TrackListItem" });

/**
 * Why one finding mixes cleanly out of another — the structured reason a `/mix`
 * candidate row renders as its chip (the mixability engine, `lib/server/mixability.ts`).
 * NO numeric score reaches the crew (a SaaS tell + mono-genre compression makes
 * percentages read broken); the chip is this `{ kind, relationship }` alone. `kind`
 * is the dominant present sub-score; `relationship` names it — the harmonic labels for
 * `key`, `tempo_match` for `bpm`, `close_in_sound` for `sonic`.
 */
export const MixReasonSchema = z
  .object({
    kind: z.enum(["key", "bpm", "sonic"]),
    relationship: z.enum([
      "same_key",
      "relative",
      "adjacent",
      "energy",
      "diagonal",
      "distant",
      "tempo_match",
      "close_in_sound",
    ]),
  })
  .meta({ id: "MixReason" });

/**
 * One track as `/mix` renders it — a chain row, a candidate, an opener.
 *
 * A DELIBERATELY SMALL SHAPE, and not a `TrackListItem`. `/mix` is the first surface where
 * a row may be a track Fluncle never certified (`certified: false` — it exists in the
 * archive, it has a key and a vector, it mixes), and DESIGN.md's Unlit Rule says such a row
 * carries no coordinate, no note, no video, no galaxy. Serving it a DTO with all of those
 * fields would leave "does a catalogue row ever show a Log ID?" as a question about every
 * consumer's discipline. This shape makes it a question about the TYPE: there is no `note`,
 * no `videoUrl`, no `galaxy` here to leak, and `logId` is present if and only if `certified`
 * is true (`toMixTrack` reads both off the same `findings.log_id`, so they cannot disagree).
 *
 * The tier is never NAMED — `certified` is a boolean and not a label. The client uses it to
 * pick a REGISTER (lit, with its coordinate → `/log`; or unlit, linking out to Spotify), and
 * nothing else. No badge, no noun, no heading over a homogeneous block of them.
 */
export const MixTrackSchema = z
  .object({
    albumImageUrl: z.string().optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    /** True ⇔ Fluncle certified this track — i.e. it is a finding, and has a coordinate. */
    certified: z.boolean(),
    durationMs: z.number(),
    key: z.string().optional(),
    /** The permanent coordinate. Present ⇔ `certified` (the Unlit Rule, structurally). */
    logId: z.string().optional(),
    /**
     * Absent for a crawler-minted catalogue row — MusicBrainz-born, no Spotify presence
     * (docs/catalogue-crawler.md: Spotify is a per-track ISRC anchor, never a guarantee).
     * Any keyed track is rankable, so the rail MUST serialize one; a required string here
     * once 500'd the whole /mix domain the day the first crawled track earned a key.
     */
    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "MixTrack" });

/**
 * A `/mix` candidate: a {@link MixTrackSchema} plus its `reason` chip, ordered by the
 * mixability core (`list_mixable_tracks`). NO score field (§3.0 invariant: numbers never
 * reach the crew — the chip is the whole explanation).
 */
export const MixCandidateSchema = MixTrackSchema.extend({
  reason: MixReasonSchema,
}).meta({ id: "MixCandidate" });

/**
 * The radio.fluncle.com now-playing slot (`RadioNowPlaying` in ../index.ts; RFC
 * radio-broadcast.md Unit A). The server-authoritative position on the shared loop
 * — `currentTrack` + `offsetMs` is what's playing right now; `nextTrack` the
 * preload target (offset 0); `serverEpochMs` + `scheduleVersion` drive the
 * client's NTP-lite skew + the re-fetch on a changed catalogue.
 */
export const RadioNowPlayingSchema = z
  .object({
    currentTrack: TrackListItemSchema,
    nextTrack: TrackListItemSchema.optional(),
    offsetMs: z.number(),
    scheduleVersion: z.string(),
    serverEpochMs: z.number(),
    totalLoopDurationMs: z.number(),
    trackCount: z.number(),
  })
  .meta({ id: "RadioNowPlaying" });

/** A per-platform distribution row (`MixtapeMember`-adjacent; see ../index.ts). */
const MixtapeMemberSchema = TrackListItemSchema.extend({
  startMs: z.number().optional(),
}).meta({ id: "MixtapeMember" });

/** A mixtape as `/mixtapes` + `/api/mixtapes` emit it (`MixtapeDTO` in ../index.ts). */
export const MixtapeDTOSchema = z
  .object({
    addedAt: z.string().optional(),
    // Set (ISO) once the mixtape has been announced to the crew (the Telegram crew
    // channel) via `announce_mixtape` — the idempotency marker + the "already
    // announced" signal the Studio reads to render its done state. Absent ⇒ not
    // announced yet.
    announcedAt: z.string().optional(),
    artists: z.tuple([z.literal("Fluncle")]),
    coverImageUrl: z.string().optional(),
    createdAt: z.string().optional(),
    durationMs: z.number().optional(),
    externalUrls: z.object({
      mixcloud: z.string().optional(),
      soundcloud: z.string().optional(),
      youtube: z.string().optional(),
    }),
    id: z.string().optional(),
    logId: z.string().optional(),
    memberCount: z.number(),
    members: z.array(MixtapeMemberSchema),
    note: z.string().optional(),
    publishedAt: z.string().optional(),
    recordedAt: z.string().optional(),
    // The RECORDING this mixtape was promoted from (RFC recording-primitive, Design B) —
    // the source of its set video + clips. Set on a promoted mixtape (and mixtape #1's
    // backfilled recording); absent on a legacy mixtape published before recordings
    // existed. A mixtape's Studio IS its recording's Studio
    // (`/admin/studio/<recordingId>`) when present.
    recordingId: z.string().optional(),
    sequenceNumber: z.number().optional(),
    // Set (ISO) once the full set video is uploaded to R2 — the `/log` page then
    // shows the branded scrubber player. Absent ⇒ no set video yet.
    setVideoAt: z.string().optional(),
    // No "draft" arm: a mixtape is only ever born minted-or-minting via
    // `promote_recording`; pre-publish authoring lives on plans.
    status: z.enum(["distributing", "published"]),
    title: z.string(),
    type: z.literal("mixtape"),
    updatedAt: z.string().optional(),
  })
  .meta({ id: "MixtapeDTO" });

/**
 * A feed item: a finding or a mixtape (`FeedItem` in ../index.ts). The merged
 * `/tracks` feed interleaves both; a mixtape is distinguished by `type:
 * "mixtape"`. The `TrackListItem` arm stays first so a finding (whose `type` is
 * an OPTIONAL `"finding"`) still matches when `type` is absent.
 */
export const FeedItemSchema = z
  .union([TrackListItemSchema, MixtapeDTOSchema])
  .meta({ id: "FeedItem" });

/** A Spotify search candidate (`TrackSearchResult` in ../index.ts; `/api/search`). */
export const TrackSearchResultSchema = z
  .object({
    album: z.string().optional(),
    artists: z.array(z.string()),
    artworkUrl: z.string().optional(),
    id: z.string(),
    spotifyUrl: z.string(),
    title: z.string(),
  })
  .meta({ id: "TrackSearchResult" });

/**
 * A signed-in public user as the `/me` private tier returns it (`PublicUser` in
 * the server `public-auth` module). The cookie-session identity — distinct from
 * the admin grant. `username`/`displayUsername` are absent until the user claims
 * a handle, so both are optional.
 */
export const PublicUserSchema = z
  .object({
    createdAt: z.string(),
    displayUsername: z.string().optional(),
    id: z.string(),
    username: z.string().optional(),
  })
  .meta({ id: "PublicUser" });

/** A per-platform publication row (`SocialPostItem` in ../index.ts; `social_posts`). */
export const SocialPostItemSchema = z
  .object({
    createdAt: z.string(),
    externalId: z.string().optional(),
    platform: z.string(),
    publishedAt: z.string().optional(),
    scheduledFor: z.string().optional(),
    status: z.string(),
    updatedAt: z.string(),
    url: z.string().optional(),
  })
  .meta({ id: "SocialPostItem" });

/**
 * A finding reference inside an edition's content payload — the finding's own Log
 * ID plus the editorial "why" line written FOR this edition (which may differ from
 * the finding's own `note`). The archive page hydrates the live finding from
 * `tracks` by `logId`, so the reference stays tiny and current.
 */
const EditionFindingRefSchema = z
  .object({
    logId: z.string(),
    why: z.string().optional(),
  })
  .meta({ id: "EditionFindingRef" });

/** A galaxy-grouped block of finding references inside an edition. */
const EditionGalaxyBlockSchema = z
  .object({
    findings: z.array(EditionFindingRefSchema),
    galaxy: z.string(),
  })
  .meta({ id: "EditionGalaxyBlock" });

/** A tidbit (a linkable fact) carried in an edition. */
const EditionTidbitSchema = z
  .object({
    source: z.string().optional(),
    text: z.string(),
  })
  .meta({ id: "EditionTidbit" });

/**
 * The structured content payload an edition stores (`editions.content_json`). The
 * SINGLE source the agent authors that renders BOTH the web archive page and the
 * email HTML. LOOSE on the
 * agent's side at write time (the admin route passes it through), but this is the
 * canonical READ shape the public DTO exposes.
 */
export const EditionContentSchema = z
  .object({
    galaxies: z.array(EditionGalaxyBlockSchema).optional(),
    intro: z.string().optional(),
    mixtapeRef: z.string().optional(),
    tidbits: z.array(EditionTidbitSchema).optional(),
  })
  .meta({ id: "EditionContent" });

/**
 * An edition as the `/newsletter` archive surface + `/api/v1/newsletter/editions`
 * emit it (`EditionDTO` in ../index.ts). NOT a collectible: a plain integer
 * `number` (minted on send, absent on a draft), no Log ID, no coordinate. The
 * `content` is the structured payload above.
 */
export const EditionDTOSchema = z
  .object({
    addedAt: z.string().optional(),
    content: EditionContentSchema,
    createdAt: z.string().optional(),
    id: z.string(),
    number: z.number().optional(),
    sentAt: z.string().optional(),
    status: z.enum(["draft", "sent"]),
    subject: z.string().optional(),
    updatedAt: z.string().optional(),
    windowSince: z.string().optional(),
    windowUntil: z.string().optional(),
  })
  .meta({ id: "EditionDTO" });

/** The cost-ledger buckets a subscription line falls in (COST-02). */
export const SubscriptionCategorySchema = z.enum([
  "infra",
  "AI",
  "media",
  "distribution",
  "domains",
  "tooling",
]);

/** How a subscription line's charge recurs (COST-02). */
export const SubscriptionCadenceSchema = z.enum(["monthly", "annual", "one-off", "usage"]);

/** A subscription line's lifecycle (COST-02). */
export const SubscriptionStatusSchema = z.enum(["active", "cancelled", "trial"]);

/**
 * One line in the operator's private cost ledger (`SubscriptionDTO` in ../index.ts) —
 * a recurring or one-off spend on some Fluncle vendor. The whole surface is operator
 * tier: this shape never reaches a public route, only the admin `/admin/costs` station
 * + its CRUD ops. `amount` is minor units (cents). Nullable fields are `.optional()`.
 */
export const SubscriptionDTOSchema = z
  .object({
    amount: z.number(),
    billingUrl: z.string().optional(),
    cadence: SubscriptionCadenceSchema,
    category: SubscriptionCategorySchema,
    createdAt: z.string(),
    currency: z.string(),
    id: z.string(),
    name: z.string(),
    notes: z.string().optional(),
    powers: z.string().optional(),
    renewsAt: z.string().optional(),
    status: SubscriptionStatusSchema,
    updatedAt: z.string(),
    vendor: z.string(),
  })
  .meta({ id: "SubscriptionDTO" });

/**
 * A clip — a lightweight 9:16 derivative cut from a recording's set video
 * (`mixtape_clips`; `ClipDTO` below). NOT a spine
 * object: it carries no Log ID. Many per set (the drip-feed backlog). This is the
 * wire shape the clip ops emit and the editor / clip library read. `xOffset` is the
 * 9:16 framing offset; `status` is the cut-queue + library-filter state.
 */
export const ClipDTOSchema = z
  .object({
    caption: z.string().optional(),
    createdAt: z.string(),
    id: z.string(),
    inMs: z.number(),
    outMs: z.number(),
    // The `recording` a clip was cut from — a clip's ONE owner since the
    // plan→recording→mixtape Deploy-2 cutover dropped the legacy `mixtapeId`
    // (every legacy mixtape clip was repointed onto its mixtape's recording first).
    // Optional at the wire level (the column is nullable); `createClip` always sets it.
    recordingId: z.string().optional(),
    status: z.enum(["done", "pending"]),
    updatedAt: z.string(),
    xOffset: z.number(),
  })
  .meta({ id: "ClipDTO" });

/** The TS shape of a clip, derived from the schema (one definition, no drift). */
export type ClipDTO = z.infer<typeof ClipDTOSchema>;

/**
 * A recording tracklist cue (`recording_cues`; RFC plan→recording→mixtape). `id` is
 * a stable cue ref; `artists`/`title` feed the clip overlay's
 * changing on-screen Track-ID (`resolveClipTracks`) with no re-splitting, and seed
 * `mixtape_tracks` on promote. `startMs` is the cue's start on the set timeline.
 */
export const RecordingTracklistItemSchema = z
  .object({
    artists: z.array(z.string()),
    // The honest link to canon (the cue's `recording_cues.finding_id`), when the operator
    // picked a real Fluncle finding rather than typing a non-finding track. Absent for a
    // free-text cue. Additive + OPTIONAL: legacy readers and the Rekordbox derivation
    // script (which reads cues server-side, not via this DTO) are unaffected. The Studio
    // cue rail reads it to render the finding-linked vs snapshot distinction.
    findingId: z.string().optional(),
    id: z.string(),
    startMs: z.number().optional(),
    title: z.string(),
  })
  .meta({ id: "RecordingTracklistItem" });

/** The TS shape of a recording tracklist cue, derived from the schema. */
export type RecordingTracklistItem = z.infer<typeof RecordingTracklistItemSchema>;

/**
 * A RECORDING — a captured DJ set that is NOT (yet) a published mixtape (RFC
 * recording-primitive, Design B). It OWNS its R2 key (`r2Key`) and carries an optional
 * cue tracklist. Coordinate-less until `promote` mints a mixtape from it; `logId` +
 * `mixtapeId` are then the promoted mixtape's coordinate + id (absent while un-promoted).
 */
export const RecordingDTOSchema = z
  .object({
    createdAt: z.string(),
    durationMs: z.number().optional(),
    // "has video" = the recording OWNS a set-video key. A PLAN has none (`false`);
    // a TAKE has one (`true`). Derived server-side from `r2Key` presence so the UI
    // never re-derives the plan/take split from a nullable key (RFC §1, taste #1).
    hasVideo: z.boolean(),
    id: z.string(),
    // The promoted mixtape's committed Log ID coordinate (absent until promoted).
    logId: z.string().optional(),
    // The promoted mixtape's id (absent until promoted).
    mixtapeId: z.string().optional(),
    // The take→plan link (RFC plan→recording→mixtape §3): a TAKE points at its PLAN;
    // absent for a plan or an orphan take (e.g. the rolling set).
    parentId: z.string().optional(),
    // The scheduled date/time (ISO) of the upcoming live session a PLAN is for — the
    // plan-side home of `mixtapes.planned_for` (RFC §6, D-plannedFor). Absent when unset
    // and on takes/legacy rows. The plan editor's Live-session field reads + writes it.
    plannedFor: z.string().optional(),
    // The owned R2 key. ABSENT for a PLAN (a recording with no video — RFC
    // plan→recording→mixtape): "has video" = `r2Key` present.
    r2Key: z.string().optional(),
    recordedAt: z.string().optional(),
    title: z.string(),
    tracklist: z.array(RecordingTracklistItemSchema),
    updatedAt: z.string(),
    // The human display label ("v2") among a plan's takes (RFC §3, D-version).
    // Every recording carries one (defaults to 1 in the schema).
    version: z.number(),
  })
  .meta({ id: "RecordingDTO" });

/** The TS shape of a recording, derived from the schema (one definition, no drift). */
export type RecordingDTO = z.infer<typeof RecordingDTOSchema>;

/** A mixtape per-platform distribution row (`MixtapeSocialPostItem`; `mixtape_social_posts`). */
export const MixtapeSocialPostItemSchema = z
  .object({
    createdAt: z.string(),
    externalId: z.string().optional(),
    platform: z.string(),
    publishedAt: z.string().optional(),
    status: z.string(),
    updatedAt: z.string(),
    url: z.string().optional(),
  })
  .meta({ id: "MixtapeSocialPostItem" });

/** A finding submission as `/api/submissions` records it (`Submission` in ../index.ts). */
export const SubmissionSchema = z
  .object({
    album: z.string().optional(),
    artists: z.array(z.string()),
    artworkUrl: z.string().optional(),
    contact: z.string().optional(),
    createdAt: z.string(),
    id: z.string(),
    note: z.string().optional(),
    reviewedAt: z.string().optional(),
    source: z.enum(["cli", "ssh", "web"]),
    spotifyTrackId: z.string(),
    spotifyUrl: z.string(),
    status: z.enum(["approved", "pending", "rejected"]),
    title: z.string(),
    // The pre-chew triage verdict (the on-box `fluncle-triage` sweep's advisory
    // one-liner). Operator-internal, absent until the sweep visits.
    triageVerdict: z.string().optional(),
  })
  .meta({ id: "Submission" });
