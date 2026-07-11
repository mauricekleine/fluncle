import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import oxanium400 from "./fonts/oxanium-400.ttf?inline";
import oxanium800 from "./fonts/oxanium-800.ttf?inline";
import spaceGrotesk400 from "./fonts/space-grotesk-400.ttf?inline";
import spaceGrotesk700 from "./fonts/space-grotesk-700.ttf?inline";
import { BODY, BRAND, brandFonts, cardFonts, satoriText } from "./satori-render";

// The two things that were silently WRONG on these cards before, both of which fail without
// a sound: (1) the markup asking for a weight nobody registered — Satori synthesizes nothing,
// so it snaps to the nearest face and the rendered weight quietly differs from the code; and
// (2) a cut shipped without the One Box metrics baked in — Satori reads the TTF's own tables,
// so a re-cut that forgets the patch would drift the type off-centre in the one place nobody
// can inspect it. Both are now build-gate failures instead of things you notice on Discord.

/** The faces the render surfaces may ask for. One buffer per weight — no synthesis. */
const REGISTERED: Record<string, number[]> = {
  Oxanium: [400, 800],
  "Space Grotesk": [400, 700],
};

// --- A minimal sfnt reader, so the assertion runs against the BYTES WE SHIP ---------------
// (Reading the tables back, not trusting the cutting script's own word for it.)

function tables(dataUri: string): DataView {
  return new DataView(Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64").buffer);
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
