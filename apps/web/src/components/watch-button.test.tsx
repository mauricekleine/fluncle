// THE NEVER-GATES GUARANTEE, at the render level (D2a). The watch control must never appear
// for a visitor whose session is not confirmed — the SaveSetDialog precedent, and the product
// law that a signed-out visitor sees NOTHING new on an entity page. The control starts in the
// "loading" face and returns null; the session check runs in a `useEffect`, which never fires
// under SSR — so the FIRST PAINT is always empty, and a signed-out client (whose
// `/api/me/watches` check resolves to 401) simply never leaves that empty state. This pins the
// default-empty render (vitest env = node, no DOM — the catalogue-hub-section.test.tsx style).
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
