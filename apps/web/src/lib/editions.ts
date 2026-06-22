import { type EditionDTO } from "@fluncle/contracts";

export type { EditionDTO };

/** The `editions` row shape the reads hydrate from (snake_case columns). */
export type EditionRowLike = {
  added_at?: string | null;
  content_json: string;
  created_at?: string | null;
  id: string;
  number?: number | null;
  sent_at?: string | null;
  status?: "draft" | "sent" | null;
  subject?: string | null;
  updated_at?: string | null;
  window_since?: string | null;
  window_until?: string | null;
};

/**
 * The structured content the agent authors and the archive page + email both
 * render from. Parsed off `content_json` — a defensive parse keeps a malformed
 * payload from crashing a read (a draft mid-author could be partial). The fields
 * mirror `EditionContentSchema` (../../packages/contracts/src/orpc/_shared.ts).
 */
function parseContent(contentJson: string): EditionDTO["content"] {
  try {
    const parsed = JSON.parse(contentJson) as unknown;

    if (parsed && typeof parsed === "object") {
      return parsed as EditionDTO["content"];
    }
  } catch {
    // A malformed payload degrades to an empty edition body rather than a 500.
  }

  return {};
}

/** Map a DB row to the public `EditionDTO` — the single mapping every read uses. */
export function rowToEdition(row: EditionRowLike): EditionDTO {
  return {
    addedAt: row.added_at ?? undefined,
    content: parseContent(row.content_json),
    createdAt: row.created_at ?? undefined,
    id: row.id,
    number: row.number ?? undefined,
    sentAt: row.sent_at ?? undefined,
    status: row.status ?? "draft",
    subject: row.subject?.trim() ? row.subject : undefined,
    updatedAt: row.updated_at ?? undefined,
    windowSince: row.window_since ?? undefined,
    windowUntil: row.window_until ?? undefined,
  };
}
