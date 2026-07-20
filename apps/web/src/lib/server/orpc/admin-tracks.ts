// The `admin-tracks` domain router module — the admin wave's pilot (every admin
// pattern the fan-out reuses). Each handler reuses the live `/api/admin/tracks/*`
// route logic verbatim; the auth tier moves from the per-handler `requireAdmin` /
// `requireOperator` to the oRPC procedure middleware (../orpc-auth), and the
// field-level role check reads `context.role` in-handler.
//
//   - `update_track` — port of PATCH /admin/tracks/{trackId}. On `adminAuth` (the
//     live `requireAdmin`: operator OR agent). The FIELD-LEVEL guard reads
//     `context.role`: the agent may write ONLY analysis fields; an operator-only
//     field written by the agent is a 403 `forbidden` (rejected, not dropped). The
//     operator may write anything.
//   - `observe_track` — POST /admin/tracks/{trackId}/observe. FLIPPED to the
//     agent tier (`adminAuth` only) so the Hermes observation cron can drive it.
//     Idempotent per finding (an
//     existing observation is a no-op). It no longer holds Firecrawl — it reads the
//     stored `context_note` (written by `context_track`) as fuel; the voice gate
//     still hard-fails any banned-identity-word / earthly-geography violation.
//   - `context_track` — POST /admin/tracks/{trackId}/context. The split-out
//     context half (agent tier): fetch the Firecrawl FACTS and write `context_note`
//     ONLY, quietly (no updated_at bump). Idempotent per finding. Firecrawl output
//     is untrusted web content treated strictly as DATA.
//   - `presign_track_video_uploads` / `finalize_track_video` — ports of the JSON
//     video control-plane (`…/video/uploads`, `…/video/finalize`). Both live routes
//     are `requireOperator`, so both are on the operator tier.

import { env } from "cloudflare:workers";
import { type InferContractRouterInputs } from "@orpc/contract";
import { ORPCError } from "@orpc/server";
import { type contract } from "@fluncle/contracts/orpc";
import { FOUND_BASE, trackMedia, videoVersion } from "../../media";
import { recordNoteAttempt } from "../backfill";
import { coerceEmbedding, EMBEDDING_DIMS } from "../embedding";
import { parseEditorialNote } from "../http-errors";
import { gateNoteText, noteEchoError, scoreNoteEcho, type NoteNeighbor } from "../note";
import { getNoteEchoThresholds, recordNoteRejection } from "../note-rejections";
import { publishTrack } from "../publish";
import { buildContextQuery, fetchTrackContext, gateObservationScript } from "../observation";
import { observationEchoError, scoreObservationEcho } from "../observation-echo";
import { observationNeighbours } from "../observation-neighbours";
import { renderAndStoreObservation } from "../observation-render";
import {
  getObservationEchoThresholds,
  recordObservationRejection,
} from "../observation-rejections";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { VIDEOS_BUCKET, presignUploads } from "../r2-presign";
import { fillEmptyNote, type TrackUpdate, updateTrack } from "../track-update";
import { countTrackWork, listTrackWork } from "../track-work";
import { purgeVideoCache } from "../video-cache";
import {
  type EnrichmentStatusFilter,
  ENRICHMENT_STATUS_FILTERS,
  decodeTrackCursor,
  getMixableOrder,
  getObservationProvenance,
  getSimilarFindings,
  getTrackContextNote,
  listTracks,
  MixableOrderError,
  searchTracks,
} from "../tracks";
import { isLogId } from "../../log-id";
import { type VideoArtifact, artifactByField, readRenderManifestStamps } from "../video-bundle";
import { type Implementer, parseLimit, requireTrack, toFault } from "./_shared";

// Fields only the operator may write: editorial voice (note), the vehicle/video
// (videoUrl), and the immutable identity fields (isrc/logId). The agent role is
// limited to machine-measured analysis (bpm, key, features, enrichmentStatus) —
// overwritable, internal, no public footprint. (The retired vibe placement
// vibeX/vibeY is gone entirely — the sonic galaxy is now the automatic
// `fluncle-cluster` assignment over the MuQ embedding, not an operator write.)
const OPERATOR_ONLY_FIELDS: (keyof TrackUpdate)[] = ["isrc", "logId", "note", "videoUrl"];

// The handler input shapes come straight from the contract (the single source of
// truth): `InferContractRouterInputs<typeof contract>` projects each op's Zod
// `.input(...)` to its TS type, so a `PatchBody`/`ObserveBody` hand-mirror can't
// drift from the schema the route validates. The contract inputs are LOOSE (each
// field `?: unknown`) by design — the handler narrows them itself — so these are
// `{ …?: unknown; trackId: string }`, exactly what the old hand-types said.
type AdminTrackInputs = InferContractRouterInputs<typeof contract>;
type PatchBody = AdminTrackInputs["update_track"];
type ObserveBody = AdminTrackInputs["observe_track"];
type NoteBody = AdminTrackInputs["note_track"];

// Admin board list page-size bounds, ported verbatim from the live GET route.
const ADMIN_LIST_DEFAULT_LIMIT = 16;
const ADMIN_LIST_MAX_LIMIT = 48;

// ── The vibe neighbourhood (the auto-note's second fuel) ──────────────────────────
//
// How many sonic neighbours the note reads. Six is the same window the `/log` "more
// like this" row shows: wide enough to describe a region of the archive, tight enough
// that every one of them genuinely sounds like the finding. The neighbours come from
// the MuQ audio EMBEDDING (`get_similar_findings` — an exact cosine scan in SQL, the
// probe bound as a raw blob), never from `features_json`: the note encodes a
// subjective read of how a finding FEELS, and two tracks can measure nearly identical
// yet sit nowhere near each other by feel. The embedding is the space the note's
// neighbours live in.
const NOTE_NEIGHBOR_LIMIT = 6;

/**
 * The notes of a finding's sonic neighbours — the fuel the auto-note is authored
 * against AND the corpus its echo gate measures it against (one read, one definition
 * of "the neighbourhood", so the gate can never judge against notes the agent never
 * saw). Only NOTED neighbours count: an un-noted one teaches nothing and cannot be
 * echoed. Every candidate is a certified finding (`getSimilarFindings` drives through
 * the findings join), so a catalogue track can never enter the neighbourhood.
 *
 * Best-effort by design: a finding with no embedding yet, or one whose neighbours are
 * all note-less, comes back `[]` — the note is then authored (and gated) exactly as it
 * was before the layer existed.
 */
