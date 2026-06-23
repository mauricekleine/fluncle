import { type EditionDTO } from "@fluncle/contracts";
import { GALAXIES } from "./galaxies";

export type { EditionDTO };

/** A galaxy block as the archive page renders it (the content payload's shape). */
export type EditionGalaxyBlock = NonNullable<EditionDTO["content"]["galaxies"]>[number];

// The canonical galaxy reading order (the vibe map's quadrants, the same Solar →
// Nebular → Lunar → Astral the board and the email follow). A block's `galaxy`
// is a free label the agent wrote, so match it case-insensitively against the
// known galaxy names; anything off-map (e.g. "Also found") keeps its authored
// position after the known ones.
const GALAXY_ORDER = ["Solar", "Nebular", "Lunar", "Astral"] as const;

function galaxyRank(label: string): number {
  const known = Object.values(GALAXIES).find(
    (galaxy) => galaxy.name.toLowerCase() === label.trim().toLowerCase(),
  );

  if (!known) {
    return GALAXY_ORDER.length;
  }

  const index = GALAXY_ORDER.indexOf(known.name as (typeof GALAXY_ORDER)[number]);

  return index === -1 ? GALAXY_ORDER.length : index;
}

/**
 * Order an edition's galaxy blocks for reading — the known galaxies in their
 * canonical sequence, off-map labels trailing in authored order. A stable sort,
 * so two blocks with the same rank keep the order the agent wrote them in. Empty
 * blocks (no findings) are dropped so the page never renders a bare heading.
 */
export function orderedGalaxies(content: EditionDTO["content"]): EditionGalaxyBlock[] {
  return (content.galaxies ?? [])
    .filter((block) => block.findings.length > 0)
    .map((block, index) => ({ block, index }))
    .sort((a, b) => galaxyRank(a.block.galaxy) - galaxyRank(b.block.galaxy) || a.index - b.index)
    .map(({ block }) => block);
}

/**
 * A one-line preview of an edition for the archive list — the intro, trimmed to a
 * readable length on a word boundary with an ellipsis. Empty string when an
 * edition has no intro (the list falls back to its finding count).
 */
export function editionIntroSnippet(content: EditionDTO["content"], maxLength = 140): string {
  const intro = content.intro?.trim();

  if (!intro) {
    return "";
  }

  const collapsed = intro.replace(/\s+/g, " ");

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  const clipped = collapsed.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");

  return `${(lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/** The total finding count across an edition's galaxy blocks (the list's fallback line). */
export function editionFindingCount(content: EditionDTO["content"]): number {
  return (content.galaxies ?? []).reduce((sum, block) => sum + block.findings.length, 0);
}

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
