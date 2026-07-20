// The `admin-tracks` domain contract module — the admin-gated track ops (the
// enrichment/curation write path + the video control-plane). This is the ADMIN
// wave's pattern-complete pilot: it exercises every admin pattern the
// fan-out will reuse —
//
//   - the FIELD-LEVEL role guard: `update_track` is on `adminProcedure` (both the
//     operator and the agent authenticate), and the handler reads `context.role`
//     to bound the agent to analysis fields (an operator-only field written by the
//     agent is a 403, not a silent drop);
//   - an `operatorProcedure` mint: `observe_track` (the live route is
//     `requireOperator`, so it stays operator-only — see the server module);
//   - the JSON video CONTROL-PLANE: `presign_track_video_uploads` +
//     `finalize_track_video` — the bytes go direct to R2 via the presigned URL, so
//     the bodies oRPC sees are plain JSON (in scope per the brief).
//
// Inputs are LOOSE/passthrough by design: the live admin routes do NOT
// schema-validate — they narrow `unknown` in-handler and emit their own codes
// (`invalid_request`/`note_too_long`/`no_fields`/…). A permissive contract keeps
// oRPC from pre-rejecting so that logic — and its exact codes — stays
// byte-for-byte for the admin consumers (the `fluncle admin` CLI + the enrichment
// agent). A future admin wave adds an op here and one import line in `./index.ts`,
// touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
// `./_shared.js` (not `./_shared`): `index.ts` now re-exports this module's TrackWork types,
// which pulls it into the node16-resolution consumers' graph (apps/raycast) — where an
// extensionless relative import is an error. Same reason `galaxies.ts` carries the extension.
import { FeedItemSchema, MixReasonSchema, TrackListItemSchema } from "./_shared.js";

/**
 * The PATCH /admin/tracks/{trackId} body — the generic admin track update. LOOSE
 * + optional UNKNOWN: the live route narrows each field itself (number/string
 * guards, the `enrichmentStatus` enum, `parseEditorialNote`) and runs the
 * agent-role field guard, so the contract must not pre-reject. The handler reads
 * the raw input and reproduces that logic verbatim.
 */
const UpdateTrackBodySchema = z.looseObject({
  // BPM/key analysis provenance (RFC bpm-key-accuracy) — agent-writable analysis metadata
  // like `features`/`embedding`. LOOSE like the rest: the handler narrows each (analyzedFrom
  // to the preview|full enum, the sources to strings, the confidences to numbers). Internal —
  // the handler keeps them out of VISIBLE_FIELDS so a provenance write moves no public lastmod.
  analyzedAt: z.unknown().optional(),
  analyzedFrom: z.unknown().optional(),
  bpm: z.unknown().optional(),
  bpmConfidence: z.unknown().optional(),
  bpmSource: z.unknown().optional(),
  // The full-song capture side-channel state (RFC full-audio, the `fluncle-capture`
  // cron) — all agent-writable analysis fields, like `embedding`. LOOSE like the rest:
  // the handler narrows each (the captureStatus enum, the key/timestamps to strings,
  // failures to a number). Internal — the handler keeps them out of VISIBLE_FIELDS so
  // a capture write moves no public lastmod.
  captureStatus: z.unknown().optional(),
  // The capture VERIFICATION provenance (docs/the-ear.md § Wrong audio) — the ingest gate's
  // fingerprint verdict + its stamp + the bad-audio memory. Agent-writable analysis fields, LOOSE
  // like the rest: the handler narrows the verdict to its 3-value enum and the memory to a string.
  captureVerification: z.unknown().optional(),
  captureVerifiedAt: z.unknown().optional(),
  // The MuQ audio embedding (a JSON array of 1024 floats) — an agent-writable
  // analysis field the on-box `fluncle-embed` cron sets. LOOSE like the rest: the
  // handler validates the 1024-d shape itself and emits `invalid_embedding`/400.
  embedding: z.unknown().optional(),
  enrichmentStatus: z.unknown().optional(),
  features: z.unknown().optional(),
  // The sonic galaxy assignment (browse-by-feel RFC) — an agent-writable grouping
  // field the on-box `fluncle-cluster` cron sets (the nightly assignment step), like
  // `embedding`. LOOSE like the rest: the handler narrows it to a string (the galaxy
  // id, or "" to clear). Internal — kept out of VISIBLE_FIELDS so an assignment write
  // moves no public lastmod.
  galaxyId: z.unknown().optional(),
  isrc: z.unknown().optional(),
  key: z.unknown().optional(),
  keyConfidence: z.unknown().optional(),
  keySource: z.unknown().optional(),
  logId: z.unknown().optional(),
  note: z.unknown().optional(),
  sourceAudioAttemptedAt: z.unknown().optional(),
  sourceAudioBytes: z.unknown().optional(),
  sourceAudioCapturedAt: z.unknown().optional(),
  sourceAudioFailures: z.unknown().optional(),
  sourceAudioKey: z.unknown().optional(),
  // The bad-audio memory (docs/the-ear.md § Wrong audio) — a JSON array of rejected capture
  // sources. Agent-writable; the handler narrows it to a string.
  sourceAudioRejected: z.unknown().optional(),
  videoUrl: z.unknown().optional(),
});

