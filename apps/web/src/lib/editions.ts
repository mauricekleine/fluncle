import { type EditionDTO } from "@fluncle/contracts";

export type { EditionDTO };

export type EditionGalaxyBlock = NonNullable<EditionDTO["content"]["galaxies"]>[number];

function galaxyRank(label: string, knownGalaxyNames: readonly string[]): number {
  const index = knownGalaxyNames.findIndex(
    (name) => name.toLowerCase() === label.trim().toLowerCase(),
  );

  return index === -1 ? knownGalaxyNames.length : index;
}

export function orderedGalaxies(
  content: EditionDTO["content"],
  knownGalaxyNames: readonly string[] = [],
): EditionGalaxyBlock[] {
  return (content.galaxies ?? [])
    .filter((block) => block.findings.length > 0)
    .map((block, index) => ({ block, index }))
    .sort(
      (a, b) =>
        galaxyRank(a.block.galaxy, knownGalaxyNames) -
          galaxyRank(b.block.galaxy, knownGalaxyNames) || a.index - b.index,
    )
    .map(({ block }) => block);
}

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

export function editionFindingCount(content: EditionDTO["content"]): number {
  return (content.galaxies ?? []).reduce((sum, block) => sum + block.findings.length, 0);
}

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

function parseContent(contentJson: string): EditionDTO["content"] {
  try {
    const parsed = JSON.parse(contentJson) as unknown;

    if (parsed && typeof parsed === "object") {
      return parsed as EditionDTO["content"];
    }
  } catch {}

  return {};
}

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
