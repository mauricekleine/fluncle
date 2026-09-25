import { type z } from "zod";
import { type AlbumDetailSchema, type AlbumListItemSchema } from "./orpc/albums.js";
import { type ArtistListItemSchema } from "./orpc/artists.js";
import {
  type AddArtistRuleInputSchema,
  type ArtistRuleInputSchema,
  type ArtistRuleSchema,
  type ArtistRuleSourceSchema,
  type ArtistRuleVerdictSchema,
  type LabelArtistRuleVerdictSchema,
} from "./orpc/admin-artist-rules.js";
import { type PushCategorySchema } from "./orpc/devices.js";
import { type LabelDetailSchema, type LabelListItemSchema } from "./orpc/labels.js";
import {
  type AttentionQueueSchema,
  type AttentionRowSchema,
  type AttentionSourceCountSchema,
  type AttentionSourceSchema,
} from "./orpc/admin-attention.js";
import {
  type CaptureBudgetStateSchema,
  type CapturePriorityReasonSchema,
  type CatalogueLensSchema,
  type CatalogueMatchSchema,
  type CatalogueSummarySchema,
  type CatalogueTrackItemSchema,
} from "./orpc/admin-catalogue.js";
import {
  type TrackWorkItemSchema,
  type TrackWorkKindSchema,
  type TrackWorkScopeSchema,
} from "./orpc/admin-tracks.js";
import { type ServiceHealthStatusSchema } from "./orpc/admin-health.js";
import { type GalaxyAdminItemSchema, type TrackEmbeddingSchema } from "./orpc/admin-galaxies.js";
import {
  type LabelAdminItemSchema,
  type LabelAliasCandidateSchema,
  type LabelAliasKindSchema,
  type LabelAliasSourceSchema,
  type LabelSeedStateSchema,
  type LabelTriageVerdictSchema,
  type RecordLabelTriageBodySchema,
  type LabelTakeOverResultSchema,
  type MergeLabelResultSchema,
  type MintLabelOutcomeSchema,
} from "./orpc/admin-labels.js";
import { type UserAdminItemSchema, type UserStatusSchema } from "./orpc/admin-users.js";
import { type NoteGateSchema, type NoteRejectionSchema } from "./orpc/admin-notes.js";
import {
  type ObservationGateSchema,
  type ObservationRejectionSchema,
} from "./orpc/admin-observations.js";
import { type GalaxyListItemSchema } from "./orpc/galaxies.js";
import { type GalaxyProgressSchema } from "./orpc/me-galaxy.js";
import { type MixArtistSchema } from "./orpc/mix.js";
import {
  type ClipDTO,
  type EditionDTOSchema,
  type FreshAlbumSchema,
  type FreshTrackSchema,
  type MixtapeDTOSchema,
  type MixtapeSocialPostItemSchema,
  type PublicUserSchema,
  type RadioNowPlayingSchema,
  type RecordingDTO,
  type MixCandidateSchema,
  type MixReasonSchema,
  type MixTrackSchema,
  type RecordingTracklistItem,
  type SocialPostItemSchema,
  type SubmissionSchema,
  type SubscriptionDTOSchema,
  type TrackFeaturesSchema,
  type TrackListItemSchema,
  type TrackSearchResultSchema,
} from "./orpc/_shared.js";

export type { SearchEntity, SearchFilters, SearchHit, SearchKind } from "./orpc/search.js";
export type { VectorServingReason, VectorServingStatus } from "./orpc/admin-vectors.js";
export type { ClipDTO, RecordingDTO, RecordingTracklistItem };

export type Ok<T> = { ok: true } & T;

export type ApiFailure = {
  ok: false;
  code: string;
  message: string;
};

export type CataloguePage = { page: number; pageCount: number; total: number };

export type ArtistListItem = z.infer<typeof ArtistListItemSchema>;

export type ArtistsResponse = Ok<{ artists: ArtistListItem[] } & CataloguePage>;

export type ArtistGetResponse = Ok<{ artist: ArtistListItem }>;

export type AlbumListItem = z.infer<typeof AlbumListItemSchema>;

export type AlbumDetail = z.infer<typeof AlbumDetailSchema>;

export type AlbumsResponse = Ok<{ albums: AlbumListItem[] } & CataloguePage>;

export type AlbumGetResponse = Ok<{ album: AlbumDetail }>;

