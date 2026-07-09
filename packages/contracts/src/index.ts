// The Fluncle API contract — the shapes the web app emits and the CLI, Raycast,
// and external agents consume. Pure types (no runtime): the web stays the source
// of truth for logic + the drizzle schema; this package is the single place the
// public DTOs + response envelopes are defined, so the CLI/Raycast mirrors can't
// drift (they did before — CLI `RecentTrack` was missing 7 fields, `PublishTrackResult`
// carried a dead `tags`, `MixtapeMemberItem` was a subset).
//
// Web routes import these to type `Response.json<…>(…)`; the CLI imports them for
// `publicApiGet<T>`/`adminApiPost<T>`; Raycast imports them for CLI-stdout parsing.
// Request DTOs are the clean typed bodies the CLI sends — the web keeps its own
// `unknown`-typed validators that narrow untrusted input at the boundary.
//
// Caveat: the Go SSH app (apps/ssh) is outside this single source of truth — it
// hand-mirrors the request DTOs (`submissionRequest`, `newsletterRequest` in
// main.go) because Go can't import a TS types package. If a request DTO here
// changes shape, update the Go structs to match (a code-gen step could close
// this gap later).
//
// SINGLE DEFINITION: the response DTOs below are `z.infer`'d from the Zod schemas
// in `./orpc/_shared.ts` (the live wire authority since the oRPC migration), so a
// hand-written mirror can never drift from the schema a route validates against.
// The schemas are pulled with `import type` — a TYPE-ONLY import — so this `.`
// entry stays runtime-free (no zod in the CLI/extension bundle); only `z.infer`,
// which erases at compile, reads them. Request DTOs and response ENVELOPES stay
// hand-written here: the request bodies' contract schemas are deliberately LOOSE
// (`z.unknown()`), so inferring them would erase the CLI's typed send shape.

import { type z } from "zod";
import { type ArtistListItemSchema } from "./orpc/artists.js";
import {
  type AttentionQueueSchema,
  type AttentionRowSchema,
  type AttentionSourceCountSchema,
  type AttentionSourceSchema,
} from "./orpc/admin-attention.js";
import { type ServiceHealthStatusSchema } from "./orpc/admin-health.js";
import { type GalaxyProgressSchema } from "./orpc/me-galaxy.js";
import {
  type ClipDTOSchema,
  type EditionDTOSchema,
  type MixtapeDTOSchema,
  type MixtapeSocialPostItemSchema,
  type PublicUserSchema,
  type RadioNowPlayingSchema,
  type RecordingDTOSchema,
  type RecordingTracklistItemSchema,
  type SocialPostItemSchema,
  type SubmissionSchema,
  type SubscriptionDTOSchema,
  type TrackFeaturesSchema,
  type TrackListItemSchema,
  type TrackSearchResultSchema,
  // `.js` extension: the `.` entry is consumed by NodeNext typecheckers (Raycast),
  // which require explicit extensions on relative imports; Bundler resolvers (web,
  // CLI) + vite/esbuild resolve it back to the `.ts` source. Type-only import, so
  // no zod runtime reaches the zod-free `.` bundle.
} from "./orpc/_shared.js";

// ── Common ───────────────────────────────────────────────────────────────────

/** The success envelope: `{ ok: true } & T`. The web spreads the payload (`{ ok: true, ...result }`). */
export type Ok<T> = { ok: true } & T;

/** The failure envelope every error response shares (`jsonError`/`apiErrorResponse`). */
export type ApiFailure = {
  ok: false;
  code: string;
  message: string;
};

/** The four vibe-map galaxies (the admin tagging quadrants). The web keeps the runtime `GALAXIES` map + `GalaxyMeta`. */
export type Galaxy = "astral" | "lunar" | "nebular" | "solar";

// ── Artist ───────────────────────────────────────────────────────────────────

/**
 * A public artist list item, as `GET /api/v1/artists` and `GET /api/v1/artists/:slug`
 * emit it. Inferred from `ArtistListItemSchema` (./orpc/artists.ts) — the minimal
 * identity shape (name, slug, finding count, optional Spotify URL) shared by the
 * list and get ops.
 */
export type ArtistListItem = z.infer<typeof ArtistListItemSchema>;

/** `GET /api/v1/artists` response — all artists with at least one finding. */
export type ArtistsResponse = Ok<{ artists: ArtistListItem[] }>;