/**
 * The observe body (POST /admin/tracks/{trackId}/observe). LOOSE: the live route
 * resolves the voice/duration defaults and voice-GATES the script itself (emitting
 * `no_script`/`voice_gate`), so the contract stays permissive to keep those codes
 * byte-for-byte.
 */
const ObserveTrackBodySchema = z.looseObject({
  contextNote: z.unknown().optional(),
  durationMs: z.unknown().optional(),
  durationTargetSec: z.unknown().optional(),
  // Re-render an existing observation instead of no-op'ing on it (operator-driven
  // voice re-tunes / fixing a degenerate render). Default behaviour stays idempotent.
  force: z.unknown().optional(),
  // PROVENANCE — the prompt-registry version this spoken script was authored under
  // (0 = the baked default, N = override N). The on-box sweep sends it; omitted when the
  // sweep fell back to its inlined prompt. See docs/agents/prompt-registry.md.
  promptVersion: z.number().int().min(0).optional(),
  script: z.unknown().optional(),
  voiceId: z.unknown().optional(),
});

/**
 * The context body (POST /admin/tracks/{trackId}/context). LOOSE: an agent-supplied
 * `query` override for the Firecrawl search, and `refresh` — re-run the fetch+distil
 * even when a note already exists (the default short-circuits on `skipped:true`).
 * The handler narrows both in-handler, so the contract stays permissive.
 */
const ContextTrackBodySchema = z.looseObject({
  query: z.unknown().optional(),
  refresh: z.unknown().optional(),
});

/**
 * The note body (POST /admin/tracks/{trackId}/note). LOOSE: the live handler
 * voice-GATES the authored `note` itself (emitting `no_note`/`note_too_short`/
 * `note_too_long`/`voice_gate`/`note_echoes_neighbours`) and enforces the
 * fill-empty-only guard, so the contract stays permissive to keep those codes
 * byte-for-byte. `dryRun` runs both gates and reports the verdict WITHOUT storing
 * anything (the sweep's pre-check and the neighbour layer's measurement harness).
 */
const NoteTrackBodySchema = z.looseObject({
  dryRun: z.unknown().optional(),
  note: z.unknown().optional(),
  // PROVENANCE — the prompt version the note was authored under (0 = the registry's
  // baked default, N = operator override N). The on-box sweep sends it; an operator
  // typing a note by hand sends nothing and the column stays NULL, which is the honest
  // reading (no prompt wrote it). See docs/agents/prompt-registry.md.
  promptVersion: z.number().int().min(0).optional(),
});

/**
 * The measured ECHO of a note against its sonic neighbourhood — the anti-sameness
 * rail's reading, returned on every note call (dry or real) so the sameness of the
 * corpus is observable, not assumed. `phrase` is the run of words lifted from the
 * `logId` neighbour ("" when none reaches the lift threshold); `overlap` is the
 * content-word Jaccard with it (0 when there was nothing to compare against).
 */
const NoteEchoSchema = z.object({
  logId: z.string().nullable(),
  overlap: z.number(),
  phrase: z.string(),
});

/**
 * The presign body (POST /admin/tracks/{trackId}/video/uploads). LOOSE: the live
 * route validates `fields` itself (`no_fields`/`bad_field`/`unknown_field`/
 * `no_footage`), so the contract stays permissive.
 */
const PresignVideoUploadsBodySchema = z.looseObject({
  fields: z.unknown().optional(),
});

/**
 * The finalize body (POST /admin/tracks/{trackId}/video/finalize). LOOSE: every
 * field is optional + normalized in-handler (trim/slice, the `squared` flag, the
 * model/reasoning defaults), so the contract stays permissive.
 */
const FinalizeVideoBodySchema = z.looseObject({
  squared: z.unknown().optional(),
  videoGrain: z.unknown().optional(),
  videoModel: z.unknown().optional(),
  videoModelReasoning: z.unknown().optional(),
  videoPalette: z.unknown().optional(),
  // The two provenance stamps render.json always carried but finalize never persisted (Wave-1 C).
  // Optional like the rest — no caller sends them today; the handler reads them from the uploaded
  // render.json when absent, so the render prompt + the CLI need no change.
  videoPlateSubject: z.unknown().optional(),
  videoRegister: z.unknown().optional(),
  videoStructure: z.unknown().optional(),
  videoVehicle: z.unknown().optional(),
});

