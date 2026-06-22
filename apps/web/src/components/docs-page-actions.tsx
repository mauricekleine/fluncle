import { usePathname } from "fumadocs-core/framework";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
// MarkdownCopyButton is re-exported from the public docs/page entry (the
// `shared/page-actions` path itself is not in fumadocs-ui's exports map). Same
// entry the docs page renders from.
import { MarkdownCopyButton } from "fumadocs-ui/layouts/docs/page";
// Chrome glyphs from the app's icon set (@phosphor-icons/react), not lucide —
// lucide isn't a direct dependency here, and Phosphor already voices every other
// control. The brand marks (OpenAI/Anthropic/Cursor) stay inline SVG below.
import { ArrowSquareOutIcon, CaretDownIcon, FileTextIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The per-page "Copy page / LLM" affordance, on every docs page. Fumadocs 16
// ships MarkdownCopyButton (fetch + copy the page Markdown) and its own
// ViewOptionsPopover (the "Open" dropdown). We keep the copy button as-is but
// render OUR own dropdown: Fumadocs' ViewOptionsPopover hardcodes its link list
// with no prop to drop a single entry, and we want "Open in Scira AI" gone while
// the other four stay (View as Markdown, ChatGPT, Claude, Cursor). This mirrors
// Fumadocs' component exactly — same Popover primitives, same buttonVariants,
// same item markup — minus Scira (and minus the GitHub link: the repo is
// private). Both pieces key off `markdownUrl`, pointed at the per-page Markdown
// route (routes/docs[.]md.$.ts): `/docs.md/<slug>`. That sibling path can never
// shadow a doc page (the HTML lives at `/docs/<slug>`). We derive the slug from
// the current pathname so this one component serves every page, the index too.

type OpenItem = {
  href: string;
  icon: ReactNode;
  title: string;
};

function useOpenItems(markdownUrl: string): OpenItem[] {
  const pathname = usePathname();
  const pageUrl =
    typeof window === "undefined" ? pathname : new URL(pathname, window.location.origin).toString();
  const q = `Read ${pageUrl}, I want to ask questions about it.`;

  return [
    {
      href: markdownUrl,
      icon: <FileTextIcon />,
      title: "View as Markdown",
    },
    {
      href: `https://chatgpt.com/?${new URLSearchParams({ hints: "search", q })}`,
      icon: (
        <svg fill="currentColor" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <title>OpenAI</title>
          <path d="M22.28 9.82a5.98 5.98 0 0 0-0.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 0.74 7.1 5.98 5.98 0 0 0 0.51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-0.75-7.07zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l0.14-0.08 4.78-2.76a0.79 0.79 0 0 0 0.39-0.68v-6.74l2.02 1.17a0.07 0.07 0 0 1 0.04 0.05v5.58a4.5 4.5 0 0 1-4.49 4.49zm-9.66-4.13a4.47 4.47 0 0 1-0.53-3.01l0.14 0.09 4.78 2.76a0.77 0.77 0 0 0 0.78 0l5.84-3.37v2.33a0.08 0.08 0 0 1-0.03 0.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a0.77 0.77 0 0 0 0.39 0.68l5.81 3.35-2.02 1.17a0.08 0.08 0 0 1-0.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87zm16.6 3.86L13.1 8.36 15.12 7.2a0.08 0.08 0 0 1 0.07 0l4.83 2.79a4.49 4.49 0 0 1-0.68 8.1v-5.68a0.79 0.79 0 0 0-0.41-0.67zm2.01-3.02l-0.14-0.09-4.77-2.78a0.78 0.78 0 0 0-0.79 0L9.41 9.23V6.9a0.07 0.07 0 0 1 0.03-0.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a0.08 0.08 0 0 1-0.04-0.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-0.14 0.08L8.7 5.46a0.79 0.79 0 0 0-0.39 0.68zm1.1-2.37l2.6-1.5 2.61 1.5v3l-2.6 1.5-2.61-1.5Z" />
        </svg>
      ),
      title: "Open in ChatGPT",
    },
    {
      href: `https://claude.ai/new?${new URLSearchParams({ q })}`,
      icon: (
        <svg fill="currentColor" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <title>Anthropic</title>
          <path d="M17.3 3.54h-3.67l6.7 16.92H24Zm-10.61 0L0 20.46h3.74l1.37-3.55h7.01l1.37 3.55h3.74L10.54 3.54Zm-0.37 10.22 2.29-5.95 2.29 5.95Z" />
        </svg>
      ),
      title: "Open in Claude",
    },
    {
      href: `https://cursor.com/link/prompt?${new URLSearchParams({ text: q })}`,
      icon: (
        <svg fill="currentColor" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <title>Cursor</title>
          <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
        </svg>
      ),
      title: "Open in Cursor",
    },
  ];
}

function ViewOptionsPopover({ markdownUrl }: { markdownUrl: string }) {
  const items = useOpenItems(markdownUrl);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          buttonVariants({ color: "secondary", size: "sm" }),
          "gap-2 data-[state=open]:bg-fd-accent data-[state=open]:text-fd-accent-foreground",
        )}
      >
        Open
        <CaretDownIcon className="size-3.5 text-fd-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="flex flex-col">
        {items.map((item) => (
          <a
            className="text-sm p-2 rounded-lg inline-flex items-center gap-2 hover:text-fd-accent-foreground hover:bg-fd-accent [&_svg]:size-4"
            href={item.href}
            key={item.href}
            rel="noreferrer noopener"
            target="_blank"
          >
            {item.icon}
            {item.title}
            <ArrowSquareOutIcon className="text-fd-muted-foreground size-3.5 ms-auto" />
          </a>
        ))}
      </PopoverContent>
    </Popover>
  );
}

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
