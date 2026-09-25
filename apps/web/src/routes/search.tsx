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

// `/search` — THE PERSISTENT SEARCH SURFACE.
//
// Fluncle's search was a ⌘K palette and nothing else, which made it the fastest way to reach one
// known thing and the only surface in the app you could not link to. A palette has no URL, so a
// result set could not be shared, could not survive a reload, and could not be walked back to. This
// page is the other half: the WHOLE query state lives in `?q=`, the answer is server-rendered from
// that URL, and the palette hands off to it rather than being replaced by it.
//
// One param carries everything because the resolver takes one string: a coordinate, a name, a
// sentence, and a sonic reference all arrive as `q` and are told apart by the tiers (docs/search.md).
// So every one of the four query kinds is shareable and reload-safe by construction, and no caller
// has to know which tier will answer.
//
// A WORKSTATION in the Three Areas sense (VOICE.md §5), not a catalogue shelf: there is no fixed
// enumeration here and every `?q=` view is `noindex`, so it carries no catalogue weight — the reader
// does something and the interface carries the meaning. That decides the register. The masthead is
// the title alone (no nameplate, no narrated helper line), the chrome is literal, and the voice
// lives where a Workstation permits it: the one line a STATE needs — the zero state, the empty
// state, the fault. Those lines reuse the palette's and the front door's phrasings verbatim,
// because one action takes one wording and a new phrase for an existing action is a bug.
//
// A public route, so it is loader + `useLoaderData` and no react-query (AGENTS.md). Nothing about
// this page is live — a result set is a snapshot of an archive that does not change while you read
// it. The field answers AS YOU TYPE for the deterministic tiers (a name, a coordinate, a style word,
// a title): a settled keystroke REPLACES `?q=` rather than pushing it, so the back button still
// walks the searches a reader committed, not every character. A sentence that would need the model
// tier waits for Enter, so typing never spends a model call per pause (docs/search.md).
//
// The bare `/search` is indexable and carries the `SearchAction`; any `?q=` view is `noindex,
// follow` (lib/search-page.ts).

/** The resolver arrives by a DYNAMIC import inside the handler, and its types by `import type`, so
    this route module never statically references `lib/server/**` (docs/client-bundle.md, Rule 1). */
const fetchSearchPage = createServerFn({ method: "GET" })
  .validator((data: { like?: string; live?: boolean; q?: string }) => {
    const { like, q } = parseSearchPageSearch({ like: data.like, q: data.q });

    return { like, live: data.live === true, q };
  })
  .handler(async ({ data }): Promise<SearchPageData> => {
    const { resolveSearchPageData } = await import("./-search-page-data");

    return resolveSearchPageData(data.q, { like: data.like, live: data.live });
  });

// A settled keystroke marks its history entry live, so the loader knows the query was typed and not
// committed. The flag rides history STATE, never the URL: a shared or reloaded link is always a
// committed search.
declare module "@tanstack/history" {
  // Module augmentation merges only through an interface.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface HistoryState {
    searchLive?: boolean;
  }
}

/** What the component reads: the answer, and the query it answered, so both come off one object. */
type SearchLoaderData = { data: SearchPageData; like: string | undefined; q: string | undefined };

// TanStack canonical option order (validateSearch → loaderDeps → loader → head → component); each
// step feeds the next's type inference, so the order isn't alphabetical and sort-keys is off here.
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

/** "1 match" / "312 matches" — the count of destinations this query brought back. */
function matchCount(count: number): string {
  return `${matchFormatter.format(count)} ${count === 1 ? "match" : "matches"}`;
}

/**
 * The four worked example queries, as real links to the surface they answer on.
 *
 * They are ANCHORS, not buttons that fill a field: each one IS a destination, so it can be opened
 * in a new tab, shared out of the page, and followed by a crawler with no JS — which is the whole
 * argument for this surface, applied to its own front step. `SEARCH_EXAMPLES` has one owner
 * (lib/search-results.ts) and each query returns rows against the live archive, because an example
 * that finds nothing teaches the opposite of what it is for.
 */