/** `GET /api/v1/artists/:slug` response — one artist by slug. */
export type ArtistGetResponse = Ok<{ artist: ArtistListItem }>;

// ── Me (the private user tier) ───────────────────────────────────────────────

/**
 * A signed-in public user as the `/me` private tier returns it. Inferred from
 * `PublicUserSchema` (./orpc/_shared.ts) — the cookie-session identity, distinct
 * from the admin grant. `username`/`displayUsername` are absent until claimed.
 */
export type PublicUser = z.infer<typeof PublicUserSchema>;

/**
 * `GET /me` (`get_current_private_user`): `{ ok: true, user }` where `user` is the
 * signed-in `PublicUser` or `null` when there is no session. The hand-written
 * envelope over the inferred `PublicUser`, matching `getCurrentPrivateUser.output`.
 */
export type MeResponse = Ok<{ user: PublicUser | null }>;

/**
 * A user's Galaxy progress (the game's cross-device save) as
 * `GET/PUT /me/galaxy-progress` returns it. Inferred from `GalaxyProgressSchema`
 * (./orpc/me-galaxy.ts); carries its own `ok: true` (the live helper's object is
 * returned verbatim). `lastPlayedAt`/`updatedAt` are absent until the first play.
 */
export type GalaxyProgress = z.infer<typeof GalaxyProgressSchema>;

// ── Service health (the public /status dashboard) ────────────────────────────

/**
 * The three-state service-health enum the status surfaces emit. Inferred from
 * `ServiceHealthStatusSchema` (./orpc/admin-health.ts), the `admin-health`
 * contract's shared enum.
 */
export type ServiceHealthStatus = z.infer<typeof ServiceHealthStatusSchema>;

// ── Track ────────────────────────────────────────────────────────────────────

/**
 * Enrichment's track-level spectral summary (from `features_json`); absent until
 * enriched. Inferred from `TrackFeaturesSchema` (./orpc/_shared.ts).
 */
export type TrackFeatures = z.infer<typeof TrackFeaturesSchema>;

/**
 * A finding as the feed/log/admin board renders it; emitted by `/api/tracks` and
 * `/api/tracks/:id`. Inferred from `TrackListItemSchema` (./orpc/_shared.ts), the
 * schema the route validates its body against — so this DTO cannot drift from the
 * wire. Field docs live on the schema.
 */
export type TrackListItem = z.infer<typeof TrackListItemSchema>;

/** The cursor for feed pagination (base64'd `addedAt` + `trackId`). */
export type TrackCursor = {
  addedAt: string;
  trackId: string;
};

/** A findings-only page (the admin board's default view). */
export type TrackListPage = {
  nextCursor?: string;
  totalCount: number;
  tracks: TrackListItem[];
};

// ── Mixtape ──────────────────────────────────────────────────────────────────

// "distributing" = minted (Log ID + title committed, cover renders) but assets are
// still uploading to the platforms; not yet public. The first successful platform
// link flips it to "published". So a published mixtape always has ≥1 listen link.
// There is no "draft": a mixtape is only ever BORN via `promote_recording` (RFC
// plan→recording→mixtape) — pre-publish authoring lives on PLANS (`recordings`
// kind=plan), and the promote claim inserts straight into `distributing`
// (unminted while `logId` is still null, minted within the same promote).
export type MixtapeStatus = "distributing" | "published";

export type MixtapeExternalUrls = {
  mixcloud?: string;
  soundcloud?: string;
  youtube?: string;
};

/** A mixtape member is a finding with an optional cue offset. */
export type MixtapeMember = TrackListItem & {
  startMs?: number;
};

/**
 * A mixtape as the `/mixtapes` surface + `/api/mixtapes` emit it. `status` is
 * always present (NOT NULL column). Inferred from `MixtapeDTOSchema`
 * (./orpc/_shared.ts) — its `members` is the `MixtapeMember` shape (a finding +
 * optional cue) and its `externalUrls` the `MixtapeExternalUrls` shape.
 */
export type MixtapeDTO = z.infer<typeof MixtapeDTOSchema>;

// ── Feed (findings + mixtapes merged) ────────────────────────────────────────

/** A feed item: a finding or a mixtape. */
export type FeedItem = MixtapeDTO | TrackListItem;

/** The merged feed page (findings + mixtapes); emitted by `/api/tracks` when unwindowed. */
export type FeedListPage = Omit<TrackListPage, "tracks"> & {
  tracks: FeedItem[];
};

