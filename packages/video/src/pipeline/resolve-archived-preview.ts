// Resolve a track's preview from its R2 analysis archive (region-independent) —
// the production path for a render host that can't reach Deezer/iTunes, whose
// search results and preview availability are region/IP-gated. It reads the
// AGENT-tier preview endpoint for the content-addressed key, then points at the
// public R2 object. Returns null when there is no archived preview OR no admin
// token in env (e.g. a local workstation), so the caller falls back to the live
// Deezer/iTunes search (resolve-preview.ts).

import { type ResolvedPreview } from "./resolve-preview";

const API_BASE = process.env.FLUNCLE_API_URL ?? "https://www.fluncle.com";
const MEDIA_BASE = "https://found.fluncle.com";

export async function resolveArchivedPreview(idOrLogId: string): Promise<ResolvedPreview | null> {
  const token = process.env.FLUNCLE_API_TOKEN;
  if (!token) {
    // No admin token (local dev) — let the caller fall back to the live search.
    return null;
  }

  try {
    const res = await fetch(
      `${API_BASE}/api/admin/tracks/${encodeURIComponent(idOrLogId)}/preview`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { archived?: boolean; key?: string };
    if (!body.archived || !body.key) {
      return null;
    }
    return { confidence: 1, source: "archive", url: `${MEDIA_BASE}/${body.key}` };
  } catch {
    return null;
  }
}
