import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { IdentityRecordingBlock } from "@/components/identity-states";
import { IdentityLookupForm } from "@/components/identity-lookup-form";
import { canonicalIdentityKey } from "@/lib/identity-key";
import { siteUrl } from "@/lib/fluncle-links";
import { type IdentityPageData } from "./-identity-page-data";

const fetchIdentity = createServerFn({ method: "GET" })
  .validator((data: { key: string }) => data)
  .handler(async ({ data: { key } }): Promise<IdentityPageData> => {
    const { resolveIdentityPageData } = await import("./-identity-page-data");

    return resolveIdentityPageData(key);
  });

function identityHead(rawKey: string) {
  const key = canonicalIdentityKey(rawKey);
  const pageUrl = `${siteUrl}/identity/${encodeURIComponent(key)}`;
  const title = `${key} · Identity · Fluncle`;

  const description = `${key}: the recording's identifiers, the links Fluncle found, and where he looked and found nothing.`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },

      { content: "noindex, follow", name: "robots" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
    ],
  };
}

// oxlint-disable-next-line sort-keys
export const Route = createFileRoute("/identity/$key")({
  loader: async ({ params }): Promise<IdentityPageData> => fetchIdentity({ data: params }),
  head: ({ params }: { params: { key: string } }) => identityHead(params.key),
  component: IdentityKeyRoute,
});

function IdentityKeyRoute() {
  return <IdentityAnswer data={Route.useLoaderData()} />;
}

export function IdentityAnswer({ data }: { data: IdentityPageData }) {
  return (
    <main className="log-plate-stage">
      <article className="log-plate log-index">
        <header className="log-masthead">
          <h1 className="log-coordinate identity-key">
            {data.status === "limited" ? "Identity" : data.key}
          </h1>
          <IntroLine data={data} />
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

function IntroLine({ data }: { data: IdentityPageData }) {
  const line =
    data.status === "limited"
      ? "That is a lot of lookups from one place in one go. Give it a minute and ask again."
      : data.status === "missing"
        ? "Nothing on file under this identifier."
        : data.envelope.recordings.some((recording) => recording.relation === "ambiguous")
          ? "Fluncle has not ruled between these recordings."
          : undefined;

  return line ? <p className="log-index-intro">{line}</p> : undefined;
}
