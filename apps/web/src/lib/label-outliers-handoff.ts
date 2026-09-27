import { type LabelOutlierItem } from "@fluncle/contracts";

export function outlierTitle(item: LabelOutlierItem): string {
  return item.album?.name ?? item.tracks[0]?.title ?? item.unitId;
}

export function outlierArtists(item: LabelOutlierItem): { name: string; slug: string }[] {
  const bySlug = new Map<string, { name: string; slug: string }>();

  for (const track of item.tracks) {
    for (const artist of track.artists) {
      bySlug.set(artist.slug, artist);
    }
  }

  return [...bySlug.values()];
}

function oneLine(value: string): string {
  return value.replaceAll("#", "").replaceAll(/\s+/g, " ").trim();
}

export function purgeHandoff(items: readonly LabelOutlierItem[], today: string): string {
  const albums = items.filter((item) => item.album !== null);
  const singles = items.filter((item) => item.album === null);
  const lines = [
    `# label outliers ${today}: ${albums.length} albums for purge-albums.ts --albums-file`,
    ...albums.map((item) => {
      const where = item.label ? ` on ${oneLine(item.label.name)}` : "";

      return `${item.album?.id ?? ""}  # ${oneLine(outlierTitle(item))}${where} (z ${item.z.toFixed(1)})`;
    }),
  ];

  if (singles.length > 0) {
    lines.push(
      `# ${singles.length} singles with no album: purge-artists.ts --artists or an artist rule`,
      ...singles.map((item) => {
        const slugs = outlierArtists(item)
          .map((artist) => artist.slug)
          .join("|");

        return `# ${item.tracks[0]?.trackId ?? item.unitId} ${oneLine(outlierTitle(item))}: ${slugs || "no credited artist"}`;
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}
