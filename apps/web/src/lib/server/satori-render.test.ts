import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import oxanium400 from "./fonts/oxanium-400.ttf?inline";
import oxanium800 from "./fonts/oxanium-800.ttf?inline";
import spaceGrotesk400 from "./fonts/space-grotesk-400.ttf?inline";
import spaceGrotesk700 from "./fonts/space-grotesk-700.ttf?inline";
import {
  BODY,
  BRAND,
  brandFonts,
  cardFonts,
  fetchImageDataUri,
  MAX_INLINE_IMAGE_BYTES,
  satoriText,
} from "./satori-render";

const REGISTERED: Record<string, number[]> = {
  Oxanium: [400, 800],
  "Space Grotesk": [400, 700],
};

function tables(dataUri: string): DataView {
  const buffer = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");

  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function table(view: DataView, tag: string): number {
  const count = view.getUint16(4);

  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 16;
    const name = String.fromCharCode(...[0, 1, 2, 3].map((n) => view.getUint8(entry + n)));

    if (name === tag) {
      return view.getUint32(entry + 8);
    }
  }

  throw new Error(`missing table: ${tag}`);
}

type Metrics = {
  capHeight: number;
  descender: number;
  lineGap: number;
  typoAscender: number;
  typoDescender: number;
  unitsPerEm: number;
  useTypoMetrics: boolean;
  ascender: number;
  winAscent: number;
  winDescent: number;
};

function metrics(dataUri: string): Metrics {
  const view = tables(dataUri);
  const head = table(view, "head");
  const hhea = table(view, "hhea");
  const os2 = table(view, "OS/2");

  return {
    ascender: view.getInt16(hhea + 4),
    capHeight: view.getInt16(os2 + 88),
    descender: view.getInt16(hhea + 6),
    lineGap: view.getInt16(hhea + 8),
    typoAscender: view.getInt16(os2 + 68),
    typoDescender: view.getInt16(os2 + 70),
    unitsPerEm: view.getUint16(head + 18),
    useTypoMetrics: (view.getUint16(os2 + 62) & (1 << 7)) !== 0,
    winAscent: view.getUint16(os2 + 74),
    winDescent: view.getUint16(os2 + 76),
  };
}

const CUTS = [
  { data: oxanium400, name: "oxanium-400" },
  { data: oxanium800, name: "oxanium-800" },
  { data: spaceGrotesk400, name: "space-grotesk-400" },
  { data: spaceGrotesk700, name: "space-grotesk-700" },
];

describe("the One Box Rule, baked into the cuts", () => {
  it.each(CUTS)("$name puts the cap band on the box centre", ({ data }) => {
    const m = metrics(data);

    expect(m.ascender + m.descender).toBe(m.capHeight);

    expect([m.typoAscender, m.typoDescender, m.lineGap]).toEqual([m.ascender, m.descender, 0]);
    expect([m.winAscent, m.winDescent]).toEqual([m.ascender, -m.descender]);
    expect(m.useTypoMetrics).toBe(true);
  });

  it.each(CUTS)("$name is the ratified box, not a re-derived one", ({ data, name }) => {
    const m = metrics(data);
    const [ascent, descent] = name.startsWith("oxanium") ? [0.97, 0.28] : [0.975, 0.275];

    expect(m.ascender).toBe(Math.round(ascent * m.unitsPerEm));
    expect(m.descender).toBe(-Math.round(descent * m.unitsPerEm));
  });
});

describe("registered faces", () => {
  it("registers exactly the weights the markup is allowed to ask for", () => {
    const registered = (fonts: { name: string; weight: number }[]) =>
      fonts.map((font) => `${font.name} ${font.weight}`).sort();

    expect(registered(cardFonts())).toEqual([
      "Oxanium 400",
      "Oxanium 800",
      "Space Grotesk 400",
      "Space Grotesk 700",
    ]);
    expect(registered(brandFonts())).toEqual(["Oxanium 400", "Oxanium 800"]);
  });

  it("hands Satori real, distinct font buffers", () => {
    const fonts = cardFonts();

    for (const font of fonts) {
      expect(new DataView(font.data).getUint32(0)).toBe(0x0001_0000);
      expect(font.data.byteLength).toBeGreaterThan(10_000);
    }

    expect(new Set(fonts.map((font) => font.data.byteLength)).size).toBe(fonts.length);
  });
});

