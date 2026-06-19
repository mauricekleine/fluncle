// The Fluncle API contract — the shapes the web app emits and the CLI, Raycast,
// and external agents consume. Pure types (no runtime): the web stays the source
// of truth for logic + the drizzle schema; this package is the single place the
// public DTOs + response envelopes are defined, so the CLI/Raycast mirrors can't
// drift (they did before — CLI `RecentTrack` was missing 7 fields, `AddTrackResult`
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

// ── Track ────────────────────────────────────────────────────────────────────

/** Enrichment's track-level spectral summary (from `features_json`); absent until enriched. */
export type TrackFeatures = {
  centroidHz?: number;
  highRatio?: number;
  midFlatness?: number;
  onsetRate?: number;
  subBassRatio?: number;
};

/** A finding as the feed/log/admin board renders it; emitted by `/api/tracks` and `/api/tracks/:id`. */
export type TrackListItem = {
  addedAt: string;
  addedToSpotify: boolean;
  album?: string;
  albumImageUrl?: string;
  artists: string[];
  bpm?: number;
  durationMs: number;
  enrichmentStatus: string;
  features?: TrackFeatures;
  galaxy?: { key: Galaxy; name: string };
  isrc?: string;
  key?: string;
  label?: string;
  logId?: string;
  /** The finding's permanent log page on fluncle.com; absent until a Log ID exists. */
  logPageUrl?: string;
  note?: string;
  popularity?: number;
  postedToTelegram: boolean;
  previewUrl?: string;
  releaseDate?: string;
  spotifyUrl: string;
  tiktokUrl?: string;
  title: string;
  trackId: string;
  type?: "finding";
  updatedAt?: string;
  videoModel?: string;
  videoModelReasoning?: string;
  videoUrl?: string;
  videoVehicle?: string;
  vibeX?: number;
  vibeY?: number;
  youtubeUrl?: string;
};

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
export type MixtapeStatus = "distributing" | "draft" | "published";

export type MixtapeExternalUrls = {
  mixcloud?: string;
  soundcloud?: string;
  youtube?: string;
};

/** A mixtape member is a finding with an optional cue offset. */
export type MixtapeMember = TrackListItem & {
  startMs?: number;
};

/** A mixtape as the `/mixtapes` surface + `/api/mixtapes` emit it. `status` is always present (NOT NULL column). */
export type MixtapeDTO = {
  addedAt?: string;
  artists: ["Fluncle"];
  coverImageUrl?: string;
  createdAt?: string;
  durationMs?: number;
  externalUrls: MixtapeExternalUrls;
  id?: string;
  logId?: string;
  memberCount: number;
  members: MixtapeMember[];
  note?: string;
  publishedAt?: string;
  recordedAt?: string;
  sequenceNumber?: number;
  status: MixtapeStatus;
  title: string;
  type: "mixtape";
  updatedAt?: string;
};

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

// ── Mixtape API envelopes ────────────────────────────────────────────────────

export type MixtapesResponse = Ok<{ mixtapes: MixtapeDTO[] }>;
export type MixtapeCreateResponse = Ok<{ mixtape: MixtapeDTO }>;
export type MixtapeUpdateResponse = Ok<{ mixtape: MixtapeDTO }>;
export type MixtapePublishResponse = Ok<{ mixtape: MixtapeDTO }>;
export type MixtapeDeleteResponse = Ok<{}>;

// ── Mixtape distribution (audio→Mixcloud, video→YouTube) ─────────────────────
// One CLI command mints a mixtape into `distributing`, moves the local bytes to
// each platform, and records the outcome here. `platform` is a plain string so
// "soundcloud" can join later with no contract churn.

/** A per-platform distribution row (the `mixtape_social_posts` table). */
export type MixtapeSocialPostItem = {
  createdAt: string;
  externalId?: string;
  platform: string;
  publishedAt?: string;
  status: string;
  updatedAt: string;
  url?: string;
};

/** `/api/admin/mixtapes/:id/social` response: the mixtape's per-platform distribution rows. */
export type MixtapeSocialShowResponse = Ok<{ mixtapeId: string; posts: MixtapeSocialPostItem[] }>;

/** A distribution finalize (any platform): the mixtape after the link was recorded. */
export type MixtapeDistributeFinalizeResponse = Ok<{ mixtape: MixtapeDTO; platform: string }>;

/** `/api/admin/youtube/auth/start` response (mirrors the Spotify shape). */
export type YouTubeAuthStartResponse = Ok<{ authUrl: string }>;

/**
 * `/api/admin/mixtapes/:id/youtube/initiate` response: the resumable session URI
 * AND a short-lived access token — the YouTube data PUT is NOT self-authorizing,
 * so the CLI needs the Bearer token alongside the URI.
 */
export type MixtapeYouTubeInitiateResponse = Ok<{ accessToken: string; sessionUri: string }>;

// ── Submission ───────────────────────────────────────────────────────────────

export type SubmissionSource = "web" | "cli" | "ssh";
export type SubmissionStatus = "pending" | "approved" | "rejected";

export type Submission = {
  album?: string;
  artworkUrl?: string;
  artists: string[];
  contact?: string;
  createdAt: string;
  id: string;
  note?: string;
  reviewedAt?: string;
  source: SubmissionSource;
  spotifyTrackId: string;
  spotifyUrl: string;
  status: SubmissionStatus;
  title: string;
};

export type SubmissionsResponse = Ok<{ submissions: Submission[] }>;
export type SubmissionResponse = Ok<{ submission: Submission }>;

// ── Social ───────────────────────────────────────────────────────────────────

/** A per-platform post row (the `social_posts` table). */
export type SocialPostItem = {
  createdAt: string;
  externalId?: string;
  platform: string;
  publishedAt?: string;
  scheduledFor?: string;
  status: string;
  updatedAt: string;
  url?: string;
};

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

/** A Spotify search candidate (`/api/search`). */
export type TrackSearchResult = {
  album?: string;
  artworkUrl?: string;
  artists: string[];
  id: string;
  spotifyUrl: string;
  title: string;
};

export type SearchResponse = Ok<{ results: TrackSearchResult[] }>;

// ── Add / publish ────────────────────────────────────────────────────────────

/** `/api/admin/tracks` POST response (the add-track result). */
export type AddTrackResult = {
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

export type AddTrackResponse = Ok<AddTrackResult>;

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

export type AddTrackRequest = {
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
  mixcloudUrl?: string;
  note?: string;
  recordedAt?: string;
  soundcloudUrl?: string;
  youtubeUrl?: string;
};

export type CueEntry = { ref: string; startMs?: number };

export type MixtapeMembersRequest = {
  members: Array<CueEntry | string>;
};
