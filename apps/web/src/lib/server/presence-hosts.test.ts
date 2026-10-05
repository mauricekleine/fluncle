import { describe, expect, it } from "vitest";
import { presenceRedirect, withPresenceRobots } from "./presence-hosts";

describe("presence redirects", () => {
  it.each(["GET", "HEAD"])(
    "permanently trims trailing slashes for %s while preserving origin and search",
    (method) => {
      for (const host of ["www.fluncle.com", "status.fluncle.com", "mirror.onion"]) {
        const response = presenceRedirect(
          new Request(`https://${host}/albums///?page=2&tag=a%2Fb`, { method }),
        );
        expect(response?.status).toBe(308);
        expect(response?.headers.get("location")).toBe(`https://${host}/albums?page=2&tag=a%2Fb`);
      }
    },
  );

  it.each(["radio", "galaxy"])(
    "redirects %s archive paths straight to the final www address",
    (host) => {
      for (const method of ["GET", "HEAD"]) {
        for (const suffix of ["", "/", "///"]) {
          const response = presenceRedirect(
            new Request(`https://${host}.fluncle.com/album/dub-pack${suffix}?page=2`, { method }),
          );
          expect(response?.status).toBe(308);
          expect(response?.headers.get("location")).toBe(
            "https://www.fluncle.com/album/dub-pack?page=2",
          );
        }
      }
    },
  );

  it("keeps double-leading-slash destinations on the selected host", () => {
    for (const [host, destination] of [
      ["www.fluncle.com", "www.fluncle.com"],
      ["radio.fluncle.com", "www.fluncle.com"],
    ]) {
      const response = presenceRedirect(new Request(`https://${host}//evil.com/?q=1`));
      expect(response?.headers.get("location")).toBe(`https://${destination}//evil.com?q=1`);
    }
    expect(
      presenceRedirect(new Request("https://status.fluncle.com///"))?.headers.get("location"),
    ).toBe("https://status.fluncle.com/");
  });

  it("preserves runtime requests and host roots", () => {
    const paths = [
      "/",
      "/_serverFn/id/",
      "/api/preview/track/",
      "/assets/app.js",
      "/fonts/oxanium-latin.woff2",
      "/cdn-cgi/media/transform",
      "/favicon.ico",
      "/favicon.png",
      "/apple-touch-icon.png",
      "/manifest.webmanifest",
      "/fluncle.png",
    ];
    for (const host of ["radio", "galaxy"]) {
      for (const path of paths) {
        for (const method of ["GET", "HEAD"]) {
          expect(
            presenceRedirect(new Request(`https://${host}.fluncle.com${path}?v=2`, { method })),
            `${method} ${host}${path}`,
          ).toBeUndefined();
        }
      }
    }
    for (const path of [
      "/galaxy/ship.png",
      "/galaxy/earth.png",
      "/galaxy/roadster.png",
      "/galaxy/ufo.png",
      "/galaxy/asteroid.png",
      "/galaxy/amen.mp3",
      "/galaxy/og.png",
    ]) {
      expect(presenceRedirect(new Request(`https://galaxy.fluncle.com${path}`))).toBeUndefined();
    }
  });

  it("keeps exemptions bounded to runtime paths on their owning host", () => {
    for (const path of [
      "/galaxy/album",
      "/assets-lookalike",
      "/fonts-lookalike",
      "/api-lookalike",
      "/_serverFn-lookalike",
      "/radio",
      "/galaxy",
    ]) {
      expect(presenceRedirect(new Request(`https://galaxy.fluncle.com${path}`))?.status).toBe(308);
    }
    expect(presenceRedirect(new Request("https://radio.fluncle.com/galaxy/ship.png"))?.status).toBe(
      308,
    );
  });

  it("preserves other methods, slashless status pages, and unrelated hosts", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(
        presenceRedirect(new Request("https://radio.fluncle.com/albums/", { method })),
      ).toBeUndefined();
    }
    for (const host of [
      "status.fluncle.com",
      "www.fluncle.com",
      "galaxy.example.com",
      "radio.fluncle.com.example.com",
      "status.mirror.onion",
    ]) {
      expect(presenceRedirect(new Request(`https://${host}/albums`))).toBeUndefined();
    }
  });
});

describe("presence robots", () => {
  it("marks only non-root HTML on the three surface hosts without mutating the source response", async () => {
    const original = new Response("document", {
      headers: {
        "cache-control": "public, max-age=60",
        "content-type": "text/html; charset=utf-8",
      },
      status: 404,
      statusText: "Not Found",
    });
    for (const host of ["status", "radio", "galaxy"]) {
      const response = withPresenceRobots(
        new Request(`https://${host}.fluncle.com/album/example`),
        original.clone(),
      );
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
      expect(response.status).toBe(404);
      expect(response.statusText).toBe("Not Found");
      expect(await response.text()).toBe("document");
    }
    expect(original.headers.get("x-robots-tag")).toBeNull();
  });

  it("preserves roots, non-HTML, canonical and onion responses with any existing robots policy", () => {
    for (const url of [
      "https://status.fluncle.com/",
      "https://radio.fluncle.com/",
      "https://galaxy.fluncle.com/",
      "https://www.fluncle.com/albums",
      "http://status.mirror.onion/albums",
      "https://status.example.com/albums",
    ]) {
      const response = new Response("document", {
        headers: { "content-type": "text/html", "x-robots-tag": "nofollow" },
      });
      expect(withPresenceRobots(new Request(url), response)).toBe(response);
      expect(response.headers.get("x-robots-tag")).toBe("nofollow");
    }
    for (const type of ["application/json", "image/png", "text/event-stream", "text/plain"]) {
      const response = new Response("resource", { headers: { "content-type": type } });
      expect(
        withPresenceRobots(new Request("https://status.fluncle.com/api/example"), response),
      ).toBe(response);
    }
  });
});
