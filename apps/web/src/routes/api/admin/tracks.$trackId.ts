import { createFileRoute } from "@tanstack/react-router";

import { jsonError, requireAdmin } from "../../../lib/server/env";
import { ApiError } from "../../../lib/server/spotify";
import { type TrackUpdate, updateTrack } from "../../../lib/server/track-update";

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
      PATCH: async ({ request }) => {
        const unauthorized = await requireAdmin(request);

        if (unauthorized) {
          return unauthorized;
        }

        const trackId = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";

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

          if (typeof body.note === "string") {
            update.note = body.note;
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

          const result = await updateTrack(trackId, update);

          return Response.json({ ok: true, ...result });
        } catch (error) {
          if (error instanceof ApiError) {
            return jsonError(error.status, error.code, error.message);
          }

          return jsonError(500, "error", error instanceof Error ? error.message : String(error));
        }
      },
    },
  },
});
