import * as Sentry from "@sentry/cloudflare";
import { MIN_QUERY_LENGTH, type SearchResponse } from "@/lib/search-results";
import { logEvent } from "@/lib/server/log";
import { searchArchiveRateLimit, SEARCH_WINDOW_MS } from "@/lib/server/orpc/search";
import { chargeRateLimit } from "@/lib/server/rate-limit";
import { searchArchive, searchLikeTrack } from "@/lib/server/search";
import { ApiError } from "@/lib/server/spotify";

export const SEARCH_PAGE_LIMIT = 40;

export type SearchPageData =
  | { status: "blank" }
  | {
      awaitsEnter?: boolean;
      response: SearchResponse;
      status: "answered";
    }
  | { status: "failed" }
  | { status: "limited" };

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
    request?: Request;
  } = {},
): Promise<SearchPageData> {
  const q = (query ?? "").trim();

  if (options.like === undefined && q.length < MIN_QUERY_LENGTH) {
    return { status: "blank" };
  }

  try {
    const charge = options.request
      ? await chargeRateLimit({
          action: "search_archive",
          limit: await searchArchiveRateLimit(),
          request: options.request,
          windowMs: SEARCH_WINDOW_MS,
        })
      : undefined;

    if (options.like !== undefined) {
      const liked = await searchLikeTrack({ limit: SEARCH_PAGE_LIMIT, trackId: options.like });

      charge?.throwIfLimited();

      return {
        response: pageResponse(
          liked ?? { degraded: false, entities: [], kind: "sonic", results: [] },
        ),
        status: "answered",
      };
    }

    const response = await searchArchive({
      beforeModel: charge?.requireAllowed,
      deferModel: options.live,
      limit: SEARCH_PAGE_LIMIT,
      q,
    });

    charge?.throwIfLimited();

    return {
      ...(response.modelDeferred ? { awaitsEnter: true } : {}),
      response: pageResponse(response),
      status: "answered",
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      return { status: "limited" };
    }
    logEvent("error", "search.page-fault", { error, query: q });
    Sentry.captureException(error, { tags: { source: "search.page" } });

    return { status: "failed" };
  }
}
