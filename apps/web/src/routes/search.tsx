import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@fluncle/ui/components/button";
import { SearchExampleGlyph } from "@/components/search/search-glyph";
import { SearchResultsList } from "@/components/search/search-results-list";
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SEARCH_EXAMPLES,
  searchPagePath,
} from "@/lib/search-results";
import { type SearchPageSearch, parseSearchPageSearch, searchPageHead } from "@/lib/search-page";
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
// it — and the field commits by SUBMIT rather than by keystroke, deliberately: a debounced
// navigate-per-character would write a history entry per character and make the back button
// unusable, which is the very thing this surface exists to provide.
//
// The bare `/search` is indexable and carries the `SearchAction`; any `?q=` view is `noindex,
// follow` (lib/search-page.ts).

/** The resolver arrives by a DYNAMIC import inside the handler, and its types by `import type`, so
    this route module never statically references `lib/server/**` (docs/client-bundle.md, Rule 1). */
const fetchSearchPage = createServerFn({ method: "GET" })
  .validator((data: { q?: string }) => ({
    q: typeof data.q === "string" ? data.q.slice(0, MAX_QUERY_LENGTH) : undefined,
  }))
  .handler(async ({ data }): Promise<SearchPageData> => {
    const { resolveSearchPageData } = await import("./-search-page-data");

    return resolveSearchPageData(data.q);
  });

/** What the component reads: the answer, and the query it answered, so both come off one object. */
type SearchLoaderData = { data: SearchPageData; q: string | undefined };

