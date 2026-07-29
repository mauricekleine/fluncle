import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { IdentityRecordingBlock } from "@/components/identity-states";
import { IdentityLookupForm } from "@/components/identity-lookup-form";
import { canonicalIdentityKey } from "@/lib/identity-key";
import { siteUrl } from "@/lib/fluncle-links";
import { type IdentityPageData } from "./-identity-page-data";

// ── /identity/<key> — one recording's identifiers and links, and the honest negative ─────────
//
// The answer page. A reader (or a crawler, or an agent) arrives with an ISRC, a MusicBrainz
// recording id, or a Log ID, and leaves knowing four things Fluncle can say and most link
// resolvers cannot: which links he holds and how he came to trust them, where he looked and found
// nothing, where he will not look and why, and where he serves no link at all. The machine twin of
// this page is `get_track`'s identity projection; both read the same envelope module, so the page
// and the API can never answer differently.
//
// A CATALOGUE PAGE (VOICE.md §5, the Three Areas): reference register throughout — it states what
// the thing is, plainly, with Fluncle in the third person as the one who did the looking. No
// nameplate, no first-person intro.
//
// ── WHY IT IS `noindex, follow` ───────────────────────────────────────────────────────────────
// The page is deliberately crawlable and citable, and deliberately out of the search index. One
// recording is reachable under up to three identifiers, so indexing them would put three near-
// identical URLs in front of one answer, times the tens of thousands of recordings the archive
// holds — the scaled-thin shape `docs/album-entity.md`'s thin-content gate exists to keep off this
// site. `follow` keeps the crawl path and the link equity intact, an agent fetching a URL directly
// is unaffected, and the DOOR at `/identity` is the indexable, sitemapped page that stands for the
// surface.
//
// ── AN UNKNOWN KEY IS A 200, NOT A 404 ────────────────────────────────────────────────────────
// Unlike `/artist/<slug>`, where an unknown slug means the page does not exist, an unknown
// identifier here is a real question with a real answer: Fluncle holds nothing under it. Saying so
// at 200 is the honest negative this whole surface is built to say out loud; a 404 would claim the
// question was never asked. Nothing is invited from that state — no submission affordance, on the
// same reasoning the op carries (a wrong guess must never seed the crew's triage queue).

// The resolver arrives by a DYNAMIC import inside the handler, and its types by `import type`, so
// this route module never statically references `lib/server/**` — see `-identity-page-data.ts`.
const fetchIdentity = createServerFn({ method: "GET" })
  .validator((data: { key: string }) => data)
  .handler(async ({ data: { key } }): Promise<IdentityPageData> => {
    const { resolveIdentityPageData } = await import("./-identity-page-data");

    return resolveIdentityPageData(key);
  });

/**
 * The head normalizes the key itself, through the client-safe `lib/identity-key.ts` — nothing in
 * the route's critical half may touch the resolver module, which would drag the database chain into
 * the eager client chunk (docs/client-bundle.md rule 1). So a reader who typed `gb-abc-12-34567`
 * gets a canonical pointing at `GBABC1234567`, and one recording collects one address.
 */
function identityHead(rawKey: string) {
  const key = canonicalIdentityKey(rawKey);
  const pageUrl = `${siteUrl}/identity/${encodeURIComponent(key)}`;
  const title = `${key} · Identity · Fluncle`;
  // Machine-facing, so honestly-plain third person (VOICE.md's Narrator rule).
  const description = `What Fluncle holds for ${key}: the recording's identifiers, the links he has, and where a look came back empty.`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      // See the `noindex, follow` note in the file header.
      { content: "noindex, follow", name: "robots" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
    ],
  };
}

// Route options follow TanStack's create-route-property-order (each step feeds the next's
// inferred types), which isn't alphabetical — so sort-keys is off here.
// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/identity/$key")({
  loader: async ({ params }): Promise<IdentityPageData> => fetchIdentity({ data: params }),
  head: ({ params }: { params: { key: string } }) => identityHead(params.key),
  component: IdentityKeyRoute,
});

function IdentityKeyRoute() {
  return <IdentityAnswer data={Route.useLoaderData()} />;
}

/**
 * The page body, exported so the suite can render it against fixtures. The three states are all
 * pages rather than errors: an answer, an honest nothing, and a caller who has spent the allowance.
 */
export function IdentityAnswer({ data }: { data: IdentityPageData }) {
  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate identity-key">
            {data.status === "limited" ? "Identity" : data.key}
          </h1>
          <p className="log-index-intro">{introLine(data)}</p>
        </header>

        {data.status === "found"
          ? data.envelope.recordings.map((recording) => (
              <IdentityRecordingBlock key={recording.trackId} recording={recording} />
            ))
          : undefined}

        {data.status === "limited" ? undefined : (
          <section aria-label="Look up another recording" className="identity-again">
            <IdentityLookupForm submitLabel="Look up" />
          </section>
        )}

        <footer className="log-plate-footer">
          <Link to="/identity">Identity</Link>
          <Link params={{ _splat: "identity" }} to="/docs/$">
            How this works
          </Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}

/** The one factual line under the key: what came back, in plain words. */
function introLine(data: IdentityPageData): string {
  if (data.status === "limited") {
    return "That is a lot of lookups from one place in one go. Give it a minute and ask again.";
  }

  if (data.status === "missing") {
    return "Fluncle holds no recording under this identifier.";
  }

  const count = data.envelope.recordings.length;

  if (count === 1) {
    return "One recording in the archive carries this identifier.";
  }

  // Ambiguity belongs to the ANSWER, not to any one block in it, so it is said here once rather
  // than repeated over every recording below.
  const unruled = data.envelope.recordings.some((recording) => recording.relation === "ambiguous");

  return unruled
    ? `${count} recordings in the archive carry this identifier, and Fluncle has not ruled between them.`
    : `${count} recordings in the archive carry this identifier.`;
}
