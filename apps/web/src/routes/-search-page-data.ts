// `/search`'s server-side resolution, lifted out of `search.tsx` — the `-findings-data.ts`
// sibling-module pattern. That file holds the long note on WHY: a route's loader lives in the
// route's critical half, so a resolver referenced there keeps its `lib/server/**` imports (and the
// `getDb` → `@libsql/client` + `drizzle-orm` chain behind them) alive in the eager browser chunk
// every page downloads before first paint. The route reaches this by a DYNAMIC import inside its
// handler and by `import type`, so the whole chain stays server-side.
//
// It calls THE EXISTING SEARCH PRIMITIVE and nothing else. `/search` is a second door onto
// `searchArchive`, never a second resolver: the four tiers, the ranking, the catalogue rule, and
// the degradation contract are all the ones `search_archive` already serves to ⌘K, the CLI, and
// MCP (docs/search.md).

import * as Sentry from "@sentry/cloudflare";
import { MIN_QUERY_LENGTH, type SearchResponse } from "@/lib/search-results";
import { logEvent } from "@/lib/server/log";
import { searchArchive } from "@/lib/server/search";

/**
 * How many rows the page asks for. Larger than the palette's default because a page has room to
 * show them and a reader who opened a whole surface came to look at more than a palette's worth;
 * bounded by the contract's own ceiling of 50.
 */
export const SEARCH_PAGE_LIMIT = 40;

/**
 * What the page renders. THREE states, not two, and the third is the point of the split: a resolver
 * that throws (a database that will not answer, a vector scan past its ceiling) is not an empty
 * result, and telling the reader "nothing out here" when the truth is "I could not look" is a lie
 * the surface should never tell. The route turns each into its own copy.
 */
export type SearchPageData =
  | { status: "blank" }
  | { response: SearchResponse; status: "answered" }
  | { status: "failed" };

/**
 * Resolve one query for the page.
 *
 * A blank or too-short query is the ZERO STATE, resolved without touching the database — the
 * examples live there, and there is nothing to look up yet.
 *
 * A coordinate or an exact entity comes back carrying `redirect`, and the page deliberately does
 * NOT follow it. The palette can, because it has no URL to preserve; a persistent surface that
 * bounced would make `/search?q=004.7.2I` un-shareable, un-reloadable, and a back-button trap (back
 * to the search page, forward to the redirect, forever). The resolved finding is returned as the
 * first ROW instead, exactly as the palette renders it, and the row itself is the link.
 */
export async function resolveSearchPageData(query: string | undefined): Promise<SearchPageData> {
  const q = (query ?? "").trim();

  if (q.length < MIN_QUERY_LENGTH) {
    return { status: "blank" };
  }

  try {
    const response = await searchArchive({ limit: SEARCH_PAGE_LIMIT, q });

    return {
      response: {
        anchor: response.anchor,
        degraded: response.degraded,
        entities: response.entities,
        filters: response.filters,
        kind: response.kind,
        redirect: response.redirect,
        results: response.results,
      },
      status: "answered",
    };
  } catch (error) {
    // CAUGHT, NOT RETHROWN — and that is the whole reason the failed state exists. A rethrow would
    // hand the page to the root `errorComponent`, which is the right answer for a broken route and
    // the wrong one here: it takes away the field the reader was typing into and the way onward.
    // So the fault is turned into copy, and the diagnostic half is captured explicitly, exactly as
    // `redactServerFnFault` does for a fault that IS rethrown (docs/error-tracking.md) — this is
    // the one and only server-side capture of it, never a duplicate.
    logEvent("error", "search.page-fault", { error, query: q });
    Sentry.captureException(error, { tags: { source: "search.page" } });

    return { status: "failed" };
  }
}