/** A presigned-upload row as `presign_track_video_uploads` returns it. */
const VideoUploadSchema = z
  .object({
    contentType: z.string(),
    field: z.string(),
    key: z.string(),
    url: z.string(),
  })
  .meta({ id: "VideoUpload" });

/**
 * `update_track` → `PATCH /admin/tracks/{trackId}` (operationId `updateTrack`).
 *
 * The generic admin track update (BPM/key/features/status/video/note/vibe/identity
 * backfill). On `adminProcedure` — BOTH the operator and the agent authenticate;
 * the FIELD-LEVEL role guard runs in-handler (the agent may write only analysis
 * fields; an operator-only field → 403 `forbidden`). Reuses `updateTrack`,
 * preserving the `{ ok: true, fields, trackId }` envelope and the live
 * `note_too_long`/422, `not_found`/404 codes.
 */
export const updateTrack = oc
  .route({
    method: "PATCH",
    operationId: "updateTrack",
    path: "/admin/tracks/{trackId}",
    summary: "Update a track's enrichment/curation fields (role-gated per field)",
    tags: ["Admin"],
  })
  .input(UpdateTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      fields: z.array(z.string()),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

/**
 * `observe_track` → `POST /admin/tracks/{trackId}/observe` (operationId
 * `observeTrack`).
 *
 * Mint the audio-observation artifact: author-time the agent has already written
 * the recovered-audio script, so this step VOICE-GATES it, renders it (Cartesia),
 * uploads the artifact to R2, and writes back. It no longer holds Firecrawl — it
 * reads the already-stored `context_note` (written by `context_track`) as its
 * fuel. On `adminProcedure` (agent-allowed): flipped from the operator tier so the
 * Hermes cron can drive it. Idempotent
 * per finding — an existing `observation_audio_url` is a no-op (`skipped: true`),
 * so re-pulling an in-flight item is safe (`observe:${logId}`). Preserves the
 * `{ ok: true, audioUrl, durationMs, … }` envelope and the `no_script`/400,
 * `voice_gate`/422, `no_log_id`/400 codes.
 */
export const observeTrack = oc
  .route({
    method: "POST",
    operationId: "observeTrack",
    path: "/admin/tracks/{trackId}/observe",
    summary: "Mint a track's spoken audio-observation artifact",
    tags: ["Admin"],
  })
  .input(ObserveTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      audioUrl: z.string(),
      durationMs: z.number(),
      generatedAt: z.string(),
      jsonUrl: z.string(),
      logId: z.string(),
      ok: z.literal(true),
      // `true` when an observation already existed and the call was a no-op
      // (idempotent re-pull); absent on a fresh mint.
      skipped: z.boolean().optional(),
      textUrl: z.string(),
      trackId: z.string(),
      voiceId: z.string(),
    }),
  );

/**
 * `context_track` → `POST /admin/tracks/{trackId}/context` (operationId
 * `contextTrack`).
 *
 * Fetch the track's FACTUAL context (Firecrawl: label/year/release) and write it
 * to the internal `context_note` column ONLY — no script authoring, no render.
 * This is the split-out context half of the observation pipeline:
 * `context_track` fills the note so `observe_track` can author + render from it
 * without holding Firecrawl.
 * The action segment is the single word `context` (Convention B §6: no dash-compound
 * action segments — the dash-compound `observe-context` is retired with no alias).
 *
 * On `adminProcedure` (agent-allowed). Writes `context_note` QUIETLY — it touches
 * only that internal column, so it does NOT bump `updated_at` (no public surface
 * moves; the feed/lastmod/enrich-sweep stale clock are undisturbed). Idempotent
 * per finding — an existing `context_note` is a no-op (`skipped: true`), keyed
 * `context:${logId}`, so an external cron can fire safely. The Firecrawl output is
 * UNTRUSTED web content treated strictly as DATA (stored as fuel, never executed).
 * Codes: `not_found`/404, `no_log_id`/400.
 */
export const contextTrack = oc
  .route({
    method: "POST",
    operationId: "contextTrack",
    path: "/admin/tracks/{trackId}/context",
    summary: "Fetch + store a track's factual context note (Firecrawl facts only)",
    tags: ["Admin"],
  })
  .input(ContextTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      contextNote: z.string(),
      logId: z.string(),
      ok: z.literal(true),
      // `true` when a context note already existed and the call was a no-op
      // (idempotent re-pull); absent on a fresh fetch. `--refresh` forces a re-fetch,
      // so it never short-circuits and `skipped` stays absent.
      skipped: z.boolean().optional(),
      sources: z.array(z.string()),
      trackId: z.string(),
    }),
  );

