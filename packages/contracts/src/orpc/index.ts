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

import { adminArtistsContract } from "./admin-artists";
import { adminAttentionContract } from "./admin-attention";
import { adminBackfillsContract } from "./admin-backfills";
import { adminCatalogueContract } from "./admin-catalogue";
import { adminCostsContract } from "./admin-costs";
import { adminGalaxiesContract } from "./admin-galaxies";
import { artistsContract } from "./artists";
import { galaxiesContract } from "./galaxies";
import { adminEditionsContract } from "./admin-editions";
import { adminHealthContract } from "./admin-health";
import { adminLabelsContract } from "./admin-labels";
import { adminLogbookContract } from "./admin-logbook";
import { adminMigrationsContract } from "./admin-migrations";
import { adminMixtapesContract } from "./admin-mixtapes";
import { adminRecordingsContract } from "./admin-recordings";
import { adminSocialContract } from "./admin-social";
import { adminSubmissionsContract } from "./admin-submissions";
import { adminSubscriptionsContract } from "./admin-subscriptions";
import { adminTokensContract } from "./admin-tokens";
import { adminTracksContract } from "./admin-tracks";
import { adminTwitchContract } from "./admin-twitch";
import { devicesContract } from "./devices";
import { editionsContract } from "./editions";
import { healthContract } from "./health";
import { meContract } from "./me";
import { meGalaxyContract } from "./me-galaxy";
import { meSavedContract } from "./me-saved";
import { mixtapesContract } from "./mixtapes";
import { newsletterContract } from "./newsletter";
import { radioContract } from "./radio";
import { searchContract } from "./search";
import { storiesContract } from "./stories";
import { submissionsContract } from "./submissions";
import { tracksContract } from "./tracks";

// Re-export the per-op contracts so existing importers (and the typed client)
// keep their entrypoints.
export { ArtistListItemSchema, artistsContract, getArtist, listArtists } from "./artists";
export { GalaxyListItemSchema, galaxiesContract, getGalaxy, listGalaxies } from "./galaxies";
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
  addArtistSocial,
  adminArtistsContract,
  backfillArtistImages,
  backfillArtists,
  confirmArtistSocial,
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
export { backfillDiscogs, backfillLastfm } from "./admin-backfills";
export {
  adminCatalogueContract,
  CapturePriorityReasonSchema,
  CatalogueLensSchema,
  CatalogueMatchSchema,
  CatalogueSummarySchema,
  CatalogueTrackItemSchema,
  crawlCatalogue,
  CrawlPassSchema,
  CrawlStatusSchema,
  getCrawlStatus,
  listCatalogueTracks,
  rankCatalogue,
} from "./admin-catalogue";
export {
  adminLabelsContract,
  LabelAdminItemSchema,
  LabelSeedStateSchema,
  listLabelsAdmin,
  updateLabel,
} from "./admin-labels";
export { adminMigrationsContract, migratePreviewArchive } from "./admin-migrations";
export { type CostEventInput, CostEventInputSchema, recordCost } from "./admin-costs";
export { recordHealth, ServiceHealthStatusSchema } from "./admin-health";
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
  getTrackAdmin,
  listTracksAdmin,
  listTrackWork,
  observeTrack,
  presignTrackVideoUploads,
  publishTrack,
  requeueVideo,
  TrackWorkItemSchema,
  TrackWorkKindSchema,
  TrackWorkScopeSchema,
  updateTrack,
} from "./admin-tracks";
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
  getPrivateGalaxyProgress,
  mergePrivateGalaxyProgress,
} from "./me-galaxy";
export { listPrivateSavedFindings, savePrivateFinding, unsavePrivateFinding } from "./me-saved";
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
export { getRandomTrack, getSimilarFindings, getTrack, listTracks } from "./tracks";
export { recordLiveState } from "./admin-twitch";
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
  ...adminArtistsContract,
  ...adminAttentionContract,
  ...adminBackfillsContract,
  ...adminCatalogueContract,
  ...adminCostsContract,
  ...adminGalaxiesContract,
  ...artistsContract,
  ...galaxiesContract,
  ...adminEditionsContract,
  ...adminHealthContract,
  ...adminLabelsContract,
  ...adminLogbookContract,
  ...adminMigrationsContract,
  ...adminMixtapesContract,
  ...adminRecordingsContract,
  ...adminSocialContract,
  ...adminSubmissionsContract,
  ...adminSubscriptionsContract,
  ...adminTokensContract,
  ...adminTracksContract,
  ...adminTwitchContract,
  ...devicesContract,
  ...editionsContract,
  ...healthContract,
  ...meContract,
  ...meGalaxyContract,
  ...meSavedContract,
  ...mixtapesContract,
  ...newsletterContract,
  ...radioContract,
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
