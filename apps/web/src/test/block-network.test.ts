import { describe, expect, it } from "vitest";

// Proves the global no-network rail (./block-network, wired as vitest's setupFile) is
// actually armed. Without it, any test touching a write path runs with the operator's
// real `.dev.vars` credentials — `loadLocalEnv` loads them whenever `import.meta.env.DEV`
// is true, which it is under vitest — and fires the live integration. That is not
// hypothetical: on 2026-07-20 the submission suites POSTed ~15 real messages per run to
// the crew's Discord channel.
//
// If this file ever fails, the rail is down and the suite can reach production services.

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
    // Port 1 is closed, so this fails at the TRANSPORT — the point is that it is NOT
    // refused by the rail, proving loopback is exempt.
    await expect(fetch("http://127.0.0.1:1/health")).rejects.not.toThrow(
      /Blocked outbound request/,
    );
  });
});
