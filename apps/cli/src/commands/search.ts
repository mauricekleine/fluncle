// The `search` CLI command — a thin `publicApiGet` read over the public
// `search_archive` op (`GET /api/v1/search/archive`), Fluncle's four-tier
// archive search (coordinate → exact entity → full-text → a small LLM that emits
// filters). Catalogue reference register (plain, no cosmos): a resolved jump
// first, then entity hits with their page links, then the track table.
//
// The track table follows `fresh`'s convention: a certified finding LEADS with
// its Log ID coordinate, and an uncertified track prints the `—` fallback in the
// coordinate column (the Unlit Rule — presence or absence of the coordinate IS
// the distinction; the uncertified tier is never named or labelled).
//
import { type SearchEntity, type SearchHit } from "@fluncle/contracts";
import { publicApiGet } from "../api";
import { webBaseUrl } from "../links";
import { printJson } from "../output";

// The absence marker for the coordinate column when a hit has no Log ID — the
// same `—` `fresh` uses (the Unlit Rule), keeping the column aligned. Distinct
// from the one sanctioned `Artist — Title` separator below.
const COORD_FALLBACK = "—";

// The slice of the `search_archive` envelope this command reads.
type SearchArchiveResponse = {
  entities: SearchEntity[];
  ok: true;
  redirect?: string;
  results: SearchHit[];
};

// `Artist  Name  https://…/artist/<slug>` — a jump target with its page link.
// `kind` titles the line; the link is the row's own `url` when it carries one (a galaxy's
// plural segment, a mixtape's log page), else the `/<kind>/<slug>` default.
function entityLine(entity: SearchEntity): string {
  const kind = `${entity.kind[0]?.toUpperCase() ?? ""}${entity.kind.slice(1)}`;
  const path = entity.url ?? `/${entity.kind}/${entity.slug}`;

  return `${kind}  ${entity.name}  ${webBaseUrl}${path}`;
}

// The track table, padded on the coordinate column like `fresh`:
//   241.7.3A  Artist, Artist — Title      (certified: leads with the coordinate)
//   —         Artist — Title              (uncertified: no coordinate)
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

  // A coordinate or an exact entity resolves straight to a page — a jump, not a list.
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
