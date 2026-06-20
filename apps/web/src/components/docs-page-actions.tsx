import { usePathname } from "fumadocs-core/framework";
// MarkdownCopyButton + ViewOptionsPopover are re-exported from the public
// docs/page entry (the `shared/page-actions` path itself is not in fumadocs-ui's
// exports map). Same entry the docs page renders from.
import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/docs/page";

// The per-page "Copy page / LLM" affordance, on every docs page. Fumadocs 16
// ships the two pieces natively:
//   - MarkdownCopyButton — fetches the page's Markdown and copies it.
//   - ViewOptionsPopover — the dropdown: View as Markdown, Open in ChatGPT,
//     Open in Claude, Open in Cursor (Scira AI too).
// Both key off `markdownUrl`, which we point at the per-page Markdown route
// (routes/docs[.]md.$.ts): `/docs.md/<slug>`. That sibling path can never
// shadow a doc page (the HTML lives at `/docs/<slug>`). We derive the slug from
// the current pathname so this one component serves every page, the /docs index
// included. No GitHub link — the repo is private — so "Open in GitHub" is
// omitted.
export function DocsPageActions() {
  const pathname = usePathname();
  // "/docs" or "/docs/" -> "" (the index, served at /docs.md/); "/docs/cli" ->
  // "cli". Map onto the markdown sibling: /docs.md/<slug>.
  const slug = pathname.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  const markdownUrl = `/docs.md/${slug}`;

  return (
    <div className="docs-page-actions flex flex-row items-center gap-2 pt-2 pb-6 border-b">
      <MarkdownCopyButton markdownUrl={markdownUrl}>Copy page</MarkdownCopyButton>
      <ViewOptionsPopover markdownUrl={markdownUrl} />
    </div>
  );
}
