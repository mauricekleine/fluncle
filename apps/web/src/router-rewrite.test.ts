import { describe, expect, it } from "vitest";
import { subdomainRewrite } from "./router-rewrite";

// The subdomain host-rewrite contract: each sibling host's root ("/") maps to its
// route on the way IN, and the route maps back to "/" on the way OUT, so the address
// bar stays <subdomain>.fluncle.com/. The rewrite runs isomorphically (SSR + client),
// so this pure-function check is the load-bearing guarantee.

function rewriteIn(href: string): string {
  return subdomainRewrite.input({ url: new URL(href) }).pathname;
}

function rewriteOut(href: string): string {
  return subdomainRewrite.output({ url: new URL(href) }).pathname;
}

describe("subdomain root rewrite (input)", () => {
  it("rewrites status.fluncle.com/ to /status", () => {
    expect(rewriteIn("https://status.fluncle.com/")).toBe("/status");
  });

  it("rewrites galaxy.fluncle.com/ to /galaxy and radio.fluncle.com/ to /radio", () => {
    expect(rewriteIn("https://galaxy.fluncle.com/")).toBe("/galaxy");
    expect(rewriteIn("https://radio.fluncle.com/")).toBe("/radio");
  });

  it("leaves www.fluncle.com/ untouched (the archive root)", () => {
    expect(rewriteIn("https://www.fluncle.com/")).toBe("/");
  });

  it("only rewrites the root, never a deeper path on the subdomain", () => {
    expect(rewriteIn("https://status.fluncle.com/about")).toBe("/about");
  });
});

describe("subdomain reverse rewrite (output)", () => {
  it("maps status.fluncle.com/status back to / so the address bar stays the host root", () => {
    expect(rewriteOut("https://status.fluncle.com/status")).toBe("/");
  });

  it("maps galaxy and radio routes back to / on their own hosts", () => {
    expect(rewriteOut("https://galaxy.fluncle.com/galaxy")).toBe("/");
    expect(rewriteOut("https://radio.fluncle.com/radio")).toBe("/");
  });

  it("does not collapse a subdomain route served from the wrong host", () => {
    expect(rewriteOut("https://www.fluncle.com/status")).toBe("/status");
  });
});
