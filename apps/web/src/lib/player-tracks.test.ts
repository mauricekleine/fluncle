import { describe, expect, it } from "vitest";
import { similarSearchHref } from "./player-tracks";

describe("similarSearchHref — where 'Similar tracks' goes", () => {
  it("opens the sonic view keyed by the track id, so a seed never resolves to a namesake", () => {
    expect(similarSearchHref({ artists: ["Netsky"], id: "mb_1234-abcd", title: "Rio" })).toBe(
      "/search?like=mb_1234-abcd",
    );
  });

  it("falls back to the worded phrase for a finding-only caller keyed by its coordinate", () => {
    expect(similarSearchHref({ artists: ["1991"], id: "024.7.2R", title: "Nine Clouds" })).toBe(
      "/search?q=tracks%20that%20sound%20like%201991%20%E2%80%94%20Nine%20Clouds",
    );
  });
});