/** `/api/tracks` response (the merged feed page; no `ok` envelope — the page is the body). */
export type TracksResponse = FeedListPage;

/** `/api/tracks/random` response. */
export type RandomTrackResponse = Ok<{ track: TrackListItem }>;

/** `/api/tracks/:idOrLogId` response: a finding or a mixtape. */
export type TrackGetResponse = Ok<{ track: TrackListItem }> | Ok<{ mixtape: MixtapeDTO }>;

// ── Radio (the shared broadcast clock) ───────────────────────────────────────

/**
 * The radio.fluncle.com now-playing slot on the shared loop (RFC
 * radio-broadcast.md Unit A). Inferred from `RadioNowPlayingSchema`
 * (./orpc/_shared.ts) — the schema the `/radio/now-playing` op validates against.
 */
export type RadioNowPlaying = z.infer<typeof RadioNowPlayingSchema>;

/** `/api/v1/radio/now-playing` response. */
export type RadioNowPlayingResponse = Ok<{ nowPlaying: RadioNowPlaying }>;

// ── Mixtape API envelopes ────────────────────────────────────────────────────

export type MixtapesResponse = Ok<{ mixtapes: MixtapeDTO[] }>;

// ── Mixtape clips (Fluncle Studio Unit C/D/G) ────────────────────────────────
// A clip is a lightweight 9:16 derivative cut from a mixtape's set video — many per
// set, NOT a spine object (no Log ID). Inferred from `ClipDTOSchema` (./orpc/_shared)
// so the wire shape cannot drift. The CLI (`fluncle admin clips list|cut`) + the box
// clip-cut cron read these.

/** A clip row as the clip ops emit it. */
export type ClipDTO = z.infer<typeof ClipDTOSchema>;

/** `GET /api/admin/clips` response: every clip (optionally filtered by mixtape/status). */
export type ClipsResponse = Ok<{ clips: ClipDTO[] }>;

/**
 * `POST /api/admin/clips/:clipId/cut/presign` response (Unit C): the single presigned
 * PUT URL the box streams `<clipId>/footage.mp4` to, plus the exact `contentType`
 * it MUST replay on the PUT (baked into the signature).
 */
export type ClipPresignResponse = Ok<{
  clipId: string;
  contentType: string;
  key: string;
  url: string;
}>;

/** `POST /api/admin/clips/:clipId/cut/finalize` response (Unit C): the clip, marked done. */
export type ClipCutFinalizeResponse = Ok<{ clip: ClipDTO }>;

// ── Clip drip-feed (clip-drip-feed RFC) ──────────────────────────────────────
// One clip's Instagram drip-feed schedule + status (the `mixtape_clip_social_posts`
// row). The CLI (`fluncle admin clips list|schedule|drip-pause|drip-resume`) reads these.

/** A clip's Instagram drip-feed state. */
export type ClipSocialPost = {
  caption?: string;
  clipId: string;
  createdAt: string;
  platform: string;
  postedUrl?: string;
  postizId?: string;
  scheduledFor: string;
  status: "failed" | "posted" | "scheduled";
  updatedAt: string;
};

/** `GET /api/admin/clips/social` response: every clip's drip-feed row. */
export type ClipSocialPostsResponse = Ok<{ posts: ClipSocialPost[] }>;

/** `PATCH /api/admin/clips/:clipId/schedule` response: the (re)scheduled clip post. */
export type ClipScheduleResponse = Ok<{ post: ClipSocialPost }>;

/** `PUT /api/admin/clips/drip/state` response: the resulting paused state. */
export type ClipDripStateResponse = Ok<{ paused: boolean }>;

// ── Recordings (RFC recording-primitive, Design B) ───────────────────────────
// A recording is a captured DJ set that is NOT (yet) a published mixtape — it OWNS its
// R2 key, carries an optional cue tracklist, and is coordinate-less until `promote`.
// Inferred from the Zod schemas (./orpc/_shared) so the wire shape cannot drift. The
// CLI (`fluncle admin recordings …`) + the box clip-cut cron read these.

/** A recording tracklist cue (`{ id, artists, title, startMs? }`). */
export type RecordingTracklistItem = z.infer<typeof RecordingTracklistItemSchema>;

/** A recording row as the recording ops emit it (with the promoted logId/mixtapeId if any). */
export type RecordingDTO = z.infer<typeof RecordingDTOSchema>;

/** `GET /api/admin/recordings` response: every recording, newest first. */
export type RecordingsResponse = Ok<{ recordings: RecordingDTO[] }>;

