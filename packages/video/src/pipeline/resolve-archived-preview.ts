import { type ResolvedPreview } from "./resolve-preview";

const API_BASE = process.env.FLUNCLE_API_URL ?? "https://www.fluncle.com";

export async function resolveArchivedPreview(idOrLogId: string): Promise<ResolvedPreview | null> {
  const token = process.env.FLUNCLE_API_TOKEN;
  if (!token) {
    return null;
  }

  const authorization = `Bearer ${token}`;

  try {
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