/**
 * `note_track` → `POST /admin/tracks/{trackId}/note` (operationId `noteTrack`).
 *
 * AUTO-author a finding's editorial `note` (the written-note sibling of
 * `observe_track`): the agent has already authored the note in Fluncle's voice from
 * the `context_note` fuel + track metadata; this step VOICE-GATES it (the written
 * register's banned-word / earthly-geography / exclamation / "we"-as-company scan,
 * shared with the spoken gate) and stores it into the `note` field. On
 * `adminProcedure` (agent-allowed) so the on-box note cron can drive it — `observe`
 * is the precedent for the tier.
 *
 * SAFETY (the cardinal guarantee): it fills an EMPTY note ONLY. A finding that
 * already carries a note — operator-written OR previously auto-authored — is a no-op
 * (`skipped: true`); the agent NEVER clobbers an existing note. The operator override
 * always wins, enforced server-side. Every authoring attempt stamps the
 * `backfill_note_*` "ran" state (board done-when-ran semantics); a fill also stamps
 * `backfill_note_done_at`.
 *
 * TWO GATES: the VOICE gate (as above) and the ECHO gate — the anti-sameness rail on
 * the vibe-neighbour layer. The note is authored with the notes of the finding's SONIC
 * NEIGHBOURS in the prompt (the MuQ nearest neighbours, `get_similar_findings`); the
 * Worker re-reads those same notes and hard-fails a line that lifts a phrase from one
 * or reuses its words wholesale (`note_echoes_neighbours`). The neighbourhood informs
 * the note; it never templates it. A rejected note is not stored — the note is optional
 * and silence beats a line that reads like every other note in its region.
 *
 * Codes: `not_found`/404, `no_log_id`/400, `no_note`/400, `note_too_short`/422,
 * `note_too_long`/422, `voice_gate`/422, `note_echoes_neighbours`/422.
 */
export const noteTrack = oc
  .route({
    method: "POST",
    operationId: "noteTrack",
    path: "/admin/tracks/{trackId}/note",
    summary: "Auto-author a finding's editorial note (fills an empty note only)",
    tags: ["Admin"],
  })
  .input(NoteTrackBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      // `true` when `dryRun` was set: both gates ran, NOTHING was stored.
      dryRun: z.literal(true).optional(),
      // The measured echo against the sonic neighbourhood (absent only on a skipped
      // no-op, where no candidate note was gated).
      echo: NoteEchoSchema.optional(),
      logId: z.string(),
      // The Log IDs of the neighbours the note was gated against (dry run only).
      neighbors: z.array(z.string()).optional(),
      note: z.string(),
      ok: z.literal(true),
      // `true` when a note already existed and the call was a no-op (the
      // fill-empty-only guard refused to clobber it); absent on a fresh fill.
      skipped: z.boolean().optional(),
      trackId: z.string(),
    }),
  );

/**
 * `presign_track_video_uploads` → `POST /admin/tracks/{trackId}/video/uploads`
 * (operationId `presignTrackVideoUploads`).
 *
 * Phase 1 of the presigned direct-to-R2 upload flow — the JSON control-plane: the
 * caller lists the artifact `fields`, the Worker signs one PUT URL per field
 * (bytes go straight to R2, bypassing the edge body limit). On `operatorProcedure`
 * (live `requireOperator`). Preserves the `{ ok: true, logId, trackId, uploads }`
 * envelope and the `no_fields`/`bad_field`/`unknown_field`/`no_footage` 400 codes.
 */
export const presignTrackVideoUploads = oc
  .route({
    method: "POST",
    operationId: "presignTrackVideoUploads",
    path: "/admin/tracks/{trackId}/video/uploads",
    summary: "Presign direct-to-R2 PUT URLs for a track's video artifacts",
    tags: ["Admin"],
  })
  .input(PresignVideoUploadsBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      uploads: z.array(VideoUploadSchema),
    }),
  );

/**
 * `finalize_track_video` → `POST /admin/tracks/{trackId}/video/finalize`
 * (operationId `finalizeTrackVideo`).
 *
 * Phase 2 of the presigned flow — links the canonical web cut (sets video_url to
 * <log-id>/footage.mp4 and stores the vehicle / model ledger; `squared` stamps the
 * two-master layout). On `operatorProcedure` (live `requireOperator`). Preserves
 * the `{ ok: true, logId, trackId, videoUrl }` envelope and the `not_found`/404,
 * `no_log_id`/400 codes.
 */