export type LabelListItem = z.infer<typeof LabelListItemSchema>;

export type LabelDetail = z.infer<typeof LabelDetailSchema>;

export type LabelsResponse = Ok<{ labels: LabelListItem[] } & CataloguePage>;

export type LabelGetResponse = Ok<{ label: LabelDetail }>;

export type GalaxyListItem = z.infer<typeof GalaxyListItemSchema>;

export type GalaxiesResponse = Ok<{ galaxies: GalaxyListItem[] }>;

export type GalaxyResponse = Ok<{ findings: TrackListItem[]; galaxy: GalaxyListItem }>;

export type GalaxyAdminItem = z.infer<typeof GalaxyAdminItemSchema>;

export type GalaxiesAdminResponse = Ok<{ galaxies: GalaxyAdminItem[] }>;

export type GalaxyMapUpdateResponse = Ok<{ galaxies: GalaxyAdminItem[] }>;

export type LabelSeedState = z.infer<typeof LabelSeedStateSchema>;
export type LabelTriageVerdict = z.infer<typeof LabelTriageVerdictSchema>;

export type RecordLabelTriageBody = z.input<typeof RecordLabelTriageBodySchema>;

export type LabelAdminItem = z.infer<typeof LabelAdminItemSchema>;

export type ArtistRule = z.infer<typeof ArtistRuleSchema>;

export type ArtistRuleInput = z.infer<typeof ArtistRuleInputSchema>;

export type AddArtistRuleInput = z.infer<typeof AddArtistRuleInputSchema>;

export type ArtistRuleVerdict = z.infer<typeof ArtistRuleVerdictSchema>;

export type LabelArtistRuleVerdict = z.infer<typeof LabelArtistRuleVerdictSchema>;

export type ArtistRuleSource = z.infer<typeof ArtistRuleSourceSchema>;

export type ArtistRulesResponse = Ok<{ rules: ArtistRule[] }>;

export type ArtistRuleAddResponse = Ok<{ rule: ArtistRule }>;

export type MergeLabelResult = z.infer<typeof MergeLabelResultSchema>;

export type MintLabelOutcome = z.infer<typeof MintLabelOutcomeSchema>;

export type LabelTakeOverResult = z.infer<typeof LabelTakeOverResultSchema>;

export type UserStatus = z.infer<typeof UserStatusSchema>;

export type UserAdminItem = z.infer<typeof UserAdminItemSchema>;

export type LabelAliasSource = z.infer<typeof LabelAliasSourceSchema>;

export type LabelAliasKind = z.infer<typeof LabelAliasKindSchema>;

export type LabelAliasCandidate = z.infer<typeof LabelAliasCandidateSchema>;

export type NoteGate = z.infer<typeof NoteGateSchema>;

export type NoteRejection = z.infer<typeof NoteRejectionSchema>;

export type NoteRejectionsResponse = Ok<{ gate: NoteGate; rejections: NoteRejection[] }>;

export type ObservationGate = z.infer<typeof ObservationGateSchema>;

export type ObservationRejection = z.infer<typeof ObservationRejectionSchema>;

export type ObservationRejectionsResponse = Ok<{
  gate: ObservationGate;
  rejections: ObservationRejection[];
}>;

export type CatalogueLens = z.infer<typeof CatalogueLensSchema>;

export type CapturePriorityReason = z.infer<typeof CapturePriorityReasonSchema>;

export type CatalogueMatch = z.infer<typeof CatalogueMatchSchema>;

export type CatalogueTrackItem = z.infer<typeof CatalogueTrackItemSchema>;

export type CatalogueSummary = z.infer<typeof CatalogueSummarySchema>;

export type CatalogueResponse = Ok<{ summary: CatalogueSummary; tracks: CatalogueTrackItem[] }>;

export type CaptureBudgetState = z.infer<typeof CaptureBudgetStateSchema>;

export type CaptureBudgetResponse = Ok<CaptureBudgetState>;

export type TrackWorkKind = z.infer<typeof TrackWorkKindSchema>;

export type TrackWorkScope = z.infer<typeof TrackWorkScopeSchema>;

export type TrackWorkItem = z.infer<typeof TrackWorkItemSchema>;

export type TrackEmbedding = z.infer<typeof TrackEmbeddingSchema>;

export type TrackEmbeddingsResponse = Ok<{
  embeddings: TrackEmbedding[];
  nextCursor: string | null;
}>;