/** The `{ recording }` envelope create/get/update/promote return. */
export type RecordingResponse = Ok<{ recording: RecordingDTO }>;

/**
 * `POST /api/admin/recordings/:recordingId/set-video/presign` response: the opened
 * multipart upload's id + owned key plus every presigned URL the CLI needs to drive it
 * (one PUT URL per part, the completion POST URL, the abort DELETE URL). The clone of
 * the mixtape set-video presign targeting `recordings/<recordingId>/set.mp4`.
 */
export type RecordingSetVideoPresignResponse = Ok<{
  abortUrl: string;
  completeUrl: string;
  key: string;
  parts: { partNumber: number; url: string }[];
  recordingId: string;
  uploadId: string;
}>;

export type MixtapeUpdateResponse = Ok<{ mixtape: MixtapeDTO }>;

// ── Attention (the /admin queue digest) ──────────────────────────────────────

/** One of the attention queue's seven sources. */
export type AttentionSource = z.infer<typeof AttentionSourceSchema>;

/** One waiting row — the source, the object line, and the `/admin/…` deep-link path. */
export type AttentionRow = z.infer<typeof AttentionRowSchema>;

/** One source's waiting count (non-zero), in priority order. */
export type AttentionSourceCount = z.infer<typeof AttentionSourceCountSchema>;

/** The menu-bar digest of the attention snapshot (`get_attention`). */
export type AttentionQueue = z.infer<typeof AttentionQueueSchema>;

/** `GET /api/admin/attention` response — the queue digest + the day's dispatch. */
export type AttentionResponse = Ok<{ attention: AttentionQueue }>;

// ── Edition (the newsletter archive) ─────────────────────────────────────────

/**
 * A newsletter edition as the `/newsletter` archive + `/api/v1/newsletter/editions`
 * emit it. NOT a collectible — a plain
 * integer `number` (minted on send), no Log ID, no coordinate. Inferred from
 * `EditionDTOSchema` (./orpc/_shared.ts), so this DTO cannot drift from the wire.
 */
export type EditionDTO = z.infer<typeof EditionDTOSchema>;

export type EditionsResponse = Ok<{ editions: EditionDTO[] }>;
export type EditionResponse = Ok<{ edition: EditionDTO }>;

// ── Logbook (Fluncle's Logbook — one travelogue entry per sector-day) ─────────

/**
 * One Logbook entry as the public `/logbook` index + `/logbook/<sector>` page (and
 * the admin `create_logbook_entry` / `update_logbook_entry` ops) emit it. `sector`
 * is the days-since-epoch coordinate (sectorDay()); `body` is markdown with
 * `[[<logId>]]` figure tokens. Plain TS type (the wire is a flat row); a zod schema
 * would add nothing the row shape doesn't already pin. `generatedBy` is `agent` for
 * a cron-authored entry, `operator` once a human has edited it.
 */
export type LogbookEntryDTO = {
  body: string;
  generatedAt: string;
  generatedBy: "agent" | "operator";
  sector: number;
  title: string;
};

/** One eligible sector-day the logbook sweep can author — the day + its findings' material. */
export type LogbookGap = {
  /** ISO date (UTC midnight) of the sector-day, for the authoring prompt's dateline. */
  date: string;
  findings: LogbookGapFinding[];
  sector: number;
};

/** A day's finding as the sweep gathers it (admin-tier read — includes the internal fuel). */
export type LogbookGapFinding = {
  artists: string[];
  /** The internal firecrawl-derived facts (never public) — authoring fuel only. */
  contextNote?: string;
  logId: string;
  /** The public editorial note (the `/log` "why"), when present. */
  note?: string;
  /** The spoken observation transcript (internal), when present — authoring fuel. */
  observationScript?: string;
  /** The finding's poster "photo" URL on found.fluncle.com — the figure token target. */
  posterUrl: string;
  title: string;
};

export type LogbookEntriesResponse = Ok<{ entries: LogbookEntryDTO[] }>;
export type LogbookEntryResponse = Ok<{ entry: LogbookEntryDTO; skipped?: boolean }>;
export type LogbookGapsResponse = Ok<{ gaps: LogbookGap[] }>;

// ── Subscription (the operator's private cost ledger, COST-02) ───────────────

