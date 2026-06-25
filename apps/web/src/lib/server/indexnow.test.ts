import { describe, expect, it } from "vitest";
import { buildIndexNowPayload, INDEXNOW_KEY } from "@/lib/server/indexnow";

// The payload shape is the one load-bearing, easy-to-get-wrong bit: the host and
// keyLocation must point at the same canonical host as the submitted URLs, or the
// engine rejects the batch. These pin that against the published key file path.
describe("buildIndexNowPayload", () => {
  it("uses the canonical host, the public key, and the matching key file URL", () => {
    const url = "https://www.fluncle.com/log/004.7.2I";
    const payload = buildIndexNowPayload([url]);

    expect(payload).toStrictEqual({
      host: "www.fluncle.com",
      key: INDEXNOW_KEY,
      keyLocation: `https://www.fluncle.com/${INDEXNOW_KEY}.txt`,
      urlList: [url],
    });
  });

  it("commits a 32-char lowercase-hex ownership key (a public token, not a secret)", () => {
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
  });

  it("passes the URL list through verbatim", () => {
    const urls = ["https://www.fluncle.com/log/a", "https://www.fluncle.com/log/b"];

    expect(buildIndexNowPayload(urls).urlList).toEqual(urls);
  });
});
