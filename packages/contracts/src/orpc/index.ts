// The runtime oRPC contract registry — the contract-first source of truth the
// oRPC migration is built on. This is the
// `@fluncle/contracts/orpc` subpath entry.
//
// The pure-types `../index.ts` is the package's ZOD-FREE surface: the CLI,
// Raycast, and the browser extension import it and must never pull zod/@orpc
// into their bundles. This subpath is the *runtime* contract layer — `@orpc`
// ops whose I/O are Zod schemas — kept apart so those pure-types consumers stay
// clean. From these contracts derive, in one place that cannot disagree: the
// request/response validators, the typed `Router` client, and the generated
// OpenAPI document.
//
// COMPOSABLE BY DOMAIN. Each domain owns one module (`./tracks.ts`,
// `./health.ts`, …) exporting its ops; this root merges them into the single
// flat `contract` object. A new wave adds `./<domain>.ts` + one spread line
// here — it touches no other domain's file, so parallel agents converting
// different domains never collide.
//
// Naming follows the ratified Convention B: each op
// has a canonical `verb_noun` registry key whose camelCase projection is the
// OpenAPI `operationId` (`get_track` → `getTrack`). The REST path mirrors the
// live route; resources are plural, the op noun stays singular.

import { adminAlbumsContract } from "./admin-albums";
import { adminArtistsContract } from "./admin-artists";
import { adminAttentionContract } from "./admin-attention";
import { adminBackfillsContract } from "./admin-backfills";
import { adminCatalogueContract } from "./admin-catalogue";
import { adminCostsContract } from "./admin-costs";
import { adminGalaxiesContract } from "./admin-galaxies";
import { adminPromptsContract } from "./admin-prompts";
import { adminReachContract } from "./admin-reach";
import { albumsContract } from "./albums";
import { artistsContract } from "./artists";
import { galaxiesContract } from "./galaxies";
import { labelsContract } from "./labels";
import { graphContract } from "./graph";
import { adminEditionsContract } from "./admin-editions";
import { adminFrontierContract } from "./admin-frontier";
import { adminFunnelContract } from "./admin-funnel";
import { adminHealthContract } from "./admin-health";
import { adminLabelsContract } from "./admin-labels";
import { adminLogbookContract } from "./admin-logbook";
import { adminMigrationsContract } from "./admin-migrations";
import { adminMixtapesContract } from "./admin-mixtapes";
import { adminNotesContract } from "./admin-notes";
import { adminObservationsContract } from "./admin-observations";
import { adminRecordingsContract } from "./admin-recordings";
import { adminSocialContract } from "./admin-social";
import { adminSubmissionsContract } from "./admin-submissions";
import { adminSubscriptionsContract } from "./admin-subscriptions";
import { adminTokensContract } from "./admin-tokens";
import { adminTracksContract } from "./admin-tracks";
import { adminTwitchContract } from "./admin-twitch";
import { adminUsersContract } from "./admin-users";
import { devicesContract } from "./devices";
import { editionsContract } from "./editions";
import { healthContract } from "./health";
import { meContract } from "./me";
import { meFrontierContract } from "./me-frontier";
import { meGalaxyContract } from "./me-galaxy";
import { mePreferencesContract } from "./me-preferences";
import { meRecsContract } from "./me-recs";
import { meSavedContract } from "./me-saved";
import { meSetsContract } from "./me-sets";
import { meWatchesContract } from "./me-watches";
import { mixContract } from "./mix";
import { mixtapesContract } from "./mixtapes";
import { newsletterContract } from "./newsletter";
import { radioContract } from "./radio";
import { reachContract } from "./reach";
import { searchContract } from "./search";
import { storiesContract } from "./stories";
import { submissionsContract } from "./submissions";
import { tracksContract } from "./tracks";