async function noteNeighbors(trackId: string): Promise<NoteNeighbor[]> {
  const findings = await getSimilarFindings(trackId, NOTE_NEIGHBOR_LIMIT);

  return findings.flatMap((finding) =>
    finding.logId && finding.note?.trim()
      ? [{ logId: finding.logId, note: finding.note.trim() }]
      : [],
  );
}

// Tri-state boolean query params ("true"/"false"/absent → true/false/undefined),
// ported verbatim from the live `hasVideo` route. `hasContext`/`hasObservation`/
// `hasNote` reuse it to drive the context, observation, and auto-note queues.
function parseTriStateBool(value: string | undefined): boolean | undefined {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseEnrichmentStatus(value: string | undefined): EnrichmentStatusFilter | undefined {
  return value && (ENRICHMENT_STATUS_FILTERS as readonly string[]).includes(value)
    ? (value as EnrichmentStatusFilter)
    : undefined;
}

function parseAdminLimit(value: string | undefined): number {
  return parseLimit(value, ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT);
}

function resolveDurationTargetSec(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= 90) {
    return Math.round(value);
  }

  return 30;
}

/** JSON.parse that returns `null` instead of throwing — for the embedding string form. */
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Build the `admin-tracks` domain's handlers. Each reuses the live route logic
 * verbatim; only the auth gate is relocated to the procedure middleware.
 */