function SearchExamples({ exclude, label }: { exclude?: string; label: string }): ReactNode {
  return (
    <>
      <p className="search-page-hint" id="search-page-examples-hint">
        {label}
      </p>
      <ul aria-labelledby="search-page-examples-hint" className="search-page-examples">
        {/* Never the query that just came back empty: offering it again is a loop, not a way on. */}
        {SEARCH_EXAMPLES.filter(
          (example) => example.query.toLowerCase() !== (exclude ?? "").trim().toLowerCase(),
        ).map((example) => (
          <li key={example.query}>
            <Link className="search-example" to={searchPagePath(example.query) as never}>
              <SearchExampleGlyph className="search-example-icon" icon={example.icon} />
              {example.query}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** How long a keystroke has to settle before the field asks the archive. */
const LIVE_SEARCH_DEBOUNCE_MS = 300;

/**
 * The field. A REAL `<form method="get" action="/search">`, so a reader with no JS still searches:
 * the browser's own submit builds exactly the URL this route reads.
 *
 * ── LIVE AS YOU TYPE, AND HONEST ABOUT THE HISTORY ──────────────────────────────────────────────
 * A settled keystroke (debounced) navigates with `replace`, so `?q=` always says what the field
 * says and a reload or a shared link holds the live answer, while the back button still walks the
 * searches a reader committed rather than every character they typed: the first live keystroke after
 * a committed search pushes one entry, and every keystroke after it replaces that entry, so the
 * committed search stays one Back away. The entry is marked live in history state; the loader then
 * answers a sentence by its words and leaves the language tier for Enter. Enter is a push.
 *
 * ── WHY THE INPUT IS UNCONTROLLED, AND WHEN IT REMOUNTS ─────────────────────────────────────────
 * The URL is the one source of truth for what the field says, so the input is seeded from `q` and
 * remounted when `q` changes from OUTSIDE the field — a clicked example, a shared link, a back step
 * — with no sync effect that could drift. A `q` the field itself just wrote live is not a reason to
 * remount: that would drop the caret mid-word. A submit returns focus to the fresh input; a cold
 * load never steals focus from the top of the page.
 */
function SearchField({
  awaitsEnter,
  q,
}: {
  /** The current answer is a sentence typed live, waiting for Enter to be read as one. */
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

  // A `q` the field did not write itself is an outside change: remount the input to read it.
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

  // A submit remounts nothing when the query is unchanged, but a changed one does; either way the
  // reader who just pressed Enter keeps the field.
  useEffect(() => {
    if (!submitted.current) {
      return;
    }

    submitted.current = false;
    inputRef.current?.focus();
  }, [q, fieldKey]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onInput = (value: string): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = value.trim().slice(0, MAX_QUERY_LENGTH);

      if (next === (q ?? "")) {
        return;
      }

      liveWritten.current = next;
      void navigate({
        // One entry per typing burst: push off a committed search, then keep replacing it.
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

    // `FormData.get` widens to `File | string`, which a text input can never be; narrow rather
    // than stringify, so a `File` could never reach the URL as "[object File]".
    const raw = new FormData(event.currentTarget).get("q");
    const next = typeof raw === "string" ? raw.trim() : "";

    if (next.length > 0) {
      emitDiscoveryEvent("discovery_search", { kind: classifySearchQueryKind(next) });
    }

    if (next === (q ?? "")) {
      // The URL already says this. A live answer is asked again in full (the sentence gets its
      // language tier); anything else would push a duplicate entry for the same answer.
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
      {/* `autoComplete="off"` on the FORM as well as the input: on the input it suppresses autofill,
          on the form it is the HTML signal that the document does not want the user agent to
          remember a control's value across a history traversal — the right statement for a search
          box, whose value belongs to the URL. */}
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

/**
 * Nothing came back, and the page still hands you music. The "nothing" itself is said ONCE, by the
 * live matchline above (the one line a screen reader hears and the one line a reader sees); this
 * block is only the way onward. A coordinate that names no finding is a different fact from a name
 * the archive does not hold, so the onward advice branches. A query that MENTIONED a style ("chilled
 * liquid 174") is offered that sound directly; any other miss gets the whole chip row, and the worked
 * examples stay below.
 */
function SearchEmpty({ coordinate, q }: { coordinate: boolean; q: string }): ReactNode {
  // A style word that found nothing is a style that could not rank: offering it back as the
  // nearest sound would point at the same empty room.
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
      {/* The way onward is branch-specific: "try a different name" is wrong advice for a reader who
          typed a coordinate, which is not a name and has no near-miss to try. */}
      <p className="search-page-way-back">
        {coordinate ? "Nothing logged there yet. " : "Try a different name, or "}
        <Link to="/tracks">dig through every track I hold</Link>.
      </p>
      {nearest || coordinate ? undefined : (
        <StyleChips
          className="search-style-chips"
          label={STYLE_CHIPS_LINE}
          labelId="search-page-empty-styles"
        />
      )}
      {/* Not a boast about queries that always work: this renders straight after the reader's own
          search landed nothing, and scoring a point off them there is exactly what the Mosh Pit Rule
          takes off a surface. It keeps the ratified "Try one of these" stem and adds one word. */}
      <SearchExamples exclude={q} label="Try one of these instead." />
    </div>
  );
}

/**
 * The resolver could not answer — a database that would not respond, a scan past its ceiling. Named
 * as what it is rather than dressed up as an empty result, because "nothing out here" would be a lie
 * about an archive nobody managed to look inside.
 *
 * "Try again" re-runs the loader for the SAME URL (`router.invalidate`), which is what a reader means
 * by it; a `Link` to the current URL would navigate nowhere and refetch nothing.
 */
function SearchFailed({ said = false }: { said?: boolean }): ReactNode {
  const router = useRouter();

  return (
    <div className="search-page-state">
      {/* When the matchline has already said what failed, this block is only the way onward. */}
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
        , or <Link to="/tracks">dig through every track I hold</Link>.
      </p>
    </div>
  );
}

function SearchPage(): ReactNode {
  const { data, like, q } = Route.useLoaderData();

  return <SearchAnswer data={data} like={like} q={q} />;
}

/** What the live matchline says: the one place an outcome is reported, in every committed state. */
function searchOutcome(
  data: SearchPageData,
  q: string | undefined,
  like: string | undefined,
): string {
  if (data.status === "failed") {
    return "Search did not answer.";
  }

  if (data.status !== "answered") {
    return "";
  }

  // A sentence typed live: its words answer now, and Enter reads it as a sentence.
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

  // A style orders the archive rather than matching it, so its count names tracks and the order.
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

  // The language tier was wanted and could not run: an empty word match is not "nothing out here".
  return response.degraded
    ? `Reading by name only right now, and nothing came up for “${q ?? ""}”.`
    : `Nothing out here for “${q ?? ""}”.`;
}

/**
 * The whole surface, as a function of the loader's answer and the query that produced it.
 *
 * Split out of the route component (the `IdentityAnswer` precedent) so every state — zero, answered,
 * empty, coordinate-miss, failed — is renderable in a test through a memory router, against the real
 * server HTML rather than a claim about it. The route component is then the one-line adapter that
 * hands it `useLoaderData`.
 */
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
  // What the live region says. The zero state stays silent on purpose: nothing was committed, so
  // there is no outcome to announce, and the worked examples below are the whole content.
  const outcome = searchOutcome(data, q, like);
  // A miss is reported ONCE: the matchline carries the "nothing" at the empty state's weight, and
  // the block under it only offers the way onward.
  const missed =
    answered !== undefined &&
    total === 0 &&
    like === undefined &&
    !(data.status === "answered" && data.awaitsEnter === true);
  // A live answer is on its way: the results say so while the next one loads. Only after mount:
  // the server renders a settled page, so the first paint must agree with it.
  const routerPending = useRouterState({ select: (state) => state.status === "pending" });
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const pending = mounted && routerPending;

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index search-page">
        {/* Title alone. A WORKSTATION masthead carries no narrated helper line (VOICE.md §5 / the
            Three Areas Rule): the reader is here to do something, the interface carries the meaning,
            and the mechanics already print twice below — once in the placeholder and once in the
            zero state's hint. A third copy above them was clutter by definition. */}
        <header className="log-masthead">
          {/* The sonic view of one track is its own room: it is named for what it holds. */}
          <h1 className="log-coordinate log-index-title">
            {like === undefined ? "Search" : "Similar tracks"}
          </h1>
        </header>

        <SearchField awaitsEnter={data.status === "answered" && data.awaitsEnter === true} q={q} />

        {/* The outcome line, and it is a LIVE REGION that speaks in every committed state rather
            than only the ones with rows. A submit returns focus to the field (SearchField), so a
            search that finds nothing — or a fault — would otherwise announce nothing at all and
            leave a screen-reader user waiting on a page that had already answered. It doubles as
            the honest header for the list under it.

            A native `<output>`: it carries an implicit `status` role, so there is no `role`
            attribute to keep in step with it. `aria-live` is stated anyway, because `<output>`'s
            implicit politeness is not honoured uniformly across the browser/AT matrix. */}
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

        {/* The sonic view's engine was resting: the same retry the fault state offers. */}
        {like !== undefined && answered?.degraded && total === 0 ? (
          <SearchFailed said />
        ) : undefined}

        {data.status === "blank" ? (
          <div className="search-page-state">
            <SearchExamples
              // The front door's hint, VERBATIM (components/front-door/search-entry.tsx) — one
              // phrasing across the three surfaces that show these four, rather than a fourth
              // variant. "Nothing typed yet" told the reader something they could already see.
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