/**
 * One line in the operator's private cost ledger — a recurring or one-off Fluncle
 * spend. Operator-tier only (never a public route). Inferred from
 * `SubscriptionDTOSchema` (./orpc/_shared.ts), so this DTO cannot drift from the wire.
 */
export type SubscriptionDTO = z.infer<typeof SubscriptionDTOSchema>;

export type SubscriptionsResponse = Ok<{ subscriptions: SubscriptionDTO[] }>;
export type SubscriptionResponse = Ok<{ subscription: SubscriptionDTO }>;

// ── Mixtape distribution (audio→Mixcloud, video→YouTube) ─────────────────────
// One CLI command mints a mixtape into `distributing`, moves the local bytes to
// each platform, and records the outcome here. `platform` is a plain string so
// "soundcloud" can join later with no contract churn.

/**
 * A per-platform distribution row (the `mixtape_social_posts` table). Inferred
 * from `MixtapeSocialPostItemSchema` (./orpc/_shared.ts).
 */
export type MixtapeSocialPostItem = z.infer<typeof MixtapeSocialPostItemSchema>;

/** `/api/admin/mixtapes/:id/social` response: the mixtape's per-platform distribution rows. */
export type MixtapeSocialShowResponse = Ok<{ mixtapeId: string; posts: MixtapeSocialPostItem[] }>;

/** A distribution finalize (any platform): the mixtape after the link was recorded. */
export type MixtapeDistributeFinalizeResponse = Ok<{ mixtape: MixtapeDTO; platform: string }>;

/** `/api/admin/youtube/auth/start` response (mirrors the Spotify shape). */
export type YouTubeAuthStartResponse = Ok<{ authUrl: string }>;

/** `/api/admin/mixcloud/auth/start` response. */
export type MixcloudAuthStartResponse = Ok<{ authUrl: string }>;

/**
 * `/api/admin/lastfm/auth/start` response: the Last.fm desktop-auth request token
 * plus the authorize URL to approve it in-browser (logged in as `fluncle`). The
 * token is then handed to `/api/admin/lastfm/auth/session` to mint the session key.
 */
export type LastfmAuthStartResponse = Ok<{ authUrl: string; token: string }>;

/**
 * `/api/admin/lastfm/auth/session` response: the durable (non-expiring) session
 * key Maurice sets as the LASTFM_SESSION_KEY Worker secret, plus the authenticated
 * Last.fm username.
 */
export type LastfmAuthSessionResponse = Ok<{ name: string; sessionKey: string }>;

/** `/api/admin/mixcloud/token` response: the access token for the CLI-direct upload. */
export type MixcloudTokenResponse = Ok<{ accessToken: string }>;

/**
 * `/api/admin/mixtapes/:id/youtube/initiate` response: the resumable session URI
 * AND a short-lived access token — the YouTube data PUT is NOT self-authorizing,
 * so the CLI needs the Bearer token alongside the URI.
 */
export type MixtapeYouTubeInitiateResponse = Ok<{ accessToken: string; sessionUri: string }>;

/**
 * `/api/admin/mixtapes/:id/youtube/resync` response: the live video URL + id after
 * its description + chapters were re-derived from the current cues and pushed via
 * `videos.update` (no re-upload).
 */
export type MixtapeYouTubeResyncResponse = Ok<{ url: string; videoId: string }>;

/**
 * `/api/admin/mixtapes/:id/mixcloud/resync` response: the live cloudcast URL after
 * its `sections[]` tracklist was re-derived from the current cues and pushed via the
 * Mixcloud edit endpoint (sections-only, no audio re-upload). Server-side (the Worker
 * holds the `mixcloud_auth` token), the parity twin of the YouTube leg.
 */
export type MixtapeMixcloudResyncResponse = Ok<{ url: string }>;

/**
 * `/api/admin/mixtapes/:id/set-video/presign` response (Fluncle Studio Unit A): the
 * opened multipart upload's id + key plus every presigned URL the CLI needs to drive
 * it — one PUT URL per part, the completion POST URL, and the abort DELETE URL. The
 * ~1.5GB rendition streams straight to R2; the Worker never proxies the bytes.
 */
export type MixtapeSetVideoPresignResponse = Ok<{
  abortUrl: string;
  completeUrl: string;
  key: string;
  logId: string;
  mixtapeId: string;
  parts: { partNumber: number; url: string }[];
  uploadId: string;
}>;

// ── Submission ───────────────────────────────────────────────────────────────

export type SubmissionSource = "web" | "cli" | "ssh";
export type SubmissionStatus = "pending" | "approved" | "rejected";

