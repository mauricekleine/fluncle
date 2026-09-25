import * as Sentry from "@sentry/cloudflare";
import { MIN_QUERY_LENGTH, type SearchResponse } from "@/lib/search-results";
import { logEvent } from "@/lib/server/log";
import { searchArchive, searchLikeTrack } from "@/lib/server/search";

export const SEARCH_PAGE_LIMIT = 40;

export type SearchPageData =
  | { status: "blank" }
  | {
      awaitsEnter?: boolean;
      response: SearchResponse;
      status: "answered";
    }
  | { status: "failed" };

function pageResponse(response: SearchResponse): SearchResponse {
  return {
    anchor: response.anchor,
    degraded: response.degraded,
    entities: response.entities,
    filters: response.filters,
    kind: response.kind,
    redirect: response.redirect,
    results: response.results,
  };
}

export async function resolveSearchPageData(
  query: string | undefined,
  options: {
    like?: string;
    live?: boolean;
  } = {},
): Promise<SearchPageData> {
  const q = (query ?? "").trim();

  try {
    if (options.like !== undefined) {
      const liked = await searchLikeTrack({ limit: SEARCH_PAGE_LIMIT, trackId: options.like });

      return {
        response: pageResponse(
          liked ?? { degraded: false, entities: [], kind: "sonic", results: [] },
        ),
        status: "answered",
      };
    }

    if (q.length < MIN_QUERY_LENGTH) {
      return { status: "blank" };
    }

    const response = await searchArchive({ deferModel: options.live, limit: SEARCH_PAGE_LIMIT, q });

    return {
      ...(response.modelDeferred ? { awaitsEnter: true } : {}),
      response: pageResponse(response),
      status: "answered",
    };
  } catch (error) {
    logEvent("error", "search.page-fault", { error, query: q });
    Sentry.captureException(error, { tags: { source: "search.page" } });

    return { status: "failed" };
  }
}
