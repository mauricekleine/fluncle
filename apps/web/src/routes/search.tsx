import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import { SearchExampleGlyph } from "@/components/search/search-glyph";
import { anchorCredit, SearchResultsList } from "@/components/search/search-results-list";
import { StyleChips } from "@/components/search/style-chips";
import { classifySearchQueryKind, emitDiscoveryEvent } from "@/lib/discovery-events";
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SEARCH_EXAMPLES,
  searchPagePath,
} from "@/lib/search-results";
import { type SearchPageSearch, parseSearchPageSearch, searchPageHead } from "@/lib/search-page";
import {
  parseStyleQuery,
  STYLE_CHIPS_LINE,
  styleBySlug,
  styleMentionedIn,
  styleTracksPath,
} from "@/lib/search-styles";
import { type SearchPageData } from "./-search-page-data";

const fetchSearchPage = createServerFn({ method: "GET" })
  .validator((data: { like?: string; live?: boolean; q?: string }) => {
    const { like, q } = parseSearchPageSearch({ like: data.like, q: data.q });

    return { like, live: data.live === true, q };
  })
  .handler(async ({ data }): Promise<SearchPageData> => {
    const [{ resolveSearchPageData }, { getRequest }] = await Promise.all([
      import("./-search-page-data"),
      import("@tanstack/react-start/server"),
    ]);

    return resolveSearchPageData(data.q, {
      like: data.like,
      live: data.live,
      request: getRequest(),
    });
  });

declare module "@tanstack/history" {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface HistoryState {
    searchLive?: boolean;
  }
}

type SearchLoaderData = { data: SearchPageData; like: string | undefined; q: string | undefined };

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): SearchPageSearch =>
    parseSearchPageSearch(search),
  loaderDeps: ({ search }: { search: SearchPageSearch }) => ({ like: search.like, q: search.q }),
  loader: async ({ deps, location }): Promise<SearchLoaderData> => ({
    data: await fetchSearchPage({
      data: { like: deps.like, live: location.state.searchLive === true, q: deps.q },
    }),
    like: deps.like,
    q: deps.q,
  }),
  head: ({ loaderData }: { loaderData?: SearchLoaderData }) =>
    searchPageHead(
      loaderData?.q,
      loaderData?.like === undefined
        ? undefined
        : {
            credit:
              loaderData.data.status === "answered" && loaderData.data.response.anchor
                ? anchorCredit(loaderData.data.response.anchor)
                : undefined,
          },
    ),
  component: SearchPage,
});

const matchFormatter = new Intl.NumberFormat("en-US");