// Re-export the per-op contracts so existing importers (and the typed client)
// keep their entrypoints.
export {
  AlbumDetailSchema,
  albumsContract,
  AlbumListItemSchema,
  getAlbum,
  listAlbums,
} from "./albums";
export { ArtistListItemSchema, artistsContract, getArtist, listArtists } from "./artists";
export {
  getLabel,
  LabelDetailSchema,
  LabelEdgeSchema,
  LabelListItemSchema,
  labelsContract,
  listLabels,
} from "./labels";
export {
  listMixableArtists,
  listMixOpeners,
  listSetTracks,
  MixArtistSchema,
  mixContract,
} from "./mix";
export { GalaxyListItemSchema, galaxiesContract, getGalaxy, listGalaxies } from "./galaxies";
export { getGraphPreview, GraphEntityKindSchema, graphContract, GraphPreviewSchema } from "./graph";
export {
  adminGalaxiesContract,
  GalaxyAdminItemSchema,
  listGalaxiesAdmin,
  listTrackEmbeddings,
  TrackEmbeddingSchema,
  updateGalaxy,
  updateGalaxyMap,
} from "./admin-galaxies";
export {
  adminAlbumsContract,
  describeAlbum,
  draftAlbumBio,
  listAlbumsMissingBio,
} from "./admin-albums";
export {
  addArtistSocial,
  adminArtistsContract,
  backfillArtistImages,
  backfillArtists,
  confirmArtistSocial,
  describeArtist,
  listArtistsMissingBio,
  listArtistSocials,
  removeArtistSocial,
  resolveArtist,
  ResolvedSocialSchema,
} from "./admin-artists";
export {
  AttentionQueueSchema,
  AttentionRowSchema,
  AttentionSourceCountSchema,
  AttentionSourceSchema,
  getAttention,
} from "./admin-attention";
export { backfillDiscogs, backfillLabelImages, backfillLastfm } from "./admin-backfills";
export {
  adminCatalogueContract,
  CapturePriorityReasonSchema,
  CatalogueLensSchema,
  CaptureBudgetStateSchema,
  CatalogueMatchSchema,
  CatalogueSummarySchema,
  CatalogueTrackItemSchema,
  crawlCatalogue,
  CrawlPassSchema,
  CrawlStatusSchema,
  getCaptureBudget,
  getCrawlStatus,
  listCatalogueTracks,
  rankCatalogue,
  setCaptureBudget,
} from "./admin-catalogue";
export {
  adminLabelsContract,
  confirmLabelAlias,
  describeLabel,
  LabelAdminItemSchema,
  LabelAliasCandidateSchema,
  LabelAliasKindSchema,
  LabelAliasSourceSchema,
  LabelSeedStateSchema,
  listLabelAliases,
  listLabelsAdmin,
  listLabelsMissingBio,
  mergeLabel,
  MergeLabelResultSchema,
  rejectLabelAlias,
  updateLabel,
} from "./admin-labels";
export { adminMigrationsContract, migratePreviewArchive } from "./admin-migrations";
export {
  adminNotesContract,
  listNoteRejections,
  NoteGateSchema,
  NoteRejectionSchema,
  resolveNoteRejection,
  updateNoteGate,
} from "./admin-notes";
export {
  adminObservationsContract,
  listObservationNeighbours,
  listObservationRejections,
  ObservationGateSchema,
  ObservationNeighbourSchema,
  ObservationRejectionSchema,
  resolveObservationRejection,
  updateObservationGate,
} from "./admin-observations";
export { type CostEventInput, CostEventInputSchema, recordCost } from "./admin-costs";
export { recordHealth, ServiceHealthStatusSchema } from "./admin-health";
export { adminReachContract, recordPlatformStats } from "./admin-reach";
export { listPlatformStats, reachContract } from "./reach";
export {
  adminPromptsContract,
  getPrompt,
  listPrompts,
  PromptSlugSchema,
  PromptSourceSchema,
  PromptSurfaceSchema,
  updatePrompt,
} from "./admin-prompts";
export { createLogbookEntry, listLogbookGaps, updateLogbookEntry } from "./admin-logbook";
export {
  createEdition,
  deleteEdition,
  listEditionsAdmin,
  sendEdition,
  updateEdition,
} from "./admin-editions";
export {
  createClip,
  deleteClip,
  finalizeClipCut,
  finalizeMixtapeMixcloud,
  finalizeMixtapeYoutube,
  getMixtapeSocial,
  initiateMixtapeYoutube,
  listClips,
  listMixtapesAdmin,
  presignClipUpload,
  publishMixtapeYoutube,
  setMixtapeCues,
  updateClip,
  updateMixtape,
  updateMixtapeCue,
} from "./admin-mixtapes";
export {
  createRecording,
  deleteRecording,
  getRecording,
  listRecordings,
  presignRecordingUpload,
  promoteRecording,
  updateRecording,
} from "./admin-recordings";
export { draftTrackSocial, listTrackSocial, updateTrackSocial } from "./admin-social";
export { deregisterDevice, registerDevice, sweepPushReceipts } from "./devices";
export { getEdition, listEditions } from "./editions";
export {
  approveSubmission,
  getSubmission,
  listSubmissions,
  rejectSubmission,
  triageSubmission,
} from "./admin-submissions";
export {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from "./admin-subscriptions";
export {
  exchangeLastfmSession,
  mintMixcloudToken,
  mintYoutubeToken,
  startLastfmAuth,
} from "./admin-tokens";
export {
  contextTrack,
  finalizeTrackVideo,
  getMixableOrder,
  getTrackAdmin,
  listTracksAdmin,
  listTrackWork,
  noteTrack,
  observeTrack,
  presignTrackVideoUploads,
  publishTrack,
  purgeVideo,
  requeueVideo,
  TrackWorkItemSchema,
  TrackWorkKindSchema,
  TrackWorkScopeSchema,
  updateTrack,
} from "./admin-tracks";
export { adminFrontierContract, refreshFrontierPlaylists } from "./admin-frontier";
export { adminFunnelContract, getFunnel, recordCatalogueSnapshot } from "./admin-funnel";
export {
  FrontierEditionSummarySchema,
  FrontierEditionTrackSchema,
  getPrivateFrontierEdition,
  getPrivateFrontierPlaylist,
  listPrivateFrontierEditions,
  meFrontierContract,
  mintPrivateFrontierPlaylist,
} from "./me-frontier";
export { getHealth } from "./health";
export {
  deletePrivateAccount,
  exportPrivateAccountData,
  getCurrentPrivateUser,
  getPrivateAccountExport,
  getPrivateMutationToken,
  listPrivateSubmissions,
  updatePrivateProfile,
} from "./me";
export {
  collectPrivateGalaxyLog,
  type GalaxyCollectionItem,
  GalaxyCollectionItemSchema,
  type GalaxyCompletion,
  GalaxyCompletionSchema,
  getPrivateGalaxyProgress,
  listPrivateGalaxyCollection,
  mergePrivateGalaxyProgress,
} from "./me-galaxy";
export {
  getPrivatePreferences,
  KeyNotationPreferenceSchema,
  mePreferencesContract,
  type UserPreferences,
  UserPreferencesInputSchema,
  UserPreferencesSchema,
  updatePrivatePreferences,
} from "./me-preferences";
export {
  deletePrivateRecSeed,
  listPrivateRecommendations,
  listPrivateRecSeeds,
  RecommendationCatalogueSchema,
  RecommendationFindingSchema,
  RecSeedSchema,
  savePrivateRecSeed,
} from "./me-recs";
export { listPrivateSavedFindings, savePrivateFinding, unsavePrivateFinding } from "./me-saved";
export {
  deletePrivateSavedSet,
  listPrivateSavedSets,
  savePrivateSet,
  SavedSetSchema,
  updatePrivateSavedSet,
} from "./me-sets";
export {
  deletePrivateWatch,
  listPrivateWatches,
  savePrivateWatch,
  WatchKindSchema,
  WatchSchema,
} from "./me-watches";
export { listMixtapes } from "./mixtapes";
export { type NewsletterBody, subscribeNewsletter } from "./newsletter";
export { getRadioNowPlaying, getRandomRadioTrack } from "./radio";
export {
  searchArchive,
  type SearchEntity,
  SearchEntitySchema,
  type SearchFilters,
  SearchFiltersSchema,
  type SearchHit,
  SearchHitSchema,
  type SearchKind,
  SearchKindSchema,
  searchTracks,
} from "./search";
export { listStories } from "./stories";
export { type SubmissionBody, submitTrack } from "./submissions";
export {
  getRandomTrack,
  getSimilarFindings,
  getTrack,
  listFresh,
  listMixableTracks,
  listTracks,
} from "./tracks";
export { recordLiveState } from "./admin-twitch";
export {
  adminUsersContract,
  listUsersAdmin,
  UserAdminItemSchema,
  UserStatusSchema,
} from "./admin-users";
export {
  type ClipDTO,
  ClipDTOSchema,
  EditionContentSchema,
  EditionDTOSchema,
  MixtapeDTOSchema,
  MixtapeSocialPostItemSchema,
  PublicUserSchema,
  RadioNowPlayingSchema,
  type RecordingDTO,
  RecordingDTOSchema,
  type RecordingTracklistItem,
  RecordingTracklistItemSchema,
  SocialPostItemSchema,
  SubmissionSchema,
  SubscriptionDTOSchema,
  TrackListItemSchema,
  TrackSearchResultSchema,
} from "./_shared";

/**
 * The Fluncle API contract router. A flat map keyed by the canonical `verb_noun`
 * registry name — legible at a glance, and the key the coverage test (apps/web)
 * maps a route to. Grows one op per migrated route; the OpenAPI spec, the
 * validators, and the typed client all derive from this object, so they cannot
 * disagree with the handlers that implement it.
 *
 * Composed from the per-domain contract modules. Keep this merge the ONLY place
 * a domain joins the registry.
 */
export const contract = {
  ...adminAlbumsContract,
  ...adminArtistsContract,
  ...adminAttentionContract,
  ...adminBackfillsContract,
  ...adminCatalogueContract,
  ...adminCostsContract,
  ...adminGalaxiesContract,
  ...adminPromptsContract,
  ...adminReachContract,
  ...albumsContract,
  ...artistsContract,
  ...galaxiesContract,
  ...graphContract,
  ...labelsContract,
  ...adminEditionsContract,
  ...adminFrontierContract,
  ...adminFunnelContract,
  ...adminHealthContract,
  ...adminLabelsContract,
  ...adminLogbookContract,
  ...adminMigrationsContract,
  ...adminMixtapesContract,
  ...adminNotesContract,
  ...adminObservationsContract,
  ...adminRecordingsContract,
  ...adminSocialContract,
  ...adminSubmissionsContract,
  ...adminSubscriptionsContract,
  ...adminTokensContract,
  ...adminTracksContract,
  ...adminTwitchContract,
  ...adminUsersContract,
  ...devicesContract,
  ...editionsContract,
  ...healthContract,
  ...meContract,
  ...meFrontierContract,
  ...meGalaxyContract,
  ...mePreferencesContract,
  ...meRecsContract,
  ...meSavedContract,
  ...meSetsContract,
  ...meWatchesContract,
  ...mixContract,
  ...mixtapesContract,
  ...newsletterContract,
  ...radioContract,
  ...reachContract,
  ...searchContract,
  ...storiesContract,
  ...submissionsContract,
  ...tracksContract,
};

export type FluncleContract = typeof contract;

/**
 * The set of canonical `verb_noun` operation names currently served by oRPC.
 * The coverage test (apps/web) reads this to assert every public API route is
 * either converted (named here) or on the explicit shrinking pending list.
 */
export const CONTRACT_OPERATION_NAMES = Object.keys(contract) as Array<keyof typeof contract>;
