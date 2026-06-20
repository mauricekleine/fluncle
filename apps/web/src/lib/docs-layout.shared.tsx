import { type BaseLayoutProps } from "fumadocs-ui/layouts/shared";

// Shared chrome for the /docs hub: the nameplate that links home and the rail
// of secondary surfaces. Kept in Fluncle's register — the docs are the field
// manual for the machinery, not a marketing page.
export function docsBaseOptions(): BaseLayoutProps {
  return {
    githubUrl: undefined,
    links: [
      {
        text: "Findings",
        url: "/",
      },
      {
        text: "API reference",
        url: "/docs/api",
      },
    ],
    nav: {
      title: (
        <span className="font-display font-extrabold tracking-[-0.02em] text-foreground">
          FLUNCLE <span className="text-muted-foreground">/ docs</span>
        </span>
      ),
      url: "/docs",
    },
  };
}
