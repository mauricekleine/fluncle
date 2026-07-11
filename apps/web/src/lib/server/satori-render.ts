import oxanium400 from "./fonts/oxanium-400.ttf?inline";
import oxanium800 from "./fonts/oxanium-800.ttf?inline";
import spaceGrotesk400 from "./fonts/space-grotesk-400.ttf?inline";
import spaceGrotesk700 from "./fonts/space-grotesk-700.ttf?inline";

// The brand's faces, bundled as bytes for the Satori renders — the OG cards
// (routes/api/og.$logId.ts, routes/api/og.set.ts) and the mixtape cover
// (lib/server/mixtape-cover.ts). DESIGN.md's Canon Travels Rule: a render environment
// has no system fonts and no stylesheet to cascade from, so it must EMBED the faces —
// AND carry the One Box Rule's metric overrides with them.
//
// WHY BUNDLED BYTES, AND WHY THESE FILES
//
// - Satori does NOT read woff2, so `public/fonts/*.woff2` (what the web app serves) is
//   unusable here. It takes TTF/OTF/WOFF.
// - A Worker has no system fonts, no `assets` binding (wrangler.jsonc), and cannot fetch
//   its own origin (that loops to the SPA fallback — see mixtape-cover.ts). The bytes have
//   to be in the bundle. These three surfaces used to `loadGoogleFont()` — a render-time
//   fetch to Google — which broke the self-hosting rule (DESIGN.md §3: "All three faces are
//   SELF-HOSTED, and that is a rule") and put a third-party network hop on the critical path
//   of every link preview.
// - Satori has no `@font-face`, so it reads each TTF's own hhea/OS/2 tables and the CSS
//   ascent-override/descent-override in styles.css cannot reach it. The One Box Rule is
//   therefore baked INTO these cuts (ascent − descent == cap height, USE_TYPO_METRICS set).
//   That is DESIGN.md's own remedy: fix the font, not the elements. `scripts/cut-satori-fonts.py`
//   cuts them from the upstream variable fonts and verifies the tables; the SIL OFL licences
//   ship beside them in `fonts/`.
//
// Vite's `?inline` bakes each TTF into the module graph as a base64 data-URI — bundler-owned,
// no wrangler `rules` entry, no build step, and it resolves identically in `vite dev`, the
// Worker build, and vitest. ~146 kB of TTF, decoded once per isolate (memoized below).
//
// SATORI SYNTHESIZES NOTHING. No faux-bold, no interpolation between registered weights: it
// snaps to the nearest registered face, silently. So the markup may only ask for a weight
// that appears here — Oxanium 400/800, Space Grotesk 400/700 (700 is Space Grotesk's ceiling;
// DESIGN.md §3). Adding a weight to a card means cutting it first (add a row to CUTS in the
// script and re-run it).

/**
 * The `font-family` values to set in the rendered markup. Quoted because Satori matches on
 * the literal family name registered below — there is no fallback stack to fall down, so a
 * typo is a blank card, not a system-sans card.
 *
 * BRAND (Oxanium) is opt-in: brand marks, plate mastheads, and every numeral/coordinate/date.
 * BODY (Space Grotesk) is the container default: titles, artist lines, labels, reading text.
 */
export const BRAND = "'Oxanium'";
export const BODY = "'Space Grotesk'";

/**
 * The `Cache-Control` every Satori render answers with, passed to `ImageResponse` via its
 * `headers` option. The cards are expensive (a WASM raster + a base64-inlined background
 * fetch) and change rarely, so the CDN holds them long — but NOT `immutable`: the log and
 * mixtape pages point at a `?v=<updatedAt>` URL, while a bare (unversioned) hit serves
 * "latest", and workers-og's own default header is `immutable, max-age=31536000`, which
 * would freeze that unversioned URL for a year. A week of s-maxage on a versioned URL is
 * effectively immutable anyway.
 */
export const OG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";

/** A font buffer in the shape workers-og's `ImageResponse` wants. */
export type OgFont = {
  data: ArrayBuffer;
  name: string;
  style: "normal";
  weight: 400 | 700 | 800;
};

type FontSpec = {
  dataUri: string;
  name: string;
  weight: 400 | 700 | 800;
};

const OXANIUM: FontSpec[] = [
  { dataUri: oxanium400, name: "Oxanium", weight: 400 },
  { dataUri: oxanium800, name: "Oxanium", weight: 800 },
];

const SPACE_GROTESK: FontSpec[] = [
  { dataUri: spaceGrotesk400, name: "Space Grotesk", weight: 400 },
  { dataUri: spaceGrotesk700, name: "Space Grotesk", weight: 700 },
];

// Decode once per isolate, not once per render: a link-preview crawler hitting a hot card
// should pay for resvg, not for base64.
const decoded = new Map<string, ArrayBuffer>();

function toFont({ dataUri, name, weight }: FontSpec): OgFont {
  const key = `${name}:${weight}`;
  const cached = decoded.get(key);

  if (cached) {
    return { data: cached, name, style: "normal", weight };
  }

  // `nodejs_compat` gives the Worker a real Buffer. Slice out the backing ArrayBuffer —
  // Buffer views can share a pooled buffer, so handing `.buffer` over raw could ship the
  // neighbouring font's bytes too.
  const buffer = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
  const data = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

  decoded.set(key, data);

  return { data, name, style: "normal", weight };
}

/**
 * Oxanium alone — the brand face. For a render that only speaks in marks and coordinates
 * (the mixtape cover: `MIXTAPE #N` + the Log ID, both legitimately Oxanium).
 */
export function brandFonts(): OgFont[] {
  return OXANIUM.map(toFont);
}

/**
 * Both faces — the full split for a card that carries reading text as well as marks: Oxanium
 * for the brand lockup and the coordinate, Space Grotesk for the title, the artist, the meta
 * line (DESIGN.md's One Voice Rule — a paragraph set in Oxanium is a mistake).
 */
export function cardFonts(): OgFont[] {
  return [...OXANIUM, ...SPACE_GROTESK].map(toFont);
}

/**
 * Make a track title / artist / label safe to drop into the HTML string Satori parses.
 *
 * ONLY `<` and `>`. This is NOT html-escaping, and escaping more is a BUG — workers-og
 * escapes text on the way OUT (it runs `escape-html` over each text node as it emits the
 * SVG) and never DECODES on the way in. So an `&amp;` we write is parsed as the five literal
 * characters `&amp;`, re-escaped to `&amp;amp;` in the SVG, and rendered as the visible text
 * "&amp;". The three cards did exactly that until this was found: every ampersand in the
 * archive — Calyx & TeeBee, Pola & Bryson, half of drum & bass — printed as `&amp;` on the
 * link preview, and every quoted title printed `&quot;`. `&`, `"` and `'` are inert to the
 * parser and correct in the output, so they go through RAW.
 *
 * `<` and `>` stay escaped: they are the only characters that can break a text node open,
 * and they cannot occur in real Spotify metadata. If one ever did, a visible `&lt;` is the
 * safe degradation — a card that renders wrong beats markup injected into the SVG.
 */
export function satoriText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