/** A finding submission as `/api/submissions` records it. Inferred from `SubmissionSchema` (./orpc/_shared.ts). */
export type Submission = z.infer<typeof SubmissionSchema>;

export type SubmissionsResponse = Ok<{ submissions: Submission[] }>;
export type SubmissionResponse = Ok<{ submission: Submission }>;

// ── Social ───────────────────────────────────────────────────────────────────

/** A per-platform post row (the `social_posts` table). Inferred from `SocialPostItemSchema` (./orpc/_shared.ts). */
export type SocialPostItem = z.infer<typeof SocialPostItemSchema>;

export type SocialStatusUpdate = {
  scheduledFor?: string;
  status: "failed" | "published" | "scheduled";
  url?: string;
};

/** `/api/admin/tracks/:id/social` response. */
export type TrackSocialShowResponse = Ok<{ posts: SocialPostItem[]; trackId: string }>;

/** `/api/admin/tracks/:id/social/:platform` PATCH response. */
export type TrackSocialUpdateResponse = Ok<{ platform: string; status: string; trackId: string }>;

/** `/api/admin/tracks/:id/social/:platform/draft` POST response. */
export type TrackDraftResponse = Ok<{
  externalId: string;
  platform: string;
  status: string;
  trackId: string;
}>;

// ── Search ───────────────────────────────────────────────────────────────────

/** A Spotify search candidate (`/api/search`). Inferred from `TrackSearchResultSchema` (./orpc/_shared.ts). */
export type TrackSearchResult = z.infer<typeof TrackSearchResultSchema>;

export type SearchResponse = Ok<{ results: TrackSearchResult[] }>;

// ── Add / publish ────────────────────────────────────────────────────────────

/** `/api/admin/tracks` POST response (the add-track result). */
export type PublishTrackResult = {
  addedToSpotify: boolean;
  dryRun: boolean;
  message: string;
  postedToTelegram: boolean;
  track: {
    album?: string;
    albumImageUrl?: string;
    artists: string[];
    durationMs: number;
    isrc?: string;
    label?: string;
    logId?: string;
    logPageUrl?: string;
    popularity?: number;
    previewUrl?: string;
    spotifyUrl: string;
    title: string;
    trackId: string;
  };
};

export type PublishTrackResponse = Ok<PublishTrackResult>;

// ── Video bundle (presigned direct-to-R2) ────────────────────────────────────

export type PresignedUpload = {
  contentType: string;
  field: string;
  key: string;
  url: string;
};

/** `/api/admin/tracks/:id/video/uploads` response. */
export type PresignResponse = Ok<{ logId: string; trackId: string; uploads: PresignedUpload[] }>;

/** `/api/admin/tracks/:id/video/finalize` response. */
export type FinalizeResponse = Ok<{ logId: string; trackId: string; videoUrl: string }>;

// ── Newsletter ───────────────────────────────────────────────────────────────

export type SubscribeResponse = Ok<{}>;

// ── Auth ─────────────────────────────────────────────────────────────────────

/** `/api/admin/spotify/auth/start` response. */
export type SpotifyAuthStartResponse = Ok<{ authUrl: string }>;

// ── Track update ─────────────────────────────────────────────────────────────

/** `/api/admin/tracks/:id` PATCH response. */
export type TrackUpdateResult = {
  fields: string[];
  trackId: string;
};
export type TrackUpdateResponse = Ok<TrackUpdateResult>;

// ── Request DTOs (typed bodies the CLI sends; the web validates `unknown` separately) ──

export type PublishTrackRequest = {
  dryRun?: boolean;
  note?: string;
  spotifyUrl: string;
};

export type NewsletterRequest = {
  email: string;
  honeypot?: string;
};

export type SubmissionRequest = {
  album?: string;
  artists: string[];
  artworkUrl?: string;
  contact?: string;
  honeypot?: string;
  note?: string;
  source: SubmissionSource;
  spotifyTrackId: string;
  spotifyUrl: string;
  title: string;
};

export type TrackSocialUpdateRequest = {
  scheduledFor?: string;
  status: string;
  url?: string;
};

export type MixtapeRequestBody = {
  durationMs?: number;
  note?: string;
  recordedAt?: string;
  // YouTube + Mixcloud links come from `distribute` (mixtape_social_posts); only the
  // manual SoundCloud link is settable here (it too becomes a distribution row).
  soundcloudUrl?: string;
};
