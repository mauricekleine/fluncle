import { useDocsPage } from "fumadocs-ui/layouts/docs/page";
import { type ComponentProps } from "react";
import { cn } from "@/lib/utils";

// The /docs content pane, as a MAIN LANDMARK.
//
// Fumadocs' stock container slot renders `<article id="nd-page">`. `article` maps to the `article`
// role, which is not a landmark — so /docs shipped with no `<main>` at all, and every line of a doc
// page sat outside any landmark (axe: `landmark-one-main` plus six `region` nodes, 2026-07-26). A
// screen-reader reader had no "skip to the content" target on the one surface that is nothing BUT
// content.
//
// `slots={{ container }}` is Fumadocs' documented extension point for exactly this (fumadocs.dev,
// "Replace Page Container with Custom Component"), so the swap is an API call rather than a patch.
// The element becomes `<main>`; everything else is carried over verbatim from the stock slot,
// including the `[grid-area:main]` placement the DocsLayout grid needs and the `data-full` hook. The
// id stays `nd-page`, which is what both Fumadocs' own CSS and Fluncle's docs.css pane key off — no
// rule in either is tag-keyed, so not a pixel moves.
//
// The class list mirrors fumadocs-ui's `layouts/docs/page/slots/container`. If a Fumadocs upgrade
// restyles that slot, this is the file to re-sync (`npx @fumadocs/cli add slots/docs/page/container`
// prints the current one).
export function DocsPageContainer(props: ComponentProps<"article">) {
  const { full } = useDocsPage();

  return (
    <main
      data-full={full}
      id="nd-page"
      {...props}
      className={cn(
        "flex flex-col w-full max-w-[900px] mx-auto [grid-area:main] px-4 py-6 gap-4 md:px-6 md:pt-8 xl:px-8 xl:pt-14",
        full && "max-w-[1168px]",
        props.className,
      )}
    />
  );
}
