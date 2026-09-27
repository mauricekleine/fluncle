import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HubTile } from "./hub-sections";

function tile(playable: boolean): string {
  return renderToStaticMarkup(
    <HubTile kind="album" lit={false} name="Night Ferry" playable={playable} slug="night-ferry">
      <a href="/album/night-ferry">Night Ferry</a>
    </HubTile>,
  );
}

describe("HubTile", () => {
  it("draws a labelled play control when one of the tile's tracks can sound", () => {
    const html = tile(true);

    expect(html).toContain('class="hub-tile-play"');
    expect(html).toContain('aria-label="Play Night Ferry"');
  });

  it("leaves a silent tile as its link alone, with no play control", () => {
    const html = tile(false);

    expect(html).not.toContain("hub-tile-play");
    expect(html).not.toContain("data-discovery-play");
    expect(html).toContain('href="/album/night-ferry"');
  });
});
