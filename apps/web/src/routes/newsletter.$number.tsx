import { Link, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getEditionByNumber } from "@/lib/server/editions";

// `/newsletter/<number>` — the letter's OLD address, kept alive as a 301.
//
// A sent edition is spine-native now: it carries an `L`-marked coordinate and its page
// is `/log/<023.L.1A>`, exactly as a mixtape's page is its coordinate and `/mixtapes`
// is only the index. One identity, one canonical URL, no second namespace — so the two
// URLs never compete for the same content. Every link already out there (the archive, a
// sent email, a crawler's index) lands on the letter through this redirect.

const fetchEditionCoordinate = createServerFn({ method: "GET" })
  .validator((data: { number: string }) => data)
  .handler(async ({ data: { number } }): Promise<{ logId: string }> => {
    const parsed = Number.parseInt(number, 10);

    if (!Number.isInteger(parsed) || parsed < 1) {
      throw notFound();
    }

    const edition = await getEditionByNumber(parsed);

    // A sent edition always derives a coordinate (its number + send date are frozen);
    // anything else is not a back issue, and 404s rather than redirecting nowhere.
    if (!edition?.logId) {
      throw notFound();
    }

    return { logId: edition.logId };
  });

// oxlint-disable-next-line sort-keys -- TanStack canonical property order (loader before component); see AGENTS.md
export const Route = createFileRoute("/newsletter/$number")({
  loader: async ({ params }) => {
    const { logId } = await fetchEditionCoordinate({ data: { number: params.number } });

    throw redirect({ params: { logId }, statusCode: 301, to: "/log/$logId" });
  },
  component: () => null,
  notFoundComponent: EditionNotFound,
});

function EditionNotFound() {
  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        <header className="log-masthead">
          <p className="log-nameplate">The mothership</p>
          <h1 className="log-coordinate log-index-title">No such issue</h1>
          <p className="log-index-intro">
            That one never left the launchpad. Try the back issues for the letters that did.
          </p>
        </header>
        <footer className="log-plate-footer">
          <Link to="/newsletter">All back issues</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