export type PublicUser = z.infer<typeof PublicUserSchema>;

export type MeResponse = Ok<{ googleEnabled: boolean; user: PublicUser | null }>;

export type GalaxyProgress = z.infer<typeof GalaxyProgressSchema>;

export type ServiceHealthStatus = z.infer<typeof ServiceHealthStatusSchema>;

export type PushCategory = z.infer<typeof PushCategorySchema>;

export type TrackFeatures = z.infer<typeof TrackFeaturesSchema>;

export type TrackListItem = z.infer<typeof TrackListItemSchema>;

export type FreshTrack = z.infer<typeof FreshTrackSchema>;

export type FreshAlbum = z.infer<typeof FreshAlbumSchema>;

export type FreshTracksResponse = {
  albums: FreshAlbum[];
  tracks: FreshTrack[];
  windowDays: number;
};

export type MixReason = z.infer<typeof MixReasonSchema>;

export type MixTrack = z.infer<typeof MixTrackSchema>;

export type MixCandidate = z.infer<typeof MixCandidateSchema>;

export type MixArtist = z.infer<typeof MixArtistSchema>;

export type TrackCursor = {
  addedAt: string;
  trackId: string;
};

export type TrackListPage = {
  nextCursor?: string;
  totalCount: number;
  tracks: TrackListItem[];
};

export type MixtapeStatus = "distributing" | "published";

export type MixtapeExternalUrls = {
  mixcloud?: string;
  soundcloud?: string;
  youtube?: string;
};

export type MixtapeMember = TrackListItem & {
  startMs?: number;
};

export type MixtapeDTO = z.infer<typeof MixtapeDTOSchema>;

export type FeedItem = MixtapeDTO | TrackListItem;

export type FeedListPage = Omit<TrackListPage, "tracks"> & {
  tracks: FeedItem[];
};

export type TracksResponse = FeedListPage;

export type RandomTrackResponse = Ok<{ track: TrackListItem }>;

export type TrackGetResponse = Ok<{ track: TrackListItem }> | Ok<{ mixtape: MixtapeDTO }>;

export type RadioNowPlaying = z.infer<typeof RadioNowPlayingSchema>;

export type RadioNowPlayingResponse = Ok<{ nowPlaying: RadioNowPlaying }>;

export type MixtapesResponse = Ok<{ mixtapes: MixtapeDTO[] }>;

export type ClipsResponse = Ok<{ clips: ClipDTO[] }>;

export type ClipPresignResponse = Ok<{
  clipId: string;
  contentType: string;
  key: string;
  url: string;
}>;

export type ClipCutFinalizeResponse = Ok<{ clip: ClipDTO }>;

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

export type ClipSocialStatus = ClipSocialPost["status"];

export type ClipSocialPostsResponse = Ok<{ posts: ClipSocialPost[] }>;

export type ClipScheduleResponse = Ok<{ post: ClipSocialPost }>;

export type ClipDripStateResponse = Ok<{ paused: boolean }>;

export type RecordingsResponse = Ok<{ recordings: RecordingDTO[] }>;

export type RecordingResponse = Ok<{ recording: RecordingDTO }>;

export type MixtapeUpdateResponse = Ok<{ mixtape: MixtapeDTO }>;

export type StudioPeak = {
  atMs: number;
  kind: "drop";
  score: number;
};

export type StudioSuggestion = {
  anchorMs: number;
  durationMs: number;
  score: number;
  startMs: number;
};

export type StudioEnvelope = {
  bass: number[];
  bpm: number | null;
  durationMs: number;
  energy: number[];
  flux: number[];
  hopMs: number;
  peaks: StudioPeak[];
  suggestions: StudioSuggestion[];
};

export type AttentionSource = z.infer<typeof AttentionSourceSchema>;

export type AttentionRow = z.infer<typeof AttentionRowSchema>;

export type AttentionSourceCount = z.infer<typeof AttentionSourceCountSchema>;

export type AttentionQueue = z.infer<typeof AttentionQueueSchema>;

export type AttentionResponse = Ok<{ attention: AttentionQueue }>;

export type EditionDTO = z.infer<typeof EditionDTOSchema>;

export type EditionsResponse = Ok<{ editions: EditionDTO[] }>;
export type EditionResponse = Ok<{ edition: EditionDTO }>;

