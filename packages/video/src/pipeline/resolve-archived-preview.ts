// Resolve a track's preview from its R2 analysis archive (region-independent) —
// the production path for a render host that can't reach Deezer/iTunes, whose
// search results and preview availability are region/IP-gated. It reads the
// AGENT-tier preview endpoint to confirm an archive exists, then points at the
// AGENT-tier preview-audio route that streams the archived bytes (the R2 bucket
// is private, so the download must carry the bearer — the returned `headers`).
// Returns null when there is no archived preview OR no admin token in env (e.g. a
// local workstation), so the caller falls back to the live Deezer/iTunes search
// (resolve-preview.ts).

import { type ResolvedPreview } from "./resolve-preview";

const API_BASE = process.env.FLUNCLE_API_URL ?? "https://www.fluncle.com";

export async function resolveArchivedPreview(idOrLogId: string): Promise<ResolvedPreview | null> {
  const token = process.env.FLUNCLE_API_TOKEN;
  if (!token) {
    // No admin token (local dev) — let the caller fall back to the live search.
    return null;
  }

  const authorization = `Bearer ${token}`;

  try {
    // Probe the metadata route first (cheap JSON, no audio bytes) so a track with
    // no archive returns null HERE and the caller falls back to the live search,
    // rather than committing to the archive path and throwing at download time.
    const res = await fetch(
      `${API_BASE}/api/admin/tracks/${encodeURIComponent(idOrLogId)}/preview`,
      { headers: { authorization } },
    );
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { archived?: boolean };
    if (!body.archived) {
      return null;
    }
    // The private R2 bucket is fronted by the AGENT-tier preview-audio route,
    // which streams the archived bytes; the download must carry the same bearer.
    return {
      confidence: 1,
      headers: { authorization },
      source: "archive",
      url: `${API_BASE}/api/admin/tracks/${encodeURIComponent(idOrLogId)}/preview-audio`,
    };
  } catch {
    return null;
  }
}