function matchCount(count: number): string {
  return `${matchFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

function SearchExamples({ exclude, label }: { exclude?: string; label: string }): ReactNode {
  return (
    <>
      <p className="search-page-hint" id="search-page-examples-hint">
        {label}
      </p>
      <ul aria-labelledby="search-page-examples-hint" className="search-page-examples">
        {SEARCH_EXAMPLES.filter(
          (example) => example.query.toLowerCase() !== (exclude ?? "").trim().toLowerCase(),
        ).map((example) => (
          <li key={example.query}>
            <Link
              className="search-example"
              preload={false}
              to={searchPagePath(example.query) as never}
            >
              <SearchExampleGlyph className="search-example-icon" icon={example.icon} />
              {example.query}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

const LIVE_SEARCH_DEBOUNCE_MS = 300;

function SearchField({
  awaitsEnter,
  q,
}: {
  awaitsEnter: boolean;
  q: string | undefined;
}): ReactNode {
  const navigate = useNavigate();
  const router = useRouter();
  const onLiveEntry = useRouterState({
    select: (state) => state.location.state.searchLive === true,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  const liveWritten = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fieldKey, setFieldKey] = useState(0);
  const seenQ = useRef(q);

  useEffect(() => {
    if (q === seenQ.current) {
      return;
    }

    seenQ.current = q;

    if (liveWritten.current !== undefined && liveWritten.current === (q ?? "")) {
      return;
    }

    liveWritten.current = undefined;
    setFieldKey((key) => key + 1);
  }, [q]);

  useEffect(() => {
    if (!submitted.current) {
      return;
    }

    submitted.current = false;
    inputRef.current?.focus();
  }, [q, fieldKey]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const href = useRouterState({ select: (state) => state.location.href });

  useEffect(() => {
    clearTimeout(timer.current);
  }, [href]);

  const onInput = (value: string): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = value.trim().slice(0, MAX_QUERY_LENGTH);

      if (next === (q ?? "")) {
        return;
      }

      liveWritten.current = next;
      void navigate({
        replace: onLiveEntry,
        resetScroll: false,
        search: { q: next.length > 0 ? next : undefined },
        state: { searchLive: true },
        to: "/search",
      });
    }, LIVE_SEARCH_DEBOUNCE_MS);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    clearTimeout(timer.current);

    const raw = new FormData(event.currentTarget).get("q");
    const next = typeof raw === "string" ? raw.trim() : "";

    if (next.length > 0) {
      emitDiscoveryEvent("discovery_search", { kind: classifySearchQueryKind(next) });
    }

    if (next === (q ?? "")) {
      if (awaitsEnter || onLiveEntry) {
        void navigate({
          replace: true,
          resetScroll: false,
          search: { q: next.length > 0 ? next : undefined },
          state: { searchLive: false },
          to: "/search",
        }).then(() => router.invalidate());
      }

      return;
    }

    submitted.current = true;
    liveWritten.current = undefined;
    void navigate({ search: { q: next.length > 0 ? next : undefined }, to: "/search" });
  };

  return (
    <search>
      <form
        action="/search"
        autoComplete="off"
        className="search-page-form"
        method="get"
        onSubmit={onSubmit}
      >
        <label className="sr-only" htmlFor="search-page-q">
          Search the archive
        </label>
        <span className="search-page-field">
          <MagnifyingGlassIcon aria-hidden="true" className="search-page-field-icon" />
          <input
            autoComplete="off"
            className="search-page-input"
            defaultValue={q ?? ""}
            id="search-page-q"
            key={fieldKey}
            maxLength={MAX_QUERY_LENGTH}
            name="q"
            onInput={(event) => onInput(event.currentTarget.value)}
            placeholder="A name, a coordinate, or the sound of it…"
            ref={inputRef}
            type="search"
          />
        </span>
        <Button className="search-page-submit" type="submit">
          Search
        </Button>
      </form>
    </search>
  );
}

function SearchEmpty({ coordinate, q }: { coordinate: boolean; q: string }): ReactNode {
  const nearest = coordinate || parseStyleQuery(q) ? undefined : styleMentionedIn(q);

  return (
    <div className="search-page-state">
      {nearest ? (
        <p className="search-page-way-back">
          Closest sound I’ve got:{" "}
          <Link className="style-chip" to={styleTracksPath(nearest.slug) as never}>
            {nearest.label}
          </Link>
        </p>
      ) : undefined}

      <p className="search-page-way-back">
        {coordinate ? "Nothing logged there yet. " : "Try a different name, or "}
        <Link to="/tracks">dig through my tracks</Link>.
      </p>
      {nearest || coordinate ? undefined : (
        <StyleChips
          className="search-style-chips"
          label={STYLE_CHIPS_LINE}
          labelId="search-page-empty-styles"
        />
      )}

      <SearchExamples exclude={q} label="Try one of these instead." />
    </div>
  );
}

function SearchFailed({ said = false }: { said?: boolean }): ReactNode {
  const router = useRouter();

  return (
    <div className="search-page-state">
      {said ? undefined : (
        <p className="log-index-empty empty-scanlines">
          Couldn&apos;t get an answer out of the archive just then.
        </p>
      )}
      <p className="search-page-way-back">
        <button
          className="search-page-retry"
          onClick={() => void router.invalidate()}
          type="button"
        >
          Try that search again
        </button>
        , or <Link to="/tracks">dig through my tracks</Link>.
      </p>
    </div>
  );
}

function SearchPage(): ReactNode {
  const { data, like, q } = Route.useLoaderData();

  return <SearchAnswer data={data} like={like} q={q} />;
}

function searchOutcome(
  data: SearchPageData,
  q: string | undefined,
  like: string | undefined,
): string {
  if (data.status === "failed") {
    return "Search did not answer.";
  }

  if (data.status === "limited") {
    return "That’s a lot of searching from one place in one go. Give it a minute, then try again.";
  }

  if (data.status !== "answered") {
    return "";
  }

  if (data.awaitsEnter) {
    const count = data.response.results.length + data.response.entities.length;

    return count > 0
      ? `${matchCount(count)} for “${q ?? ""}”. Press Enter to read it as a sentence.`
      : `Press Enter to search for “${q ?? ""}”.`;
  }

  const { response } = data;
  const total = response.results.length + response.entities.length;

  if (like !== undefined) {
    if (!response.anchor) {
      return "No track at that link.";
    }

    const credit = anchorCredit(response.anchor);

    if (total > 0) {
      return `${matchFormatter.format(total)} ${total === 1 ? "track" : "tracks"} close to ${credit}.`;
    }

    return response.degraded
      ? `Couldn’t line up tracks like ${credit} just then.`
      : `I haven’t got a read on how ${credit} sounds yet.`;
  }

  const style = styleBySlug(response.filters?.sound);

  if (style && response.results.length > 0) {
    const count = response.results.length;

    return `${matchFormatter.format(count)} ${count === 1 ? "track" : "tracks"} closest to ${style.label}.`;
  }

  if (total > 0) {
    return `${matchCount(total)} for “${q ?? ""}”.`;
  }

  if (response.kind === "coordinate") {
    return "No finding at that coordinate.";
  }

  return response.degraded
    ? `Reading by name only right now, and nothing came up for “${q ?? ""}”.`
    : `Nothing out here for “${q ?? ""}”.`;
}

export function SearchAnswer({
  data,
  like,
  q,
}: {
  data: SearchPageData;
  like?: string;
  q: string | undefined;
}): ReactNode {
  const answered = data.status === "answered" ? data.response : undefined;
  const total = answered ? answered.results.length + answered.entities.length : 0;

  const outcome = searchOutcome(data, q, like);

  const missed =
    answered !== undefined &&
    total === 0 &&
    like === undefined &&
    !(data.status === "answered" && data.awaitsEnter === true);

  const routerPending = useRouterState({ select: (state) => state.status === "pending" });
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const pending = mounted && routerPending;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index search-page">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">
            {like === undefined ? "Search" : "Similar tracks"}
          </h1>
        </header>

        <SearchField awaitsEnter={data.status === "answered" && data.awaitsEnter === true} q={q} />

        <output
          aria-busy={pending || undefined}
          aria-live="polite"
          className={
            missed
              ? "search-page-matchline log-index-empty empty-scanlines"
              : "search-page-matchline"
          }
        >
          {outcome}
        </output>

        {data.status === "failed" ? <SearchFailed /> : undefined}

        {data.status === "limited" ? (
          <div className="search-page-state">
            <p className="search-page-way-back">
              Till then, <Link to="/tracks">dig through my tracks</Link>.
            </p>
          </div>
        ) : undefined}

        {like !== undefined && answered?.degraded && total === 0 ? (
          <SearchFailed said />
        ) : undefined}

        {data.status === "blank" ? (
          <div className="search-page-state">
            <SearchExamples
              label={
                (q ?? "").length > 0
                  ? `Give me at least ${MIN_QUERY_LENGTH} characters to go on. Try one of these.`
                  : "Give me a name, a coordinate, or the sound of a track. Try one of these."
              }
            />
            <StyleChips
              className="search-style-chips"
              label={STYLE_CHIPS_LINE}
              labelId="search-page-styles"
            />
          </div>
        ) : undefined}

        {missed ? (
          <SearchEmpty coordinate={answered.kind === "coordinate"} q={q ?? ""} />
        ) : undefined}

        {answered && total > 0 ? (
          <SearchResultsList response={answered} sonicView={like !== undefined} />
        ) : undefined}

        <footer className="log-plate-footer">
          <Link to="/findings">Back to the archive</Link>
          <Link to="/tracks">All tracks</Link>
        </footer>
      </article>
    </main>
  );
}