export type LogbookEntryDTO = {
  body: string;
  generatedAt: string;
  generatedBy: "agent" | "operator";
  sector: number;
  title: string;
};

export type LogbookGap = {
  date: string;
  findings: LogbookGapFinding[];
  sector: number;
};

export type LogbookGapFinding = {
  artists: string[];

  contextNote?: string;
  logId: string;

  note?: string;

  observationScript?: string;

  posterUrl: string;
  title: string;
};

export type LogbookSpentEntry = {
  closer: string;
  opener: string;
  sector: number;
  title: string;
};

export type LogbookEntryResponse = Ok<{ entry: LogbookEntryDTO; skipped?: boolean }>;
export type LogbookGapsResponse = Ok<{ gaps: LogbookGap[]; spent: LogbookSpentEntry[] }>;

export type SubscriptionDTO = z.infer<typeof SubscriptionDTOSchema>;

export type MixtapeSocialPostItem = z.infer<typeof MixtapeSocialPostItemSchema>;

export type MixtapeSocialShowResponse = Ok<{ mixtapeId: string; posts: MixtapeSocialPostItem[] }>;

export type MixtapeDistributeFinalizeResponse = Ok<{ mixtape: MixtapeDTO; platform: string }>;

export type YouTubeAuthStartResponse = Ok<{ authUrl: string }>;

export type RevokeAdminGrantsResponse = Ok<{ epoch: number }>;

export type MixcloudAuthStartResponse = Ok<{ authUrl: string }>;

export type TikTokAuthStartResponse = Ok<{ authUrl: string }>;

export type LastfmAuthStartResponse = Ok<{ authUrl: string; token: string }>;

export type LastfmAuthSessionResponse = Ok<{ name: string; sessionKey: string }>;

export type MixcloudTokenResponse = Ok<{ accessToken: string }>;

export type MixtapeYouTubeInitiateResponse = Ok<{ accessToken: string; sessionUri: string }>;

export type MixtapeYouTubeResyncResponse = Ok<{ url: string; videoId: string }>;

export type MixtapeMixcloudResyncResponse = Ok<{ url: string }>;

export type SubmissionSource = "web" | "cli" | "ssh";
export type SubmissionStatus = "pending" | "approved" | "rejected";

export type Submission = z.infer<typeof SubmissionSchema>;

export type SubmissionsResponse = Ok<{ submissions: Submission[] }>;
export type SubmissionResponse = Ok<{ submission: Submission }>;

export type SocialPostItem = z.infer<typeof SocialPostItemSchema>;

export type SocialStatusUpdate = {
  scheduledFor?: string;
  status: "failed" | "published" | "scheduled";
  url?: string;
};

export type PublishAdvancePush = {
  externalId: string;
  logId: string;
  platform: string;
  status: string;
  trackId: string;
};

export type PublishAdvanceHeld = {
  missing?: string[];
  platform: string;
  reason: string;
  trackId: string;
};

export type PublishAdvanceResponse = Ok<{
  candidates: number;
  failed: Array<{ platform: string; trackId: string }>;
  held: PublishAdvanceHeld[];
  paused: boolean;
  pushed: PublishAdvancePush[];
}>;

export type PublishAdvanceStateResponse = Ok<{ paused: boolean }>;

export type TrackSocialShowResponse = Ok<{ posts: SocialPostItem[]; trackId: string }>;

export type TrackSocialUpdateResponse = Ok<{ platform: string; status: string; trackId: string }>;

export type TrackSearchResult = z.infer<typeof TrackSearchResultSchema>;

export type SearchResponse = Ok<{ results: TrackSearchResult[] }>;

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

export type PresignedUpload = {
  contentType: string;
  field: string;
  key: string;
  url: string;
};

export type PresignResponse = Ok<{ logId: string; trackId: string; uploads: PresignedUpload[] }>;

export type FinalizeResponse = Ok<{ logId: string; trackId: string; videoUrl: string }>;

export type SubscribeResponse = Ok<{}>;

export type SpotifyAuthStartResponse = Ok<{ authUrl: string }>;

export type TrackUpdateResult = {
  fields: string[];
  trackId: string;
};
export type TrackUpdateResponse = Ok<TrackUpdateResult>;

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

export type MixtapeRequestBody = {
  durationMs?: number;
  note?: string;
  recordedAt?: string;

  soundcloudUrl?: string;
};