describe("every weight the cards ask for is registered", () => {
  const SURFACES = [
    "src/routes/api/og.$logId.ts",
    "src/routes/api/og.set.ts",
    "src/lib/server/mixtape-cover.ts",
  ];

  it.each(SURFACES)("%s asks only for faces that exist", (file) => {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    const family = (style: string, fallback: string): string => {
      if (style.includes("font-family:${BRAND}")) {
        return "Oxanium";
      }

      return style.includes("font-family:${BODY}") ? "Space Grotesk" : fallback;
    };

    const container = source.match(/font-family:\$\{(BRAND|BODY)\}/)?.[1];

    expect(container).toBeDefined();

    const inherited = container === "BRAND" ? "Oxanium" : "Space Grotesk";
    const styles = [...source.matchAll(/style="([^"]*)"/g)].map((match) => match[1] ?? "");
    const asked = styles
      .map((style) => ({
        name: family(style, inherited),
        weight: Number(style.match(/font-weight:(\d+)/)?.[1] ?? 400),
      }))
      .filter((face) => face.weight > 0);

    expect(asked.length).toBeGreaterThan(0);

    for (const face of asked) {
      expect(
        REGISTERED[face.name],
        `${file} sets font-weight:${face.weight} on ${face.name}, which is not a registered cut`,
      ).toContain(face.weight);
    }
  });

  it("keeps BRAND and BODY pointing at the registered family names", () => {
    expect(BRAND).toBe("'Oxanium'");
    expect(BODY).toBe("'Space Grotesk'");
    expect(Object.keys(REGISTERED)).toContain(BRAND.replaceAll("'", ""));
    expect(Object.keys(REGISTERED)).toContain(BODY.replaceAll("'", ""));
  });
});

describe("satoriText", () => {
  it("passes & and quotes through raw — the parser does not decode them", () => {
    expect(satoriText("Calyx & TeeBee")).toBe("Calyx & TeeBee");
    expect(satoriText('"Quoted" Mix')).toBe('"Quoted" Mix');
    expect(satoriText("I Can't Do - VIP")).toBe("I Can't Do - VIP");
    expect(satoriText("Drum & Bass")).not.toContain("&amp;");
  });

  it("neutralises the only characters that can break a text node open", () => {
    expect(satoriText("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(satoriText("a > b < c")).toBe("a &gt; b &lt; c");
  });

  it("leaves the archive's real glyphs alone", () => {
    expect(satoriText("Kraść — Ærø · ¾")).toBe("Kraść — Ærø · ¾");
  });
});

describe("fetchImageDataUri's inline ceiling", () => {
  function chunkedImage(bytes: number): Response {
    const chunkSize = 64 * 1024;
    let sent = 0;

    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= bytes) {
            controller.close();

            return;
          }

          const size = Math.min(chunkSize, bytes - sent);
          sent += size;
          controller.enqueue(new Uint8Array(size));
        },
      }),
      { headers: { "content-type": "image/jpeg" } },
    );
  }

  function withFetch<T>(response: () => Response, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(response())) as unknown as typeof fetch;

    return run().finally(() => {
      globalThis.fetch = original;
    });
  }

  it("inlines a body exactly at the cap", async () => {
    const inlined = await withFetch(
      () => chunkedImage(MAX_INLINE_IMAGE_BYTES),
      () => fetchImageDataUri("https://found.fluncle.com/at-the-cap.jpg"),
    );

    expect(inlined?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("refuses a body one byte past the cap rather than truncating it", async () => {
    const inlined = await withFetch(
      () => chunkedImage(MAX_INLINE_IMAGE_BYTES + 1),
      () => fetchImageDataUri("https://found.fluncle.com/over-the-cap.jpg"),
    );

    expect(inlined).toBeUndefined();
  });

  it("refuses an honestly-declared oversized body without transferring it", async () => {
    const declaredOversize = () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-length": String(MAX_INLINE_IMAGE_BYTES + 1),
          "content-type": "image/jpeg",
        },
      });

    const inlined = await withFetch(declaredOversize, () =>
      fetchImageDataUri("https://found.fluncle.com/declared-huge.jpg"),
    );

    expect(inlined).toBeUndefined();
  });

  it("still inlines an ordinary cover, and still falls back on the missing content type", async () => {
    const png = () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    const typeless = () => new Response(new Uint8Array([1, 2, 3]));

    expect(
      await withFetch(png, () => fetchImageDataUri("https://found.fluncle.com/cover.png")),
    ).toBe("data:image/png;base64,iVBORw==");
    expect(
      await withFetch(typeless, () =>
        fetchImageDataUri("https://found.fluncle.com/ground", "image/png"),
      ),
    ).toBe("data:image/png;base64,AQID");
  });
});
