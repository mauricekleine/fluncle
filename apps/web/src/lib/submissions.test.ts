import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIBE_FAILED_MESSAGE, subscribeToNewsletter } from "./newsletter";
import {
  SEARCH_FAILED_MESSAGE,
  SUBMIT_FAILED_MESSAGE,
  searchTracks,
  submitTrack,
  type SearchResult,
} from "./submissions";

const candidate: SearchResult = {
  artists: ["Camo & Krooked"],
  id: "spotify-track",
  spotifyUrl: "https://open.spotify.com/track/spotify-track",
  title: "Turn Up the Music",
};

function respondWith(response: Response): void {
  vi.stubGlobal("fetch", async () => response);
}

function htmlGatewayError(): Response {
  return new Response("<!DOCTYPE html><title>502 Bad Gateway</title>", {
    headers: { "Content-Type": "text/html" },
    status: 502,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the public submit and subscribe fetchers", () => {
  it("speak in voice when the server answers with a non-JSON error page", async () => {
    respondWith(htmlGatewayError());
    await expect(searchTracks("camo")).rejects.toThrow(SEARCH_FAILED_MESSAGE);

    respondWith(htmlGatewayError());
    await expect(submitTrack({ candidate })).rejects.toThrow(SUBMIT_FAILED_MESSAGE);

    respondWith(htmlGatewayError());
    await expect(subscribeToNewsletter({ email: "raver@example.com" })).rejects.toThrow(
      SUBSCRIBE_FAILED_MESSAGE,
    );
  });

  it("pass the server's own message through when it sends one", async () => {
    respondWith(
      Response.json({ message: "That email doesn't look right.", ok: false }, { status: 400 }),
    );
    await expect(subscribeToNewsletter({ email: "nope" })).rejects.toThrow(
      "That email doesn't look right.",
    );
  });

  it("never show the crew a status code or a parser error", async () => {
    respondWith(htmlGatewayError());
    const error = await searchTracks("camo").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/\d{3}|JSON|token/i);
  });
});
