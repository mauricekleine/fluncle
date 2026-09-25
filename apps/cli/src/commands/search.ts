import { type SearchEntity, type SearchHit } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { webBaseUrl } from "../links";
import { printJson } from "../output";

const COORD_FALLBACK = "—";

type SearchArchiveResponse = {
  entities: SearchEntity[];
  ok: true;
  redirect?: string;
  results: SearchHit[];
};

function entityLine(entity: SearchEntity): string {
  const kind = `${entity.kind[0]?.toUpperCase() ?? ""}${entity.kind.slice(1)}`;
  const path = entity.url ?? `/${entity.kind}/${entity.slug}`;

  return `${kind}  ${entity.name}  ${webBaseUrl}${path}`;
}

function trackTable(hits: SearchHit[]): string {
  const coordWidth = hits.reduce((width, hit) => {
    return Math.max(width, (hit.logId ?? COORD_FALLBACK).length);
  }, 0);

  return hits
    .map((hit) => {
      const coordinate = (hit.logId ?? COORD_FALLBACK).padEnd(coordWidth);

      return `${coordinate}  ${hit.artists.join(", ")} — ${hit.title}`;
    })
    .join("\n");
}

export async function searchCommand({
  json,
  limit,
  query,
}: {
  json: boolean;
  limit: number | undefined;
  query: string;
}): Promise<void> {
  const params = new URLSearchParams({ q: query });

  if (limit !== undefined) {
    params.set("limit", String(limit));
  }

  const response = await publicApiGet<SearchArchiveResponse>(
    `/api/v1/search/archive?${params.toString()}`,
  );

  if (json) {
    printJson(response);
    return;
  }

  const blocks: string[] = [];

  if (response.redirect) {
    blocks.push(`Jump to ${webBaseUrl}${response.redirect}`);
  }

  if (response.entities.length > 0) {
    blocks.push(response.entities.map(entityLine).join("\n"));
  }

  if (response.results.length > 0) {
    blocks.push(trackTable(response.results));
  }

  if (blocks.length === 0) {
    console.log(`Nothing in the archive matches "${query}".`);
    return;
  }

  console.log(blocks.join("\n\n"));
}
