import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getDocsMdxComponents } from "./docs-mdx";

const LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function render(level: (typeof LEVELS)[number], props: { id?: string; children: ReactNode }) {
  const Component = getDocsMdxComponents()[level] as ComponentType<typeof props>;
  return renderToStaticMarkup(createElement(Component, props));
}

describe("docs headings", () => {
  it.each(LEVELS)("%s holds only its anchored title, with the copy button beside it", (level) => {
    const markup = render(level, { children: "Install the CLI", id: "install" });

    const heading = markup.match(new RegExp(`<${level}\\b([^>]*)>(.*?)</${level}>`));
    expect(heading?.[1]).toContain('id="install"');
    expect(heading?.[2]).toBe('<a data-card="" href="#install">Install the CLI</a>');

    const button = markup.slice(markup.indexOf(`</${level}>`) + `</${level}>`.length);
    expect(button).toMatch(/^<button\b/);
    expect(button).toContain('aria-label="Copy link to this section"');
    expect(button).toContain('aria-live="polite"');
    expect(button).toMatch(/<svg\b[^>]*aria-hidden="true"/);
  });

  it.each(LEVELS)("%s without an id renders as a plain heading", (level) => {
    expect(render(level, { children: "Overview" })).toBe(`<${level}>Overview</${level}>`);
  });
});
