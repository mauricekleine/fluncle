// The API seam (RFC Unit 2 — Data). Every API touch lives behind these functions;
// the UI never sees the transport. Phase 0: served from a typed mock seeded with
// real records (so the feed plays real CDN videos). Phase 1 (after the oRPC
// migration): replace these bodies with the oRPC client + @orpc/tanstack-query —
// the hooks and UI don't change.
import { type TrackListItem, type TrackListPage } from "@fluncle/contracts";
import mockFindings from "@/api/mock-findings.json";

// Phase-1: moves to @fluncle/contracts as RegisterDeviceRequest.
export type RegisterDeviceRequest = {
  token: string;
  platform: "ios" | "android";
  appVersion?: string;
  mutedCategories?: ("finding" | "mixtape")[];
};

const FINDINGS = mockFindings as unknown as TrackListItem[];
const PAGE_SIZE = 6;

/** Findings feed (newest-first), cursor-paginated. Mirrors GET /api/v1/tracks. */
export async function fetchFindingsFeed(cursor?: string): Promise<TrackListPage> {
  const start = cursor ? Number(cursor) : 0;
  const tracks = FINDINGS.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE;
  return {
    nextCursor: next < FINDINGS.length ? String(next) : undefined,
    totalCount: FINDINGS.length,
    tracks,
  };
}

/** A single finding by trackId or Log ID. Mirrors GET /api/v1/tracks/{idOrLogId}. */
export async function fetchFinding(idOrLogId: string): Promise<TrackListItem | undefined> {
  const up = idOrLogId.toUpperCase();
  return FINDINGS.find((f) => f.logId?.toUpperCase() === up || f.trackId === idOrLogId);
}

/** Register a device for push. Mirrors POST /api/v1/devices (Phase 1 endpoint). */
export async function registerDevice(req: RegisterDeviceRequest): Promise<{ ok: true }> {
  // Phase 0 no-op so the client opt-in UX is testable without the endpoint.
  if (__DEV__) {
    console.log("[push] registerDevice (stub):", req.platform);
  }
  return { ok: true };
}