// TanStack canonical option order (validateSearch → loaderDeps → loader → head → component); each
// step feeds the next's type inference, so the order isn't alphabetical and sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): SearchPageSearch =>
    parseSearchPageSearch(search),
  loaderDeps: ({ search }: { search: SearchPageSearch }) => ({ q: search.q }),
  loader: async ({ deps }: { deps: { q: string | undefined } }): Promise<SearchLoaderData> => ({
    data: await fetchSearchPage({ data: { q: deps.q } }),
    q: deps.q,
  }),
  head: ({ loaderData }: { loaderData?: SearchLoaderData }) => searchPageHead(loaderData?.q),
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
function SearchExamples({ label }: { label: string }): ReactNode {
  return (
    <>
      <p className="search-page-hint" id="search-page-examples-hint">
        {label}
      </p>
      <ul aria-labelledby="search-page-examples-hint" className="search-page-examples">
        {SEARCH_EXAMPLES.map((example) => (
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

/**
 * The field. A REAL `<form method="get" action="/search">`, so a reader with no JS still searches:
 * the browser's own submit builds exactly the URL this route reads. With JS, the submit handler
 * takes over and navigates client-side to the same URL, which keeps the transition fast and the
 * history stack honest — one entry per committed query, so back and forward walk the searches a
 * reader actually made rather than every character they typed.
 *
 * ── WHY THE INPUT IS UNCONTROLLED, AND KEYED ON THE COMMITTED QUERY ──────────────────────────
 * The committed query is the ONLY source of truth for what this field says, so the field is not a
 * second copy of it living in component state. It is seeded from `q` and keyed on `q`, which means
 * every way the query can change — a submit, a clicked example, a shared link, a back step — mounts
 * a fresh input already reading what the URL says, with no sync effect that could drift from it and
 * no state to reconcile. The value is read off the form at submit, so there is nothing to keep.
 *
 * The remount costs focus, which matters after a keyboard submit — so a submit sets a flag and the
 * effect below returns focus to the fresh input. A cold load never sets the flag, so arriving on a
 * shared link does not steal focus from the top of the page.
 */
function SearchField({ q }: { q: string | undefined }): ReactNode {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  // A submit remounts the keyed input (below), which would otherwise drop focus to the body — a bad
  // place to leave a reader who just pressed Enter. A cold load never sets the flag, so arriving on
  // a shared link does not steal focus from the top of the page.
  useEffect(() => {
    if (!submitted.current) {
      return;
    }

    submitted.current = false;
    inputRef.current?.focus();
  }, [q]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    // `FormData.get` widens to `File | string`, which a text input can never be; narrow rather
    // than stringify, so a `File` could never reach the URL as "[object File]".
    const raw = new FormData(event.currentTarget).get("q");
    const next = typeof raw === "string" ? raw.trim() : "";

    // A no-op guard: re-submitting the committed query would push a duplicate history entry and
    // re-run the loader for the same answer.
    if (next === (q ?? "")) {
      return;
    }

    submitted.current = true;
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
            key={q ?? ""}
            maxLength={MAX_QUERY_LENGTH}
            name="q"
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
 * Nothing came back, and the page says which KIND of nothing it is. A coordinate that names no
 * finding is a different fact from a name the archive does not hold, and collapsing the two would
 * lose the only useful thing the resolver learned. Either way there is a way onward: the whole list,
 * and the four worked examples.
 */
function SearchEmpty({ coordinate, q }: { coordinate: boolean; q: string }): ReactNode {
  return (
    <div className="search-page-state">
      <p className="log-index-empty empty-scanlines">
        {coordinate ? "No finding at that coordinate." : `Nothing out here for “${q}”.`}
      </p>
      {/* The way onward is branch-specific: "try a different name" is wrong advice for a reader who
          typed a coordinate, which is not a name and has no near-miss to try. */}
      <p className="search-page-way-back">
        {coordinate ? "Nothing logged there yet. " : "Try a different name, or "}
        <Link to="/tracks">dig through every track I hold</Link>.
      </p>
      {/* Not a boast about queries that always work: this renders straight after the reader's own
          search landed nothing, and scoring a point off them there is exactly what the Mosh Pit Rule
          takes off a surface. It keeps the ratified "Try one of these" stem and adds one word. */}
      <SearchExamples label="Try one of these instead." />
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
function SearchFailed(): ReactNode {
  const router = useRouter();

  return (
    <div className="search-page-state">
      <p className="log-index-empty empty-scanlines">
        Couldn&apos;t get an answer out of the archive just then.
      </p>
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
  const { data, q } = Route.useLoaderData();

  return <SearchAnswer data={data} q={q} />;
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
  q,
}: {
  data: SearchPageData;
  q: string | undefined;
}): ReactNode {
  const answered = data.status === "answered" ? data.response : undefined;
  const total = answered ? answered.results.length + answered.entities.length : 0;
  // What the live region says. The zero state stays silent on purpose: nothing was committed, so
  // there is no outcome to announce, and the worked examples below are the whole content.
  const outcome =
    data.status === "failed"
      ? "Search did not answer."
      : answered
        ? total > 0
          ? `${matchCount(total)} for “${q ?? ""}”.`
          : `No matches for “${q ?? ""}”.`
        : "";

  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index search-page">
        {/* Title alone. A WORKSTATION masthead carries no narrated helper line (VOICE.md §5 / the
            Three Areas Rule): the reader is here to do something, the interface carries the meaning,
            and the mechanics already print twice below — once in the placeholder and once in the
            zero state's hint. A third copy above them was clutter by definition. */}
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Search</h1>
        </header>

        <SearchField q={q} />

        {/* The outcome line, and it is a LIVE REGION that speaks in every committed state rather
            than only the ones with rows. A submit returns focus to the field (SearchField), so a
            search that finds nothing — or a fault — would otherwise announce nothing at all and
            leave a screen-reader user waiting on a page that had already answered. It doubles as
            the honest header for the list under it.

            A native `<output>`: it carries an implicit `status` role, so there is no `role`
            attribute to keep in step with it. `aria-live` is stated anyway, because `<output>`'s
            implicit politeness is not honoured uniformly across the browser/AT matrix. */}
        <output aria-live="polite" className="search-page-matchline">
          {outcome}
        </output>

        {data.status === "failed" ? <SearchFailed /> : undefined}

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
          </div>
        ) : undefined}

        {answered && total === 0 ? (
          <SearchEmpty coordinate={answered.kind === "coordinate"} q={q ?? ""} />
        ) : undefined}

        {answered && total > 0 ? <SearchResultsList response={answered} /> : undefined}

        <footer className="log-plate-footer">
          <Link to="/findings">Back to the archive</Link>
          <Link to="/tracks">All tracks</Link>
        </footer>
      </article>
    </main>
  );
}
