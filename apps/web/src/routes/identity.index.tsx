import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { IdentityLookupForm } from "@/components/identity-lookup-form";
import { canonicalIdentityKey } from "@/lib/identity-key";
import { siteUrl } from "@/lib/fluncle-links";

type IdentitySearch = { key?: string };

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/identity/")({
  validateSearch: (search: Record<string, unknown>): IdentitySearch => {
    const key = typeof search["key"] === "string" ? search["key"].trim() : "";

    return key ? { key } : {};
  },
  loaderDeps: ({ search }) => ({ key: search.key }),
  loader: ({ deps }) => {
    if (deps.key) {
      throw redirect({ params: { key: canonicalIdentityKey(deps.key) }, to: "/identity/$key" });
    }
  },
  head: identityDoorHead,
  component: IdentityDoorPage,
});

const title = "Identity · Fluncle";

const description =
  "Look up a drum & bass recording by a Spotify or Deezer link, an ISRC, or a Log ID: the links Fluncle found, and where he looked and found nothing.";

function identityDoorHead() {
  const pageUrl = `${siteUrl}/identity`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
    ],
  };
}

function IdentityDoorPage() {
  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Identity</h1>
          <p className="log-index-intro">
            Paste a Spotify or Deezer link, or name a recording by an ISRC, a MusicBrainz id, or a
            Log ID, and Fluncle answers with every link he found for it.
          </p>
        </header>

        <IdentityLookupForm />

        <section aria-label="What a lookup answers" className="log-about-definitions">
          <p className="log-privacy-intro">
            Fluncle is just as plain about the looks that came back empty. A blank is the one answer
            he will not give.
          </p>
          <dl>
            <div className="log-about-definition">
              <dt>What you can look a recording up by</dt>
              <dd>
                A Spotify or Deezer link, pasted whole, tracking tail and all. Or a
                recording&rsquo;s ISRC, its MusicBrainz recording id, or its Log ID coordinate if
                Fluncle has certified it. One identifier can name more than one recording, so an
                answer is a list.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>The links he found</dt>
              <dd>
                Each link comes with how he came to trust it and when he last checked, so you can
                weigh it rather than take it on faith.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>The looks that came back empty</dt>
              <dd>
                Where Fluncle went looking and found nothing, he says so, with when he last looked
                and whether he will go again.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>If an answer here is wrong</dt>
              <dd>
                Email <a href="mailto:hey@fluncle.com">hey@fluncle.com</a> and Fluncle will sort it
                out.
              </dd>
            </div>
          </dl>
        </section>

        <footer className="log-plate-footer">
          <Link params={{ _splat: "identity" }} to="/docs/$">
            How this works
          </Link>
          <Link to="/tracks">All tracks</Link>
          <Link to="/">Home</Link>
        </footer>
      </article>
    </main>
  );
}
