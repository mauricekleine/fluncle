import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchButton } from "./watch-button";

describe("WatchButton — the never-gates render guarantee", () => {
  it("renders nothing on first paint (no control until a session is confirmed)", () => {
    const html = renderToStaticMarkup(
      <WatchButton entityId="artist-1" kind="artist" name="Netsky" />,
    );

    expect(html).toBe("");
  });

  it("renders nothing for a label either", () => {
    const html = renderToStaticMarkup(
      <WatchButton entityId="label-1" kind="label" name="Hospital Records" />,
    );

    expect(html).toBe("");
  });
});
