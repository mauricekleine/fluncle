import { Link, Outlet, createFileRoute } from "@tanstack/react-router";

import sharedCss from "@/concepts/discovery/styles/shared.css?url";

// ── /concepts — the held discovery exhibit ────────────────────────────────────
//
// Three end-to-end public-web discovery concepts, built on one snapshot of
// Fluncle's real public data so the comparison is about the model rather than the
// content. This layout carries the exhibit's OWN chrome — the bar below is the
// frame around the pictures, not part of any concept, and the comparison document
// (docs/concepts/discovery/README.md) says so where it matters.
//
// The whole tree is `noindex, nofollow` and registered in no sitemap, no feed, and
// no `@fluncle/registry` surface: it is evidence for a direction call, not a
// surface anyone is meant to find. It changes no existing URL, contract, or read.

export const Route = createFileRoute("/concepts")({
  component: ConceptsLayout,
  head: () => ({
    links: [{ href: sharedCss, rel: "stylesheet" }],
    meta: [{ content: "noindex, nofollow", name: "robots" }],
  }),
});

const CONCEPTS = [
  { label: "Front page", to: "/concepts/front" },
  { label: "Desk", to: "/concepts/desk" },
  { label: "Run", to: "/concepts/run" },
] as const;

function ConceptsLayout() {
  return (
    <>
      <nav aria-label="Discovery concept exhibit" className="concept-exhibit-bar">
        <Link
          activeOptions={{ exact: true }}
          activeProps={{ className: "text-primary" }}
          className="concept-focus concept-display text-[0.78rem] font-bold text-muted-foreground transition-colors duration-150 hover:text-accent-foreground"
          to="/concepts"
        >
          Exhibit
        </Link>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <ul className="flex items-center gap-3">
          {CONCEPTS.map((concept) => (
            <li key={concept.to}>
              <Link
                activeProps={{ className: "text-primary" }}
                className="concept-focus text-[0.8rem] text-muted-foreground transition-colors duration-150 hover:text-accent-foreground"
                to={concept.to}
              >
                {concept.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </>
  );
}
