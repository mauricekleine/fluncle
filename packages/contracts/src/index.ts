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
import {
  type EditionDTOSchema,
  type MixtapeDTOSchema,
  type MixtapeSocialPostItemSchema,
  type SocialPostItemSchema,
  type SubmissionSchema,
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

// ── Mixtape API envelopes ────────────────────────────────────────────────────

export type MixtapesResponse = Ok<{ mixtapes: MixtapeDTO[] }>;
export type MixtapeCreateResponse = Ok<{ mixtape: MixtapeDTO }>;
export type MixtapeUpdateResponse = Ok<{ mixtape: MixtapeDTO }>;
export type MixtapePublishResponse = Ok<{ mixtape: MixtapeDTO }>;
export type MixtapeDeleteResponse = Ok<{}>;

// ── Edition (the newsletter archive) ─────────────────────────────────────────

/**
 * A newsletter edition as the `/newsletter` archive + `/api/v1/newsletter/editions`
 * emit it (docs/rfcs/newsletter-own-the-stack.md). NOT a collectible — a plain
 * integer `number` (minted on send), no Log ID, no coordinate. Inferred from
 * `EditionDTOSchema` (./orpc/_shared.ts), so this DTO cannot drift from the wire.
 */
export type EditionDTO = z.infer<typeof EditionDTOSchema>;

export type EditionsResponse = Ok<{ editions: EditionDTO[] }>;
export type EditionResponse = Ok<{ edition: EditionDTO }>;

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
  note?: string;
  recordedAt?: string;
  // YouTube + Mixcloud links come from `distribute` (mixtape_social_posts); only the
  // manual SoundCloud link is settable here (it too becomes a distribution row).
  soundcloudUrl?: string;
};

export type CueEntry = { ref: string; startMs?: number };

export type MixtapeMembersRequest = {
  members: Array<CueEntry | string>;
};
