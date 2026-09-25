import { type BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function docsBaseOptions(): BaseLayoutProps {
  return {
    githubUrl: undefined,

    links: [
      {
        text: "Findings",
        url: "/findings",
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

    themeSwitch: {
      enabled: false,
    },
  };
}