export function adminTracksHandlers(os: Implementer) {
  // PATCH /admin/tracks/{trackId} — on `adminAuth` (operator OR agent). The
  // field-level guard reads `context.role`.
  const updateTrackHandler = os.update_track.use(adminAuth).handler(async ({ context, input }) => {
    try {
      const body: PatchBody = input;
      const trackId = body.trackId;
      const update: TrackUpdate = {};

      if (typeof body.bpm === "number" && Number.isFinite(body.bpm)) {
        update.bpm = body.bpm;
      }

      if (typeof body.key === "string") {
        update.key = body.key;
      }

      // BPM/key analysis provenance (RFC bpm-key-accuracy) — agent-writable analysis
      // metadata, like features/embedding, so NOT in OPERATOR_ONLY_FIELDS. Narrow each:
      // analyzedFrom to the preview|full enum, the sources to non-empty strings, the
      // confidences to finite numbers, analyzedAt to a non-empty ISO string.
      if (typeof body.bpmSource === "string" && body.bpmSource.trim()) {
        update.bpmSource = body.bpmSource;
      }

      if (typeof body.keySource === "string" && body.keySource.trim()) {
        update.keySource = body.keySource;
      }

      if (typeof body.bpmConfidence === "number" && Number.isFinite(body.bpmConfidence)) {
        update.bpmConfidence = body.bpmConfidence;
      }

      if (typeof body.keyConfidence === "number" && Number.isFinite(body.keyConfidence)) {
        update.keyConfidence = body.keyConfidence;
      }

      if (body.analyzedFrom === "preview" || body.analyzedFrom === "full") {
        update.analyzedFrom = body.analyzedFrom;
      }

      if (typeof body.analyzedAt === "string" && body.analyzedAt.trim()) {
        update.analyzedAt = body.analyzedAt;
      }

      if (typeof body.features === "string") {
        update.features = body.features;
      }

      // The MuQ embedding: an analysis field the agent may write. Accept the vector
      // as a real JSON array (the CLI parses `--embedding`/`--embedding-file` into
      // one) or, defensively, a JSON-string of one; validate the 1024-d shape and
      // store the canonical serialization. `""` clears it (re-embed on the next tick).
      // A malformed vector is a 400 `invalid_embedding`, never a silent drop, so a
      // truncated MuQ run can't poison the similarity space.
      if (body.embedding !== undefined) {
        if (body.embedding === "") {
          update.embedding = "";
        } else {
          const raw =
            typeof body.embedding === "string" ? safeJsonParse(body.embedding) : body.embedding;
          const vector = coerceEmbedding(raw);

          if (!vector) {
            throw new ORPCError("BAD_REQUEST", {
              data: {
                apiCode: "invalid_embedding",
                apiMessage: `embedding must be a JSON array of ${EMBEDDING_DIMS} finite numbers`,
              },
              message: `embedding must be a JSON array of ${EMBEDDING_DIMS} finite numbers`,
              status: 400,
            });
          }

          update.embedding = JSON.stringify(vector);
        }
      }

      if (typeof body.videoUrl === "string") {
        update.videoUrl = body.videoUrl;
      }

      // The sonic galaxy assignment (browse-by-feel RFC) — agent-writable, like
      // embedding, so NOT in OPERATOR_ONLY_FIELDS: the on-box `fluncle-cluster` cron
      // sets it with the box's agent token. A string sets it (including "" which clears
      // the assignment); anything else leaves it untouched.
      if (typeof body.galaxyId === "string") {
        update.galaxyId = body.galaxyId;
      }

      if (
        body.enrichmentStatus === "pending" ||
        body.enrichmentStatus === "done" ||
        body.enrichmentStatus === "failed"
      ) {
        update.enrichmentStatus = body.enrichmentStatus;
      }

      // A present note sets it (including "" which clears the stored note); an
      // absent note leaves it untouched. parseEditorialNote throws on too-long.
      if (typeof body.note === "string") {
        update.note = parseEditorialNote(body.note);
      }

      // The render's diversity-ledger stamps (vehicle/grain/register). Normally the
      // video FINALIZE writes them from the bundle's render.json, but a bundle can ship
      // without them (the 2026-07 unlabelled trio), and the correction path is this
      // generic update — the operator watches the video and stamps what is on screen.
      // Same trim/length discipline as the finalize mapping; the certification rail in
      // updateTrack still 409s them on an uncertified row (they are findings columns).
      if (typeof body.videoVehicle === "string" && body.videoVehicle.trim()) {
        update.videoVehicle = body.videoVehicle.trim().slice(0, 120);
      }

      if (typeof body.videoGrain === "string" && body.videoGrain.trim()) {
        update.videoGrain = body.videoGrain.trim().slice(0, 120);
      }

      if (typeof body.videoRegister === "string" && body.videoRegister.trim()) {
        update.videoRegister = body.videoRegister.trim().slice(0, 120);
      }

      if (typeof body.videoPalette === "string" && body.videoPalette.trim()) {
        update.videoPalette = body.videoPalette.trim().slice(0, 120);
      }

      if (typeof body.videoPlateSubject === "string" && body.videoPlateSubject.trim()) {
        update.videoPlateSubject = body.videoPlateSubject.trim().slice(0, 120);
      }

      if (typeof body.videoStructure === "string" && body.videoStructure.trim()) {
        update.videoStructure = body.videoStructure.trim().slice(0, 120);
      }

      // Straggler repair: one-time backfill of identity fields into null slots
      // (updateTrack enforces immutability once set).
      if (typeof body.isrc === "string") {
        update.isrc = body.isrc;
      }

      if (typeof body.logId === "string") {
        update.logId = body.logId;
      }

      // The full-song capture side-channel fields (RFC full-audio) — agent-writable
      // analysis, like enrichmentStatus/embedding, so NOT in OPERATOR_ONLY_FIELDS.
      // Narrow each: the status to the 4-value enum, the key/timestamps to non-empty
      // strings, the failure count to a finite number.
      if (
        body.captureStatus === "pending" ||
        body.captureStatus === "done" ||
        body.captureStatus === "unmatched" ||
        body.captureStatus === "failed"
      ) {
        update.captureStatus = body.captureStatus;
      }

      if (typeof body.sourceAudioKey === "string" && body.sourceAudioKey.trim()) {
        update.sourceAudioKey = body.sourceAudioKey;
      }

      if (typeof body.sourceAudioCapturedAt === "string" && body.sourceAudioCapturedAt.trim()) {
        update.sourceAudioCapturedAt = body.sourceAudioCapturedAt;
      }

      if (typeof body.sourceAudioAttemptedAt === "string" && body.sourceAudioAttemptedAt.trim()) {
        update.sourceAudioAttemptedAt = body.sourceAudioAttemptedAt;
      }

      if (
        typeof body.sourceAudioFailures === "number" &&
        Number.isFinite(body.sourceAudioFailures)
      ) {
        update.sourceAudioFailures = body.sourceAudioFailures;
      }

      // The capture BYTE meter (the budget's byte cap reads it — lib/server/capture-budget.ts).
      // A non-integer or negative size is not a measurement, so it is dropped rather than
      // stored: a corrupt byte count would silently mis-state the spend the operator reads.
      if (
        typeof body.sourceAudioBytes === "number" &&
        Number.isInteger(body.sourceAudioBytes) &&
        body.sourceAudioBytes >= 0
      ) {
        update.sourceAudioBytes = body.sourceAudioBytes;
      }

      // THE CAPTURE VERIFICATION provenance (docs/the-ear.md § Wrong audio) — the ingest gate's
      // verdict + its stamp + the bad-audio memory. Agent-writable analysis fields (internal, no
      // public surface). The verdict is narrowed to the 3-value enum; the memory is a JSON string
      // ("" clears it, handled in updateTrack).
      if (
        body.captureVerification === "preview-match" ||
        body.captureVerification === "unverified" ||
        body.captureVerification === "mismatch"
      ) {
        update.captureVerification = body.captureVerification;
      }

      if (typeof body.captureVerifiedAt === "string" && body.captureVerifiedAt.trim()) {
        update.captureVerifiedAt = body.captureVerifiedAt;
      }

      if (typeof body.sourceAudioRejected === "string") {
        update.sourceAudioRejected = body.sourceAudioRejected;
      }

      // The agent role may only touch analysis fields. Reject (not silently drop)
      // an attempt at an operator-only field — a 403 the gate can voice. The role
      // is read from the oRPC context (lifted by `adminAuth`), not re-derived.
      if (context.role === "agent") {
        const blocked = OPERATOR_ONLY_FIELDS.filter((field) => field in update);

        if (blocked.length > 0) {
          throw new ORPCError("FORBIDDEN", {
            data: {
              apiCode: "forbidden",
              apiMessage: `The agent role can write only analysis fields, not: ${blocked.join(", ")}`,
            },
            message: `The agent role can write only analysis fields, not: ${blocked.join(", ")}`,
            status: 403,
          });
        }
      }

      // Pass the AUTHENTICATED tier (from the oRPC context, never the body) so
      // updateTrack can apply the source hierarchy: an agent write never downgrades
      // a rekordbox/operator-graded bpm/key; an operator's hand-set value is stamped
      // `operator` and durably protected from later DSP passes.
      const result = await updateTrack(trackId, update, { writer: context.role });

      return { ok: true as const, ...result };
    } catch (error) {
      throw toFault(error);
    }
  });

  // GET /admin/tracks/{trackId} — admin tier (live `requireAdmin`, agent-allowed).
  // The single-finding by-coordinate lookup: fetch ONE finding with its full
  // admin-tier fields (vibe coords, the video ledger, the observation, the note), or
  // the canonical 404. Distinct from list_tracks_admin — a single authoritative read,
  // so an ad-hoc list-scan can't misread a live finding as nonexistent. `requireTrack`
  // resolves by Spotify trackId OR Log ID and raises the shared `not_found`/404,
  // DISTINCT from the procedure's auth 401/403.
  const getTrackAdminHandler = os.get_track_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      const track = await requireTrack(input.trackId);

      return { ok: true as const, track };
    } catch (error) {
      throw toFault(error);
    }
  });

  // GET /admin/tracks — admin tier (live `requireAdmin`). The admin board query:
  // a `?q=` free-text search (flat `{ tracks }`) OR the paginated list page (the
  // page body itself, filtered by order/hasVideo/status). Both shapes preserved.
  const listTracksAdminHandler = os.list_tracks_admin.use(adminAuth).handler(async ({ input }) => {
    try {
      const q = input.q?.trim();

      if (q) {
        return {
          tracks: await searchTracks({
            limit: parseAdminLimit(input.limit),
            q,
          }),
        };
      }

      return await listTracks({
        captureQueue: parseTriStateBool(input.captureQueue) === true,
        cursor: decodeTrackCursor(input.cursor ?? null),
        hasContext: parseTriStateBool(input.hasContext),
        hasEmbedding: parseTriStateBool(input.hasEmbedding),
        hasKey: parseTriStateBool(input.hasKey),
        hasNote: parseTriStateBool(input.hasNote),
        hasObservation: parseTriStateBool(input.hasObservation),
        hasVideo: parseTriStateBool(input.hasVideo),
        limit: parseAdminLimit(input.limit),
        order: input.order === "asc" ? "asc" : "desc",
        retryEmptyContext: parseTriStateBool(input.retryEmptyContext) === true,
        status: parseEnrichmentStatus(input.status),
      });
    } catch (error) {
      throw toFault(error);
    }
  });

  // GET /admin/tracks/work — admin tier (agent-allowed read). THE CATALOGUE-AWARE PIPELINE
  // QUEUE. `list_tracks_admin`'s queue filters all drive through the finding join, so they
  // are structurally blind to a catalogue track; analysis and embedding are measurements of
  // a RECORDING and apply to any track with captured audio, certified or not. This reads
  // `tracks` outer-joined to the certification, and hands the rows back in the order the
  // metered capture budget should be spent (docs/gpu-batch-embed.md, docs/the-ear.md).
  const listTrackWorkHandler = os.list_track_work.use(adminAuth).handler(async ({ input }) => {
    try {
      const tracks = await listTrackWork({
        kind: input.kind,
        limit: input.limit,
        scope: input.scope,
      });

      // `count=true` → the size of the WHOLE backlog, not the page. Opt-in: a page read is
      // capped at 200 rows, so `tracks.length` cannot answer "how much is left", and that is
      // the number the GPU batch reports at the end (rent another hour, or not). The counts the
      // 5-minute box sweeps never ask for are the ones they never pay for.
      const queued =
        input.count === "true"
          ? await countTrackWork({ kind: input.kind, scope: input.scope })
          : undefined;

      return { ok: true, queued, tracks } as const;
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks — operator tier (live `requireOperator`). Publish a finding
  // from a Spotify URL, then kick off async enrichment.
  const publishTrackHandler = os.publish_track
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const body: AdminTrackInputs["publish_track"] = input;

        if (typeof body.spotifyUrl !== "string") {
          throw new ORPCError("BAD_REQUEST", {
            data: { apiCode: "invalid_request", apiMessage: "Missing Spotify track URL" },
            message: "Missing Spotify track URL",
            status: 400,
          });
        }

        // The note rides into the Telegram post AND the stored editorial note, so
        // cap it on the add path too. On add, an empty note means "no note".
        const note = parseEditorialNote(body.note);

        const result = await publishTrack(body.spotifyUrl, {
          dryRun: body.dryRun === true,
          note: note || undefined,
        });

        // No on-add enrichment push: the add leaves the track at the schema
        // default `enrichment_status = "pending"`, which is queue-eligible. The
        // on-box `fluncle-enrich` `--no-agent` cron drains the enrich-queue every
        // ~5 min, analyzes on-box (ffmpeg + bun), and writes back via
        // `fluncle admin tracks update`.

        return { ok: true as const, ...result };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/observe — agent tier (`adminAuth` only). FLIPPED
  // from the operator tier so the Hermes observation cron drives it.
  const observeTrackHandler = os.observe_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: ObserveBody = input;
      const idOrLogId = body.trackId;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      // Idempotency (`observe:${logId}`): a finding that already has an observation
      // is a no-op, so re-pulling an in-flight item — or an external cron firing on
      // a fixed interval — never spends a second Cartesia render or overwrites the
      // existing artifact. The versioned playback URL on the row is already keyed by
      // the prior render; report it back unchanged. `force` bypasses this for a
      // deliberate operator re-render (voice re-tune / fixing a degenerate render).
      const force = body.force === true;

      if (track.observationAudioUrl && !force) {
        const existingBase = encodeURIComponent(track.logId);

        return {
          audioUrl: track.observationAudioUrl,
          durationMs: track.observationDurationMs ?? 0,
          generatedAt: track.observationGeneratedAt ?? "",
          jsonUrl: `${FOUND_BASE}/${existingBase}/observation.json`,
          logId: track.logId,
          ok: true as const,
          skipped: true as const,
          textUrl: trackMedia(track.logId).observationTextUrl,
          trackId: track.trackId,
          voiceId: "",
        };
      }

      // The agent authors + voice-gates the script; the Worker re-runs the
      // mechanical scan (defence in depth) and hard-fails on any violation.
      const script = gateObservationScript(body.script);
      const durationTargetSec = resolveDurationTargetSec(body.durationTargetSec);
      let promptVersion = typeof body.promptVersion === "number" ? body.promptVersion : null;

      // A force re-render of the UNCHANGED script (a voice/delivery re-tune) is not a
      // re-author: the stored prompt-version provenance describes who wrote the SCRIPT,
      // so it survives the render. Only an explicit --prompt-version, or a genuinely new
      // script, moves it — and an honest pre-registry null stays null.
      if (force && typeof body.promptVersion !== "number") {
        const stored = await getObservationProvenance(track.trackId);

        if (stored.script !== null && stored.script === script) {
          promptVersion = stored.promptVersion;
        }
      }

      // THE ECHO GATE — the anti-sameness rail, run BEFORE the paid Cartesia render so a
      // bounced draft costs nothing. Score the script against the finding's sonic
      // neighbourhood (the SAME neighbour scripts the box author was handed as spent moves,
      // `observationNeighbours` → `getSimilarFindings`), and a lifted phrase or wholesale word
      // overlap hard-fails with `observation_echoes_neighbours`/422 — so the observations, the
      // worst-measured family (docs/planning/homogenisation-evidence.md, 2026-07-14), can no
      // longer quietly flatten a region into one voice. A finding with no embedding yet, or the
      // first observation in an empty neighbourhood, has nothing to echo and passes untouched.
      // A rejected script is HELD in the `observation_rejections` ledger + raised in the
      // attention queue, never binned. `force` (a deliberate operator re-render) skips the gate —
      // he is overruling it, the same way accepting a held rejection does.
      if (!force) {
        const neighbors = await observationNeighbours(track.trackId);
        const thresholds = await getObservationEchoThresholds();
        const echo = scoreObservationEcho(script, neighbors, thresholds);

        if (echo.echoes) {
          // Best-effort: the ledger must never turn a clean 422 into a 500. Losing one
          // bounce's evidence is bad; failing the gate open would be worse.
          try {
            await recordObservationRejection(track.trackId, script, echo, thresholds);
          } catch (ledgerError) {
            console.error("observe_track: failed to hold the rejected observation", ledgerError);
          }

          throw observationEchoError(echo);
        }
      }

      // Render + upload + persist through the shared path (also the ledger's accept ruling).
      const result = await renderAndStoreObservation(track, script, {
        ...(typeof body.contextNote === "string" && body.contextNote.trim()
          ? { contextNote: body.contextNote }
          : {}),
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        durationTargetSec,
        promptVersion,
        ...(typeof body.voiceId === "string" ? { voiceId: body.voiceId } : {}),
      });

      return { ok: true as const, ...result };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/context — agent tier (`adminAuth` only).
  // The split-out context half: fetch the Firecrawl FACTS and write `context_note`
  // ONLY, quietly (track-update.ts does not bump updated_at for contextNote). The
  // Firecrawl output is UNTRUSTED web content treated strictly as DATA — assembled
  // into the note, stored as fuel, never executed as instructions.
  const contextTrackHandler = os.context_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const idOrLogId = input.trackId;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      // Idempotency (`context:${logId}`): a finding that already has a
      // context note is a no-op, so an external cron firing on a fixed interval
      // never re-burns the Firecrawl budget or overwrites the stored facts.
      //
      // `refresh` (the CLI's `--refresh`) RE-RUNS the fetch+distil even when a note
      // already exists — the deliberate operator action to backfill/sharpen an old
      // context note (the auto-note's primary fuel). It costs a Firecrawl + distil
      // pass per call, so it is opt-in; the default stays the short-circuit so the
      // every-tick context cron never re-burns the budget on an already-noted find.
      const refresh = input.refresh === true || input.refresh === "true";
      const existing = await getTrackContextNote(track.trackId);

      if (existing?.trim() && !refresh) {
        return {
          contextNote: existing,
          logId: track.logId,
          ok: true as const,
          skipped: true as const,
          sources: [],
          trackId: track.trackId,
        };
      }

      // Fetch the FACTS (Firecrawl) and DISTIL them into a clean note (OpenRouter).
      // The agent may override the search query; the result is internal DATA.
      const query =
        typeof input.query === "string" && input.query.trim()
          ? input.query.trim()
          : buildContextQuery(track);
      const fetched = await fetchTrackContext(
        query,
        {
          logId: track.logId,
          trackId: track.trackId,
        },
        // Apple editorial notes as extra fuel when the finding carries an ISRC (RFC U5);
        // folded into the same untrusted snippets and held behind the mechanical echo gate.
        { isrc: track.isrc },
      );

      // Persist the reliability marker alongside the note. The `context_status`
      // column makes a confirmed-empty fetch (`empty`) distinct from never-attempted
      // (NULL/`pending`), so the queue does not re-burn Firecrawl + the distil LLM on
      // a hopeless find every tick (`--retry-empty` re-picks `empty`; `failed` is a
      // vendor-down miss the next tick retries). All quiet: contextNote/contextStatus
      // are internal, so track-update.ts does NOT bump updated_at (no public surface
      // moves; the enrich-sweep stale clock and the sitemap lastmod stay untouched).
      if (fetched.status === "resolved" && fetched.contextNote.trim()) {
        await updateTrack(track.trackId, {
          contextNote: fetched.contextNote,
          // PROVENANCE, written in the same statement as the note it describes: the
          // `context_distil` version that distilled it, or NULL when the distil failed
          // and the cleaned raw snippets were stored instead (no prompt wrote those).
          contextPromptVersion: fetched.promptVersion,
          contextStatus: "resolved",
        });
      } else if (refresh && existing?.trim()) {
        // A `--refresh` that re-fetched nothing usable must NOT downgrade a finding
        // that already had a good note: keep the prior note + its `resolved` status
        // rather than blanking the status to `empty`/`failed` and losing the fuel.
        // (No write at all — the row is already resolved.)
      } else {
        await updateTrack(track.trackId, { contextStatus: fetched.status });
      }

      // On a `--refresh` no-op (re-fetch found nothing usable but a note already
      // existed), report the PRESERVED note, not the empty re-fetch result.
      const contextNote =
        fetched.status === "resolved" && fetched.contextNote.trim()
          ? fetched.contextNote
          : refresh && existing?.trim()
            ? existing
            : fetched.contextNote;

      return {
        contextNote,
        logId: track.logId,
        ok: true as const,
        sources: fetched.sources,
        trackId: track.trackId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/note — agent tier (`adminAuth` only). The
  // written-note sibling of observe_track: the agent authored the editorial note in
  // Fluncle's voice; this step VOICE-GATES it and stores it into the `note` field.
  // CARDINAL SAFETY: fills an EMPTY note ONLY — a finding with a note already
  // (operator-written OR previously auto-authored) is a no-op (`skipped: true`); the
  // operator override always wins, enforced here, server-side.
  //
  // TWO GATES, both server-side (the agent gates as it writes; the Worker re-runs both
  // — the note lands straight on the public /log surface):
  //   1. the VOICE gate (`gateNoteText`) — the banned-word / geography / Dry-Rule scan.
  //   2. the ECHO gate (`scoreNoteEcho` + `noteEchoError`) — the anti-sameness rail on
  //      the vibe-neighbour layer. The authoring prompt now shows the agent the notes of
  //      the finding's SONIC NEIGHBOURS so it can hear the region's register; this
  //      re-reads those same notes and hard-fails a line that lifts from one. The
  //      neighbours inform, they never template. A rejected note is NOT STORED on the
  //      finding — but it is HELD in the `note_rejections` ledger and raised as a row in
  //      the operator's attention queue, so he can read what the model wrote and overrule
  //      the gate. The thresholds are operator-tunable at runtime (the `settings` KV).
  //
  // A CATALOGUE track can never reach either gate: `requireTrack` reads through the
  // `findings ⋈ tracks` join, so an uncertified track is a 404 before a note is even
  // parsed. Fluncle does not speak about a track he has not certified.
  const noteTrackHandler = os.note_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: NoteBody = input;
      const idOrLogId = body.trackId;
      // `dryRun` authors nothing and stores nothing: it runs BOTH gates and reports the
      // verdict + the measured echo. It is how the sweep pre-checks a line before
      // spending a write, and how the neighbour layer is A/B-measured without touching
      // the archive.
      const dryRun = body.dryRun === true;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every finding needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every finding needs a coordinate.",
          status: 400,
        });
      }

      // FAST-PATH short-circuit for the fill-empty-only guarantee. `track.note` is
      // `undefined` only when the stored note is empty/whitespace (toTrackListItem
      // trims it); a note already present here short-circuits to a no-op, which saves
      // a voice-gate run + a write. This is an OPTIMISATION, not the guarantee: the
      // cardinal guard — the agent NEVER overwrites an existing note — is now enforced
      // atomically at the DB by `fillEmptyNote`'s `and (note is null or trim(note) =
      // '')` predicate below, so a note that lands AFTER this read still can't be
      // clobbered. We still stamp the "ran" state (the workflow ran; it correctly
      // found nothing to do) so the board doesn't keep re-queuing a hand-noted finding.
      //
      // A DRY RUN skips the short-circuit (it stores nothing, so there is nothing to
      // protect) — that is what lets the operator hold a candidate line up against an
      // already-noted finding's neighbourhood and read the verdict.
      if (!dryRun && track.note?.trim()) {
        await recordNoteAttempt(track.trackId, false);

        return {
          logId: track.logId,
          note: track.note,
          ok: true as const,
          skipped: true as const,
          trackId: track.trackId,
        };
      }

      // Voice-gate the agent-authored note (defence in depth: the agent gates as it
      // writes; the Worker re-scans and hard-fails any violation before it is stored
      // — the note lands straight on the public /log surface).
      const note = gateNoteText(body.note);

      // Echo-gate it against the finding's sonic neighbourhood — the SAME notes the
      // authoring prompt showed the agent (`get_similar_findings`, the MuQ nearest
      // neighbours, ranked in SQL). A lifted phrase or wholesale word overlap hard-fails
      // here with `note_echoes_neighbours`/422, so the vibe-neighbour layer can never
      // quietly flatten a region into one voice. A finding with no embedding yet, or the
      // first note in an empty neighbourhood, has nothing to echo and passes untouched.
      //
      // The thresholds are read from the `settings` KV on every run, so the operator can
      // retune the gate without a deploy (`update_note_gate`).
      const neighbors = await noteNeighbors(track.trackId);
      const thresholds = await getNoteEchoThresholds();
      const echo = scoreNoteEcho(note, neighbors, thresholds);

      if (echo.echoes) {
        // THE REJECTION IS HELD, NOT BINNED. The gate still refuses to STORE the line —
        // that is unchanged, and the finding stays note-less. But the line is written to
        // the ledger first, with the neighbour it echoed, the phrase, the score, and the
        // thresholds in force, so the operator can read what the model wrote and rule on
        // it from the `/admin` attention queue. A gate whose rejections nobody can see is
        // a gate nobody can supervise.
        //
        // A DRY RUN holds nothing (it is a measurement harness — the A/B re-measurement
        // runs it across the whole archive, and that must not fill the operator's queue
        // with rows he never has to act on). It reports the echo and stores nothing, which
        // is exactly its contract.
        if (!dryRun) {
          // Best-effort: the ledger must never turn a clean 422 into a 500. Losing one
          // bounce's evidence is bad; failing the gate open would be worse.
          try {
            await recordNoteRejection(track.trackId, note, echo, thresholds);
          } catch (ledgerError) {
            console.error("note_track: failed to hold the rejected note", ledgerError);
          }
        }

        throw noteEchoError(echo);
      }

      // The dry run stops here: both gates ran, nothing was written, and the caller gets
      // the measured echo back. No `recordNoteAttempt` — no attempt was made.
      if (dryRun) {
        return {
          dryRun: true as const,
          echo: { logId: echo.logId, overlap: echo.overlap, phrase: echo.phrase },
          logId: track.logId,
          neighbors: neighbors.map((neighbor) => neighbor.logId),
          note,
          ok: true as const,
          trackId: track.trackId,
        };
      }

      // Fill the empty note ATOMICALLY. The fill-empty-only guard is now a DB
      // predicate inside `fillEmptyNote` (`and (note is null or trim(note) = '')`),
      // not the check-then-act above — so an operator note (or a concurrent agent
      // tick) that landed between our read and this write can NEVER be clobbered: the
      // loser matches no row and reports `skipped`. `parseEditorialNote` re-validates
      // the length against the public budget on the same path an operator note takes
      // (it returns `undefined` only for a non-string input, which `gateNoteText`
      // has already ruled out — the `?? note` narrows the type without an assertion).
      const filled = await fillEmptyNote(
        track.trackId,
        parseEditorialNote(note) ?? note,
        body.promptVersion,
      );

      if (!filled) {
        // Lost the race: a note landed between our read and this write. The guard held
        // at the DB, so we wrote nothing — re-read the winner and report skipped,
        // never clobber. `track.logId` is the immutable coordinate (guarded above).
        await recordNoteAttempt(track.trackId, false);
        const current = await requireTrack(idOrLogId);

        return {
          logId: track.logId,
          note: current.note ?? note,
          ok: true as const,
          skipped: true as const,
          trackId: track.trackId,
        };
      }

      await recordNoteAttempt(track.trackId, true);

      return {
        echo: { logId: echo.logId, overlap: echo.overlap, phrase: echo.phrase },
        logId: track.logId,
        note,
        ok: true as const,
        trackId: track.trackId,
      };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/video/uploads — agent tier (any admin principal,
  // operator OR agent): the autonomous render box publishes its own renders. The JSON
  // control-plane: sign the direct-to-R2 PUT URLs.
  const presignVideoUploadsHandler = os.presign_track_video_uploads
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        const requested = Array.isArray(input.fields) ? input.fields : undefined;

        if (!requested || requested.length === 0) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_fields",
              apiMessage: "List the artifact `fields` you want to upload",
            },
            message: "List the artifact `fields` you want to upload",
            status: 400,
          });
        }

        const artifacts: VideoArtifact[] = [];

        for (const field of requested) {
          if (typeof field !== "string") {
            throw new ORPCError("BAD_REQUEST", {
              data: { apiCode: "bad_field", apiMessage: "Each field must be a string" },
              message: "Each field must be a string",
              status: 400,
            });
          }

          const artifact = artifactByField(field);

          if (!artifact) {
            throw new ORPCError("BAD_REQUEST", {
              data: {
                apiCode: "unknown_field",
                apiMessage: `Unknown video artifact field: ${field}`,
              },
              message: `Unknown video artifact field: ${field}`,
              status: 400,
            });
          }

          artifacts.push(artifact);
        }

        // The one sanctioned footage-less upload: the plate-lane PRE-upload. Plates
        // (plate.png + plate.background.png) go up BEFORE the composition exists so
        // the composition can reference the durable found.fluncle.com URL — the
        // upload-first order. Any other footage-less set still 400s.
        const platesOnly =
          artifacts.length > 0 &&
          artifacts.every(
            (artifact) => artifact.field === "plate" || artifact.field === "plate-background",
          );

        if (!platesOnly && !artifacts.some((artifact) => artifact.field === "footage")) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_footage",
              apiMessage: "A `footage` cut (footage.mp4) is required",
            },
            message: "A `footage` cut (footage.mp4) is required",
            status: 400,
          });
        }

        const signed = await presignUploads(
          VIDEOS_BUCKET,
          artifacts.map((artifact) => ({
            contentType: artifact.contentType,
            key: `${track.logId}/${artifact.name}`,
          })),
        );

        const uploads = signed.map((row, index) => {
          const artifact = artifacts[index];
          if (artifact === undefined) {
            throw new Error("Presigned upload row has no matching artifact");
          }

          return {
            contentType: row.contentType,
            field: artifact.field,
            key: row.key,
            url: row.url,
          };
        });

        return { logId: track.logId, ok: true as const, trackId: track.trackId, uploads };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/video/finalize — agent tier (any admin principal,
  // operator OR agent): the autonomous render box links its own cut. Phase 2: link the
  // canonical web cut (sets video_url).
  const finalizeVideoHandler = os.finalize_track_video.use(adminAuth).handler(async ({ input }) => {
    try {
      const body: AdminTrackInputs["finalize_track_video"] = input;
      const idOrLogId = body.trackId;
      const track = await requireTrack(idOrLogId);

      if (!track.logId) {
        throw new ORPCError("BAD_REQUEST", {
          data: {
            apiCode: "no_log_id",
            apiMessage:
              "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
          },
          message: "Track has no Log ID; every video needs a coordinate.",
          status: 400,
        });
      }

      const bodyVehicle =
        typeof body.videoVehicle === "string" && body.videoVehicle.trim()
          ? body.videoVehicle.trim().slice(0, 120)
          : undefined;
      const bodyGrain =
        typeof body.videoGrain === "string" && body.videoGrain.trim()
          ? body.videoGrain.trim().slice(0, 120)
          : undefined;
      const bodyRegister =
        typeof body.videoRegister === "string" && body.videoRegister.trim()
          ? body.videoRegister.trim().slice(0, 120)
          : undefined;
      const bodyPalette =
        typeof body.videoPalette === "string" && body.videoPalette.trim()
          ? body.videoPalette.trim().slice(0, 120)
          : undefined;
      const bodyPlateSubject =
        typeof body.videoPlateSubject === "string" && body.videoPlateSubject.trim()
          ? body.videoPlateSubject.trim().slice(0, 120)
          : undefined;
      const bodyStructure =
        typeof body.videoStructure === "string" && body.videoStructure.trim()
          ? body.videoStructure.trim().slice(0, 120)
          : undefined;
      const bodyModel =
        typeof body.videoModel === "string" && body.videoModel.trim()
          ? body.videoModel.trim().slice(0, 120)
          : undefined;
      const bodyReasoning =
        typeof body.videoModelReasoning === "string" && body.videoModelReasoning.trim()
          ? body.videoModelReasoning.trim().slice(0, 120)
          : undefined;

      // THE TRANSPORT-PROOF STAMP FALLBACK (the 044.1.3L lesson): when the body
      // leaves any diversity-ledger stamp out — a crashed CLI's salvage ship, a
      // partial upload, any caller that never read the manifest — read the bundle's
      // own render.json from R2 and fill the gaps. The manifest was uploaded by the
      // same ship this finalize completes, so it is the authority of record; a
      // missing/corrupt manifest yields {} and the finalize lands exactly as before.
      // `structure`/`plateSubject` are the two provenance fields render.json ALWAYS carried but the
      // finalize path never persisted (Wave-1 C). No caller (the CLI, the render agent) sends them
      // in the body, so they are read from the manifest — meaning the manifest read must run unless
      // the body already supplied EVERY stamp. Adding them to the skip guard keeps the R2 read on
      // for exactly the (near-universal) case where the two new stamps are absent from the body,
      // without changing the render prompt or the CLI at all.
      const manifestStamps =
        bodyVehicle && bodyGrain && bodyRegister && bodyPalette && bodyStructure && bodyPlateSubject
          ? {}
          : await readRenderManifestStamps(env.VIDEOS, track.logId);
      const videoVehicle = bodyVehicle ?? manifestStamps.vehicle;
      const videoGrain = bodyGrain ?? manifestStamps.grain;
      const videoRegister = bodyRegister ?? manifestStamps.register;
      const videoPalette = bodyPalette ?? manifestStamps.palette;
      const videoPlateSubject = bodyPlateSubject ?? manifestStamps.plateSubject;
      const videoStructure = bodyStructure ?? manifestStamps.structure;
      const videoModel = bodyModel ?? manifestStamps.model ?? "anthropic/claude-opus-4-8";
      const videoModelReasoning = bodyReasoning ?? manifestStamps.reasoning ?? "high";

      const videoUrl = trackMedia(track.logId).videoUrl;
      // `squared` (the CLI sends it when it uploaded BOTH the square footage.mp4
      // and the portrait footage.social.mp4) flips the two-master layout on:
      // footage.mp4 is now the clean square crop source. Stamp the signal so the
      // archive surfaces start MT-cropping this finding.
      const squared = body.squared === true;

      // A RE-RENDER: this finding already had a `video_url` (the prior render),
      // and finalize re-ships `footage.mp4` to the SAME R2 key. The bare master
      // URL is byte-identical (the queue gates on presence, not content), so the
      // DB write below is a no-op for `video_url` — but stale renditions live on.
      // The NEW `videoSquaredAt` below is the vintage every surface rides as the
      // transform `?v` token (media.ts `videoVersion`), which is what actually
      // evicts MT's internally-cached renditions; the purge covers the bare R2
      // objects + any zone-edge copies. Best-effort, fired off the request
      // lifecycle (waitUntil) BELOW after the DB write commits.
      const squaredAt = squared ? new Date().toISOString() : undefined;

      await updateTrack(track.trackId, {
        videoModel,
        videoModelReasoning,
        videoUrl,
        ...(squaredAt ? { videoSquaredAt: squaredAt } : {}),
        ...(videoVehicle ? { videoVehicle } : {}),
        ...(videoGrain ? { videoGrain } : {}),
        ...(videoRegister ? { videoRegister } : {}),
        ...(videoPalette ? { videoPalette } : {}),
        ...(videoPlateSubject ? { videoPlateSubject } : {}),
        ...(videoStructure ? { videoStructure } : {}),
      });

      // Drop stale edge entries on EVERY finalize, not just when track.videoUrl was
      // already set: the requeue flow clears video_url to re-queue a finding, so a
      // re-render's finalize sees no prior url and would otherwise skip the purge (the
      // gap the manual heartbeat used to cover). On a genuine first render nothing is
      // cached yet, so this is a harmless no-op. `squared` reflects the layout the
      // finding now carries, so the purge set matches what the surfaces will request —
      // built with the NEW vintage, the same `?v` the surfaces mint from now on.
      purgeVideoCache(
        track.logId,
        squared || Boolean(track.videoSquaredAt),
        videoVersion(squaredAt ?? track.videoSquaredAt),
      );

      return { logId: track.logId, ok: true as const, trackId: track.trackId, videoUrl };
    } catch (error) {
      throw toFault(error);
    }
  });

  // POST /admin/tracks/{trackId}/video/requeue — operator tier (live
  // `requireOperator`). Clear a finding's video so it re-enters the render queue AND
  // drops cleanly off radio until re-rendered. This removes a LIVE published video,
  // so it is operator-only (NOT agent-tier — the box agent never clears videos).
  //
  // It clears BOTH display/queue gates, the minimal set that fully returns a finding
  // to "no video": `video_url` (the render queue's gate — `hasVideo=false` is
  // `video_url is null`) and `video_squared_at` (radio's eligibility gate). Clearing
  // only `video_url` would re-queue it but leave it eligible-but-broken on radio (no
  // playable square-master source). The ledger columns (videoVehicle/videoGrain/
  // videoModel/videoModelReasoning) are LEFT INTACT on purpose — they describe the
  // prior render and the next video agent reads them to diversify away from it.
  //
  // CACHE NOTE: re-shipping footage.mp4 to the same R2 key leaves Cloudflare
  // Media-Transformation renditions cached separately (the player streams MT crops,
  // not the master). finalize_track_video now purges them automatically on a
  // re-render; purge_video (below) is the manual operator twin.
  const requeueVideoHandler = os.requeue_video
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        // Idempotent: a finding already at "no video" is a clean no-op — skip the
        // write entirely (no needless updateTrack/cache purge), report alreadyClear.
        if (!track.videoUrl && !track.videoSquaredAt) {
          return {
            alreadyClear: true as const,
            logId: track.logId,
            ok: true as const,
            trackId: track.trackId,
          };
        }

        // Clear both gates. updateTrack maps an empty string to NULL for each (the
        // documented "remove an off-direction video" + re-render paths), so the
        // `video_url is not null` queue filter and the `video_squared_at is not null`
        // radio filter both drop this finding until it is re-rendered.
        await updateTrack(track.trackId, { videoSquaredAt: "", videoUrl: "" });

        return { logId: track.logId, ok: true as const, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  // POST /admin/tracks/{trackId}/video/purge — operator tier (live
  // `requireOperator`). The manual twin of the automatic re-render purge in
  // finalize: evict this finding's stale Cloudflare Media-Transformation renditions
  // from the edge (the player streams MT crops, not the master, so a same-key
  // re-upload leaves the renditions stale). Operator-only — it acts on a LIVE video.
  const purgeVideoHandler = os.purge_video
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const idOrLogId = input.trackId;
        const track = await requireTrack(idOrLogId);

        if (!track.logId) {
          throw new ORPCError("BAD_REQUEST", {
            data: {
              apiCode: "no_log_id",
              apiMessage:
                "Track has no Log ID; every video needs a coordinate. Backfill the ISRC/Log ID first.",
            },
            message: "Track has no Log ID; every video needs a coordinate.",
            status: 400,
          });
        }

        // No video → nothing cached to purge. Report the no-op rather than firing a
        // pointless purge of URLs that resolve to a missing master.
        if (!track.videoUrl) {
          return {
            logId: track.logId,
            noVideo: true as const,
            ok: true as const,
            trackId: track.trackId,
          };
        }

        // Fire-and-forget (waitUntil inside). `squared` mirrors the finding's layout
        // so the purge set matches the rendition family the surfaces actually serve.
        purgeVideoCache(
          track.logId,
          Boolean(track.videoSquaredAt),
          videoVersion(track.videoSquaredAt),
        );

        return { logId: track.logId, ok: true as const, trackId: track.trackId };
      } catch (error) {
        throw toFault(error);
      }
    });

  // GET /admin/tracks/mixable-order — admin tier (`adminAuth` only, agent-allowed like
  // get_track_admin). A PURE read: it imports only the read path + the pure mixability
  // core, never a write/publish surface (`promote_recording` remains the only mint).
  // `ids` is the comma-separated pool (2..64 validated Log IDs; a 65-id / junk request
  // 400s here — the contract's `ids: string` is validated in-handler like the other
  // tolerant admin query strings). Orders the pool into a smooth proposed chain.
  const getMixableOrderHandler = os.get_mixable_order.use(adminAuth).handler(async ({ input }) => {
    const ids = input.ids
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (ids.length < 2 || ids.length > 64) {
      throw new ORPCError("BAD_REQUEST", {
        data: { apiCode: "invalid_request", apiMessage: "Provide 2 to 64 Log IDs to order" },
        message: "Provide 2 to 64 Log IDs to order",
      });
    }

    const invalid = ids.filter((id) => !isLogId(id));

    if (invalid.length > 0) {
      throw new ORPCError("BAD_REQUEST", {
        data: {
          apiCode: "invalid_request",
          apiMessage: `Not a Log ID: ${invalid.join(", ")}`,
        },
        message: `Not a Log ID: ${invalid.join(", ")}`,
      });
    }

    if (input.seed !== undefined && !isLogId(input.seed)) {
      throw new ORPCError("BAD_REQUEST", {
        data: { apiCode: "invalid_request", apiMessage: `Not a Log ID: ${input.seed}` },
        message: `Not a Log ID: ${input.seed}`,
      });
    }

    try {
      const result = await getMixableOrder(ids, { seedLogId: input.seed });

      return { ...result, ok: true as const };
    } catch (error) {
      if (error instanceof MixableOrderError) {
        throw new ORPCError("BAD_REQUEST", {
          data: { apiCode: "invalid_request", apiMessage: error.message },
          message: error.message,
        });
      }

      throw toFault(error);
    }
  });

  return {
    context_track: contextTrackHandler,
    finalize_track_video: finalizeVideoHandler,
    get_mixable_order: getMixableOrderHandler,
    get_track_admin: getTrackAdminHandler,
    list_track_work: listTrackWorkHandler,
    list_tracks_admin: listTracksAdminHandler,
    note_track: noteTrackHandler,
    observe_track: observeTrackHandler,
    presign_track_video_uploads: presignVideoUploadsHandler,
    publish_track: publishTrackHandler,
    purge_video: purgeVideoHandler,
    requeue_video: requeueVideoHandler,
    update_track: updateTrackHandler,
  };
}
