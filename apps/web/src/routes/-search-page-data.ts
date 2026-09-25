import * as Sentry from "@sentry/cloudflare";
import { MIN_QUERY_LENGTH, type SearchResponse } from "@/lib/search-results";
import { logEvent } from "@/lib/server/log";
import { searchArchive } from "@/lib/server/search";

export const SEARCH_PAGE_LIMIT = 40;

export type SearchPageData =
  | { status: "blank" }
  | { response: SearchResponse; status: "answered" }
  | { status: "failed" };

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
    logEvent("error", "search.page-fault", { error, query: q });
    Sentry.captureException(error, { tags: { source: "search.page" } });

    return { status: "failed" };
  }
}