export const finalizeTrackVideo = oc
  .route({
    method: "POST",
    operationId: "finalizeTrackVideo",
    path: "/admin/tracks/{trackId}/video/finalize",
    summary: "Finalize a track's uploaded video bundle (link the canonical cut)",
    tags: ["Admin"],
  })
  .input(FinalizeVideoBodySchema.extend({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
      videoUrl: z.string(),
    }),
  );

/**
 * `requeue_video` → `POST /admin/tracks/{trackId}/video/requeue` (operationId
 * `requeueVideo`).
 *
 * Clear a finding's video state so it RE-ENTERS the render queue AND drops cleanly
 * off radio until re-rendered (the render skill improved → re-film an already-filmed
 * finding). It clears BOTH display/queue gates: `video_url` (the render queue gates
 * on it — `hasVideo=false` is `video_url is null`) and `video_squared_at` (radio
 * eligibility gates on it). Clearing only `video_url` would re-queue the finding but
 * leave it eligible-but-broken on radio (radio plays the square master, keyed on
 * `video_squared_at`, with no playable source). The video LEDGER columns
 * (`video_vehicle`/`video_grain`/`video_model`/`video_model_reasoning`) are
 * deliberately LEFT INTACT — they describe the prior render and are read by the next
 * video agent to DIVERSIFY away from recent choices, so they help the re-render.
 *
 * OPERATOR tier (live `requireOperator`): this removes a LIVE published video, so it
 * must NOT be agent-tier — the box agent never clears videos. Idempotent: clearing an
 * already-clear finding is a clean no-op (NULL→NULL). Codes: `not_found`/404,
 * `no_log_id`/400. The body is empty (the trackId path param is the whole input).
 *
 * CACHE NOTE: re-shipping `footage.mp4` to the SAME R2 key leaves Cloudflare
 * Media-Transformation renditions cached separately (the web player streams MT
 * crops, not the master). The video ship's finalize step now purges them
 * automatically on a re-render; `purge_video` is the manual operator twin.
 */
