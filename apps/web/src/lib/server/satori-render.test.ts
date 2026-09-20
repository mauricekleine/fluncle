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

// The card contract has two build-gate checks: markup may ask only for registered weights,
// because Satori synthesizes no missing face; and every TTF must carry the One Box metrics,
// because Satori reads the font's own tables when positioning the render.

/** The faces the render surfaces may ask for. One buffer per weight — no synthesis. */
const REGISTERED: Record<string, number[]> = {
  Oxanium: [400, 800],
  "Space Grotesk": [400, 700],
};

// --- A minimal sfnt reader, so the assertion runs against the BYTES WE SHIP ---------------
// (Reading the tables back, not trusting the cutting script's own word for it.)

function tables(dataUri: string): DataView {
  const buffer = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");

  // A Buffer may be a view into a shared allocation. Scope the DataView to the decoded font
  // rather than parsing unrelated bytes at the start of its backing ArrayBuffer.
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
  // Satori has no @font-face, so styles.css's ascent-override/descent-override cannot reach
  // it — the overrides live in the font's own tables (scripts/cut-satori-fonts.py).
  it.each(CUTS)("$name puts the cap band on the box centre", ({ data }) => {
    const m = metrics(data);

    // The whole rule, in one line: ascent − descent == cap height (descender is negative).
    expect(m.ascender + m.descender).toBe(m.capHeight);

    // Set on BOTH metric families, and flagged, so every consumer reads the same box.
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
    // The mixtape cover carries only brand marks, so it registers no body face.
    expect(registered(brandFonts())).toEqual(["Oxanium 400", "Oxanium 800"]);
  });

  it("hands Satori real, distinct font buffers", () => {
    const fonts = cardFonts();

    for (const font of fonts) {
      // sfnt magic for a TrueType outline font — not an empty buffer, not woff2.
      expect(new DataView(font.data).getUint32(0)).toBe(0x0001_0000);
      expect(font.data.byteLength).toBeGreaterThan(10_000);
    }

    expect(new Set(fonts.map((font) => font.data.byteLength)).size).toBe(fonts.length);
  });
});

describe("every weight the cards ask for is registered", () => {
  // Satori SYNTHESIZES NOTHING: an unregistered weight silently snaps to the nearest face, so
  // the card renders a weight the code never asked for. That is exactly how these three
  // surfaces shipped `font-weight:600` and `font-weight:700` against a 500/800-only registry.
  // Read the real markup and prove every (family, weight) pair it uses has a buffer behind it.
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

    // The container sets the file's default face; every nested element inherits it unless it
    // opts in to the other one.
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
    // Satori matches on the literal family name — there is no fallback stack to fall down, so
    // a typo here is a blank card, not a system-sans card.
    expect(BRAND).toBe("'Oxanium'");
    expect(BODY).toBe("'Space Grotesk'");
    expect(Object.keys(REGISTERED)).toContain(BRAND.replaceAll("'", ""));
    expect(Object.keys(REGISTERED)).toContain(BODY.replaceAll("'", ""));
  });
});

describe("satoriText", () => {
  // workers-og escapes text on the way OUT and never decodes on the way IN, so anything we
  // pre-escape prints its own entity. This was live: `Calyx & TeeBee` rendered `Calyx &amp;
  // TeeBee` on the link preview of every card whose title carried an ampersand.
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
  // The OG/cover routes are ANONYMOUS GETs whose hero URL comes off a database row, and the
  // fetched bytes are base64'd and then parsed again as markup inside a 128 MB Worker. So the
  // ceiling is asserted AT the cap and one byte past it, and the refusal is the module's own
  // documented degradation (`undefined` → a card with a bare background), never a truncation:
  // half an image is a broken render. The number is 2× the fetched-cover bound this repo already
  // states in lib/server/cover-masters.ts.

  /** A body delivered in chunks with NO `content-length` — the shape a declared-length cap misses. */
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
    // The body here is three bytes — it would inline fine. Only the DECLARED length is over the
    // cap, so a refusal proves the header is consulted first and the transfer is never spent.
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
