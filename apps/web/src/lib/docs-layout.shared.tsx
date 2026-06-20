import { type BaseLayoutProps } from "fumadocs-ui/layouts/shared";

// Shared chrome for the /docs hub: the nameplate that links home and the rail
// of secondary surfaces. Kept in Fluncle's register — the docs are the field
// manual for the machinery, not a marketing page.
export function docsBaseOptions(): BaseLayoutProps {
  return {
    githubUrl: undefined,
    // One link back to the music. "API reference" used to live here too, but it
    // already sits in the sidebar tree under "The API" (meta.json), so a second
    // copy at the top was a duplicate — kept to a single entry now.
    links: [
      {
        text: "Findings",
        url: "/",
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
    // Dark-only: drop Fumadocs' sun/moon theme switch. The theme is forced dark
    // by the RootProvider (docs.tsx); there is nothing to toggle.
    themeSwitch: {
      enabled: false,
    },
  };
}
