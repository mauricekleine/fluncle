// Pure, React-Native-free helpers for the archive search affordance, so the search
// state machine and the entity partitioning can be unit-tested in the repo's
// framework-free harness (see submit-fault.test.ts) without mounting an RN tree.
//
// Mirrors the web palette (apps/web/src/components/search/search-command.tsx): the
// same 2-char floor the server also enforces, and the same entity groups in the same
// order. The archive is one more SURFACE over the one `search_archive` op.

import { type SearchEntity } from "@fluncle/contracts/orpc";

/** The floor the server also enforces — below it there is nothing to go on yet. */
export const MIN_QUERY_LENGTH = 2;

/** Trim a raw input to the query the server actually sees. */
export function normalizeQuery(raw: string): string {
  return raw.trim();
}

/** The mutually-exclusive views the search pane resolves before it renders. */
export type SearchView = "idle" | "tooShort" | "loading" | "results" | "empty" | "error";

/**
 * The honest search-state branch. An empty field is `idle` (the pane shows its quiet
 * prompt, never an empty state), a one-character query is `tooShort` (the server has
 * nothing to go on), a settled query with rows is `results`, an in-flight first query
 * is `loading`, a settled failure is `error`, and only a settled query that genuinely
 * found nothing is `empty`. Results win over a later refetch so a background refresh
 * never nukes rows already on screen — the same rule archiveView uses for the feed.
 */
export function searchView({
  hasResults,
  isError,
  isFetching,
  query,
}: {
  hasResults: boolean;
  isError: boolean;
  isFetching: boolean;
  query: string;
}): SearchView {
  const trimmed = normalizeQuery(query);
  if (trimmed.length === 0) {
    return "idle";
  }
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return "tooShort";
  }
  if (hasResults) {
    return "results";
  }
  if (isFetching) {
    return "loading";
  }
  if (isError) {
    return "error";
  }
  return "empty";
}

/** One entity group as it renders: a heading naming the KIND, and its rows. */
export type EntityGroup = { entities: SearchEntity[]; heading: string; kind: SearchEntity["kind"] };

/**
 * The three graph nodes that HAVE a page, in the order they render — the same order
 * and the same headings the web palette uses (a name is most often a person, so
 * artists lead). A group with no entities drops out entirely. The heading is allowed
 * to name the kind because all three are named objects in Fluncle's world (the Unlit
 * Rule: only the uncertified tracks below get no heading).
 */
export function partitionEntities(entities: SearchEntity[]): EntityGroup[] {
  const order: EntityGroup[] = [
    { entities: [], heading: "Artists", kind: "artist" },
    { entities: [], heading: "Labels", kind: "label" },
    { entities: [], heading: "Albums", kind: "album" },
  ];
  for (const entity of entities) {
    const group = order.find((g) => g.kind === entity.kind);
    if (group) {
      group.entities.push(entity);
    }
  }
  return order.filter((g) => g.entities.length > 0);
}

/** The public path a jump-target entity opens on the web (the app has no such page). */
export function entityWebPath(entity: Pick<SearchEntity, "kind" | "slug">): string {
  return `/${entity.kind}/${entity.slug}`;
}
