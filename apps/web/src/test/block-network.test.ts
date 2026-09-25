import { describe, expect, it } from "vitest";

describe("the global no-network rail", () => {
  it("rejects an outbound request to an external host", async () => {
    await expect(fetch("https://discord.com/api/webhooks/nope")).rejects.toThrow(
      /Blocked outbound request/,
    );
  });

  it("names the offending URL so the caller is findable", async () => {
    await expect(fetch("https://api.example.com/v1/send")).rejects.toThrow(
      "https://api.example.com/v1/send",
    );
  });

  it("blocks a Request object, not just a string URL", async () => {
    await expect(fetch(new Request("https://hooks.example.com/post"))).rejects.toThrow(
      /Blocked outbound request/,
    );
  });

  it("blocks a URL object", async () => {
    await expect(fetch(new URL("https://example.com/thing"))).rejects.toThrow(
      /Blocked outbound request/,
    );
  });

  it("lets loopback through (a local libSQL server or fixture server is legitimate)", async () => {
    await expect(fetch("http://127.0.0.1:1/health")).rejects.not.toThrow(
      /Blocked outbound request/,
    );
  });
});