export const requeueVideo = oc
  .route({
    method: "POST",
    operationId: "requeueVideo",
    path: "/admin/tracks/{trackId}/video/requeue",
    summary: "Clear a finding's video so it re-enters the render queue (and off radio)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(
    z.object({
      // `true` when the finding already had no video and the call was a no-op
      // (idempotent re-requeue); absent when a live video was actually cleared.
      alreadyClear: z.boolean().optional(),
      logId: z.string(),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

/**
 * `purge_video` → `POST /admin/tracks/{trackId}/video/purge` (operationId
 * `purgeVideo`).
 *
 * Purge a finding's Cloudflare Media-Transformation renditions from the edge — the
 * operator-tier manual twin of the automatic purge the video ship's finalize step
 * fires on a re-render. The player streams resized/cropped renditions DERIVED from
 * the master `footage.mp4` (each edge-cached under its own transform URL), so when
 * `footage.mp4` is re-shipped to the SAME R2 key, those renditions keep serving the
 * OLD clip until their TTL expires. This evicts that finding's exact rendition URLs
 * (the masters + every width/crop/poster/audio variant the surfaces request) so the
 * next request transcodes the fresh master. Run it after a manual R2 re-upload, or
 * to force-evict a finding whose automatic purge was skipped (no token at the time).
 *
 * OPERATOR tier (live `requireOperator`): it acts on a LIVE published video, so it
 * is NOT agent-tier. Best-effort: the actual purge fires on `waitUntil`, so the op
 * returns immediately whether or not the zone token is provisioned (it logs + no-ops
 * when unset). Codes: `not_found`/404, `no_log_id`/400. The body is empty (the
 * trackId path param is the whole input). `noVideo` reports the no-op case where the
 * finding has no video to purge.
 */
export const purgeVideo = oc
  .route({
    method: "POST",
    operationId: "purgeVideo",
    path: "/admin/tracks/{trackId}/video/purge",
    summary: "Purge a finding's stale Cloudflare video renditions from the edge",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(
    z.object({
      logId: z.string(),
      // `true` when the finding has no video — nothing to purge, a clean no-op.
      noVideo: z.boolean().optional(),
      ok: z.literal(true),
      trackId: z.string(),
    }),
  );

/**
 * The publish-track result (`PublishTrackResult` in ../index.ts). The
 * `POST /admin/tracks` body — `publishTrack`'s output envelope.
 */
const PublishTrackResultSchema = z
  .object({
    addedToSpotify: z.boolean(),
    dryRun: z.boolean(),
    message: z.string(),
    postedToTelegram: z.boolean(),
    track: z.object({
      album: z.string().optional(),
      albumImageUrl: z.string().optional(),
      artists: z.array(z.string()),
      durationMs: z.number(),
      isrc: z.string().optional(),
      label: z.string().optional(),
      logId: z.string().optional(),
      logPageUrl: z.string().optional(),
      popularity: z.number().optional(),
      previewUrl: z.string().optional(),
      spotifyUrl: z.string(),
      title: z.string(),
      trackId: z.string(),
    }),
  })
  .meta({ id: "PublishTrackResult" });

/**
 * `get_track_admin` → `GET /admin/tracks/{trackId}` (operationId `getTrackAdmin`).
 *
 * The single-finding admin lookup by Spotify trackId OR Log ID — the authoritative
 * by-coordinate read the admin board + the `fluncle admin tracks get` CLI use so a
 * lookup never has to scan a list (the incident: an ad-hoc list-scan misread a live
 * finding as nonexistent). Returns the full admin-tier `TrackListItem` — the same
 * shape the board renders and `update_track` writes: the vibe coords, the video
 * ledger (url/vintage/vehicle/grain/model), the observation state, the editorial note.
 *
 * Named `get_track_admin` (not `get_track`) to disambiguate from the PUBLIC
 * `get_track` (`GET /tracks/{idOrLogId}`), mirroring `list_tracks` →
 * `list_tracks_admin`. On `adminProcedure` (live `requireAdmin` — a read,
 * agent-allowed). Reuses `requireTrack`, so a genuinely-missing coordinate is the
 * canonical `not_found`/404 — DISTINCT from the auth 401/403 the procedure raises and
 * from a validation error. Findings-only (the `tracks` table): a mixtape Log ID is a
 * 404 here (mixtapes have their own `get_mixtape*` reads).
 */
export const getTrackAdmin = oc
  .route({
    method: "GET",
    operationId: "getTrackAdmin",
    path: "/admin/tracks/{trackId}",
    summary: "Get one finding with full admin fields (by Spotify trackId or Log ID)",
    tags: ["Admin"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(z.object({ ok: z.literal(true), track: TrackListItemSchema }));

/**
 * `list_tracks_admin` → `GET /admin/tracks` (operationId `listTracksAdmin`).
 *
 * The admin board's archive query (live `requireAdmin` — a read, agent-allowed).
 * Two shapes off one route, both preserved byte-for-byte:
 *   - the `?q=` free-text SEARCH branch returns a flat `{ tracks }` (no
 *     cursor/totalCount envelope);
 *   - otherwise the paginated LIST page (the `FeedListPage`/`TrackListPage` body
 *     itself, no `ok` envelope), filtered by `order`/`hasVideo`/`status`.
 * Every query param is a tolerant optional string — the live route parses + clamps
 * in-handler and never 400s — so the contract stays permissive. The output is the
 * union of the two live bodies.
 */
export const listTracksAdmin = oc
  .route({
    method: "GET",
    operationId: "listTracksAdmin",
    path: "/admin/tracks",
    summary: "Query the admin archive board (search or paginated list)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      // `captureQueue` powers the full-song capture queue: `captureQueue=true` lists
      // findings still needing a capture (`capture_status` pending ∪ failed ∪ NULL — the
      // `fluncle-capture` cron's worklist). Tolerant string ("true"/absent), parsed
      // in-handler like `retryEmptyContext`. A SEPARATE queue — it never gates enrich/embed.
      captureQueue: z.string().optional(),
      cursor: z.string().optional(),
      // `hasContext` / `hasObservation` / `hasNote` power the three agent queues (the
      // context queue = `hasContext=false`; the observation queue = `hasContext=true`
      // AND `hasObservation=false`; the auto-note queue = `hasContext=true` AND
      // `hasNote=false`). Tri-state tolerant strings ("true"/"false"), parsed +
      // clamped in-handler exactly like `hasVideo`.
      hasContext: z.string().optional(),
      // `hasEmbedding` powers the MuQ embed queue: `hasEmbedding=false` lists findings
      // with no `embedding_json` yet (the `fluncle-embed` cron's worklist). Tri-state
      // tolerant string, parsed + clamped in-handler like `hasVideo`.
      hasEmbedding: z.string().optional(),
      // `hasKey` powers the Rekordbox sync's queue: `hasKey=false` lists
      // findings whose stored musical `key` is null (the missing-key backlog).
      // Tri-state tolerant string, parsed + clamped in-handler like `hasVideo`.
      hasKey: z.string().optional(),
      hasNote: z.string().optional(),
      hasObservation: z.string().optional(),
      hasVideo: z.string().optional(),
      limit: z.string().optional(),
      order: z.string().optional(),
      q: z.string().optional(),
      // `--retry-empty`: widen the `hasContext=false` context queue to also re-pick
      // CONFIRMED-EMPTY finds (`context_status = 'empty'`). Tri-state tolerant string,
      // parsed in-handler like the other booleans; only honoured with `hasContext=false`.
      retryEmptyContext: z.string().optional(),
      status: z.string().optional(),
    }),
  )
  .output(
    // The LIST page arm is FIRST: it carries the required `totalCount`, so a list
    // response matches it (and keeps `nextCursor`/`totalCount`). The SEARCH arm is
    // a strict subset (`{ tracks }` only); if it were first, Zod's union would
    // match a list page against it and strip the cursor/count. A search response
    // (no `totalCount`) falls through to the second arm.
    z.union([
      z.object({
        nextCursor: z.string().optional(),
        totalCount: z.number(),
        tracks: z.array(FeedItemSchema),
      }),
      z.object({ tracks: z.array(TrackListItemSchema) }),
    ]),
  );

// ── The audio pipeline's work queues (docs/gpu-batch-embed.md, docs/the-ear.md) ──────

/**
 * Which stage of the audio pipeline a worklist is for: capture → analyze → embed. `anchor` is
 * the catalogue Spotify-anchor worklist (docs/catalogue-crawler.md § the anchor) — un-anchored
 * catalogue rows the box's Apify sweep fills via `anchor_track`; it carries no audio, so it is a
 * sibling of the three audio stages rather than one of them.
 */
export const TrackWorkKindSchema = z.enum(["analyze", "anchor", "capture", "embed"]).meta({
  id: "TrackWorkKind",
});

/** Which half of the archive a worklist covers: certified findings, the catalogue, or both. */
export const TrackWorkScopeSchema = z.enum(["all", "catalogue", "findings"]).meta({
  id: "TrackWorkScope",
});

/**
 * One row of pipeline work.
 *
 * `certified` is on the DTO deliberately: it is what tells a sweep it must NOT write a
 * certification field back onto this row (no `--status`, no note, no video, no
 * `enrichment_status`). `logId` is null exactly when `certified` is false, because the
 * coordinate lives on the certification.
 *
 * The four optional `capture`-only fields (`bpm`, `analyzedFrom`, `sourceAudioFailures`,
 * `artistYoutubeChannelIds`) are the trust + re-derive signals the `fluncle-capture` sweep
 * reads: the artist-own-channel trust tier, the failure-count backoff, and the capture→enrich
 * re-derive predicate. They ride ONLY the `capture` worklist (absent for `analyze`/`embed`) and
 * are omitted when empty, so the migrated sweep parses the exact shape the finding-only capture
 * queue used to hand it.
 */
export const TrackWorkItemSchema = z
  .object({
    analyzedFrom: z.enum(["full", "preview"]).optional(),
    /**
     * The ready-made Spotify search query for the ANCHOR worklist (the row's artists then its
     * title), so the box's Apify sweep never builds it. Present ONLY on `anchor` rows.
     */
    anchorQuery: z.string().optional(),
    artistYoutubeChannelIds: z.array(z.string()).optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    capturePriority: z.number().nullable(),
    certified: z.boolean(),
    durationMs: z.number(),
    isrc: z.string().nullable(),
    label: z.string().nullable(),
    logId: z.string().nullable(),
    sourceAudioFailures: z.number().optional(),
    sourceAudioKey: z.string().nullable(),
    // The bad-audio memory (docs/the-ear.md § Wrong audio) — the JSON array of rejected capture
    // sources, CAPTURE-only like the trust signals above. The sweep's pre-download videoId filter
    // + post-download sha backstop read it. Omitted when nothing has been rejected.
    sourceAudioRejected: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "TrackWorkItem" });

/**
 * `list_track_work` → `GET /admin/tracks/work` (operationId `listTrackWork`).
 *
 * Admin tier (agent-allowed read) — the worklist for one stage of the audio pipeline, in the
 * order the metered capture budget should be spent.
 *
 * THIS IS THE CATALOGUE-AWARE QUEUE. `list_tracks_admin`'s three queue filters (`captureQueue`,
 * `hasEmbedding=false`, `status=queue`) all drive through the FINDING JOIN, so they are blind
 * to a catalogue track by construction — which is correct for a feed and fatal for a pipeline:
 * analysis and embedding are measurements of a RECORDING and apply to any track with captured
 * audio, certified or not. This op reads `tracks` (outer-joined to the certification) and
 * serves all three stages.
 *
 * THE ORDER IS THE BUDGET. Audio capture bills per GB, so the drain order decides what the
 * money buys: certified work first (Fluncle already said yes to a finding), then
 * `capture_priority` DESC — the Ear's pre-audio ladder — then newest-first, then the id. Never
 * insertion order. A label the operator RULED OUT is tier −1 and is excluded from the `capture`
 * worklist outright: a veto that only sorts last is not a veto, because the queue drains.
 *
 * `count=true` adds `queued` — the size of the WHOLE backlog for this kind+scope, not the page.
 * The page is capped at 200, so `tracks.length` can never answer "how much is left", and at
 * catalogue scale that is the only number the operator actually wants: it is what tells the GPU
 * batch whether to rent another hour. Tolerant string ("true"; anything else is false), and
 * OPT-IN because the 5-minute box sweeps do not need it and should not pay for the count.
 */
export const listTrackWork = oc
  .route({
    method: "GET",
    operationId: "listTrackWork",
    path: "/admin/tracks/work",
    summary: "The audio pipeline's worklist for one stage, in capture-priority order",
    tags: ["Admin"],
  })
  .input(
    z.object({
      count: z.string().optional(),
      kind: TrackWorkKindSchema,
      limit: z.coerce.number().int().min(1).max(200).default(50),
      scope: TrackWorkScopeSchema.default("all"),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      /** The whole backlog for this kind+scope. Present only when `count=true` was asked for. */
      queued: z.number().optional(),
      tracks: z.array(TrackWorkItemSchema),
    }),
  );

/**
 * `publish_track` → `POST /admin/tracks` (operationId `publishTrack`).
 *
 * Publish a finding from a Spotify URL: certify it, post to Telegram, kick off
 * async enrichment. Operator tier (live `requireOperator`). LOOSE body — the live
 * route validates `spotifyUrl` itself (`invalid_request`/400) and caps the note
 * (`note_too_long`). Preserves the `{ ok: true, ...PublishTrackResult }` envelope.
 */
export const publishTrack = oc
  .route({
    method: "POST",
    operationId: "publishTrack",
    path: "/admin/tracks",
    summary: "Publish a finding from a Spotify URL",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      dryRun: z.unknown().optional(),
      note: z.unknown().optional(),
      spotifyUrl: z.unknown().optional(),
    }),
  )
  .output(PublishTrackResultSchema.extend({ ok: z.literal(true) }));

/**
 * One ordered stop in a proposed mix — the finding + the transition INTO it (the
 * `transitionScore`/`transitionReason` describe the edge from the previous stop, so
 * the first stop's are null). Admin-only, so the raw `transitionScore` is present here
 * (it never rides a crew-facing surface). `flagged` marks a null-pair transition
 * (costed at the neutral median, not a musical judgment).
 */
const MixOrderStopSchema = z
  .object({
    artists: z.array(z.string()),
    bpm: z.number().optional(),
    flagged: z.boolean(),
    key: z.string().optional(),
    logId: z.string(),
    title: z.string(),
    transitionReason: MixReasonSchema.optional(),
    transitionScore: z.number().optional(),
  })
  .meta({ id: "MixOrderStop" });

/**
 * `get_mixable_order` → `GET /admin/tracks/mixable-order` (operationId
 * `getMixableOrder`).
 *
 * The dream-weaver: order a candidate pool into a SMOOTHNESS-optimized chain
 * (minimizing total adjacent roughness), NOT an energy-shaped set — a proposed
 * tracklist the operator copy-pastes into Rekordbox. A PURE admin READ (no writes):
 * `promote_recording` remains the only way a mixtape exists. Admin tier
 * (agent-allowed, like `get_track_admin`), GET like every other `get_*` op (64 comma-
 * joined logIds fit a query param). Held-Karp exact for ≤16, greedy + 2-opt to 64.
 *
 * `ids` is a comma-separated Log ID list (2..64; a 65-id request 400s at validation);
 * `seed` optionally pins the first stop. Output is the ordered stops + the total cost
 * + which algorithm ran.
 */
export const getMixableOrder = oc
  .route({
    method: "GET",
    operationId: "getMixableOrder",
    path: "/admin/tracks/mixable-order",
    summary: "Order a pool of findings into a smooth proposed mix (Held-Karp / greedy+2-opt)",
    tags: ["Admin"],
  })
  .input(z.object({ ids: z.string(), seed: z.string().optional() }))
  .output(
    z.object({
      algorithm: z.enum(["held-karp", "greedy-2opt"]),
      ok: z.literal(true),
      order: z.array(MixOrderStopSchema),
      totalCost: z.number(),
    }),
  );

/** The `admin-tracks` domain's ops, merged into the root contract by `./index.ts`. */
export const adminTracksContract = {
  context_track: contextTrack,
  finalize_track_video: finalizeTrackVideo,
  get_mixable_order: getMixableOrder,
  get_track_admin: getTrackAdmin,
  list_track_work: listTrackWork,
  list_tracks_admin: listTracksAdmin,
  note_track: noteTrack,
  observe_track: observeTrack,
  presign_track_video_uploads: presignTrackVideoUploads,
  publish_track: publishTrack,
  purge_video: purgeVideo,
  requeue_video: requeueVideo,
  update_track: updateTrack,
};
