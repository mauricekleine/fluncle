import { createFileRoute } from "@tanstack/react-router";

import { adminRole, jsonError, requireAdmin } from "../../../lib/server/env";
import { apiErrorResponse, parseEditorialNote } from "../../../lib/server/http-errors";
import { type TrackUpdate, updateTrack } from "../../../lib/server/track-update";

// Fields only the operator may write: editorial voice (note), the vehicle/video
// (videoUrl), the map placement (vibeX/vibeY), and the immutable identity fields
// (isrc/logId). The agent role is limited to machine-measured analysis (bpm, key,
// features, enrichmentStatus) — overwritable, internal, no public footprint.
const OPERATOR_ONLY_FIELDS: (keyof TrackUpdate)[] = [
  "isrc",
  "logId",
  "note",
  "vibeX",
  "vibeY",
  "videoUrl",
];

type PatchBody = {
  bpm?: unknown;
  enrichmentStatus?: unknown;
  features?: unknown;
  isrc?: unknown;
  key?: unknown;
  logId?: unknown;
  note?: unknown;
  videoUrl?: unknown;
  vibeX?: unknown;
  vibeY?: unknown;
};

export const Route = createFileRoute("/api/admin/tracks/$trackId")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        const trackId = params.trackId;

        try {
          const body = (await request.json()) as PatchBody;
          const update: TrackUpdate = {};

          if (typeof body.bpm === "number" && Number.isFinite(body.bpm)) {
            update.bpm = body.bpm;
          }

          if (typeof body.key === "string") {
            update.key = body.key;
          }

          if (typeof body.features === "string") {
            update.features = body.features;
          }

          if (typeof body.videoUrl === "string") {
            update.videoUrl = body.videoUrl;
          }

          if (
            body.enrichmentStatus === "pending" ||
            body.enrichmentStatus === "done" ||
            body.enrichmentStatus === "failed"
          ) {
            update.enrichmentStatus = body.enrichmentStatus;
          }

          // A present note sets it (including "" which clears the stored note);
          // an absent note leaves it untouched. parseEditorialNote throws on too-long.
          if (typeof body.note === "string") {
            update.note = parseEditorialNote(body.note);
          }

          if (typeof body.vibeX === "number" && Number.isFinite(body.vibeX)) {
            update.vibeX = body.vibeX;
          }

          if (typeof body.vibeY === "number" && Number.isFinite(body.vibeY)) {
            update.vibeY = body.vibeY;
          }

          // Straggler repair: one-time backfill of identity fields into null
          // slots (updateTrack enforces immutability once set).
          if (typeof body.isrc === "string") {
            update.isrc = body.isrc;
          }

          if (typeof body.logId === "string") {
            update.logId = body.logId;
          }

          // The agent role may only touch analysis fields. Reject (not silently
          // drop) an attempt at an operator-only field — a 403 the gate can voice.
          if ((await adminRole(request)) === "agent") {
            const blocked = OPERATOR_ONLY_FIELDS.filter((field) => field in update);

            if (blocked.length > 0) {
              return jsonError(
                403,
                "forbidden",
                `The agent role can write only analysis fields, not: ${blocked.join(", ")}`,
              );
            }
          }

          const result = await updateTrack(trackId, update);

          return Response.json({ ok: true, ...result });
        } catch (error) {
          return apiErrorResponse(error);
        }
      },
    },
  },
});

export const serverHandlers = Route.options.server!.handlers;
