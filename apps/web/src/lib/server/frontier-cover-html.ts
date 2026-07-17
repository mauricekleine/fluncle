import frontierBg from "./frontier-cover-bg.jpg?inline";
import { BRAND } from "./satori-render";

// The Satori TWIN of packages/media/src/remotion/frontier-cover.tsx — the "Fluncle's
// Frontier" per-user playlist cover (E2, the public recommendation machine), built as a
// Satori HTML string so it renders IN THE WORKER at mint time (frontier-cover.ts drives the
// raster + the JPEG conversion + the upload). Remotion needs a headless Chromium and cannot
// run in a Worker; Satori — the engine already behind the OG cards (satori-render.ts) —
// renders this trivial composition (founding image + two text layers) inline.
//
// This module is PURE and dependency-light on purpose (no `workers-og`, no
// `cloudflare:workers`): it only builds the markup + carries the constants, so the
// composition can be unit-tested without the WASM raster (frontier-cover-html.test.ts), the
// satori-render.ts discipline. The heavy raster + the R2/Cloudflare-Images JPEG leg live in
// frontier-cover.ts.
//
// ── MIRRORS THE REMOTION MASTER (drift risk — keep the two in sync) ──────────
// The founding artifact full-bleed; the Legible-Sky scrim band behind the type; "FLUNCLE'S /
// FRONTIER" stacked in Oxanium 800 caps (Starlight Cream); the crew-№ chip bottom-left (Tape
// Black e6 fill, Dust Line border, Oxanium numerals). Per-user identity rides the STAMP.
//
// ── ONE DELIBERATE DEVIATION FROM THE MASTER ─────────────────────────────────
//   A SINGLE text-shadow, not the master's layered pair — Satori honours one shadow.
// The stamp is "Nº 042" — N + U+00BA (ordmasculine), both real Oxanium glyphs in the cut.
// NOT "№" (U+2116): Oxanium itself has no numero glyph (verified against the upstream
// variable font), so the Remotion master could only ever render № via a system-font
// fallback — a quiet brand break. Nº is the typographic substitute that keeps the whole
// stamp in the brand face, ratified on BOTH paths (the master mirrors it).
// FLUNCLE'S uses the real right-single-quote (U+2019), which IS in the cut (U+2000–206F);
// workers-og does not decode HTML entities on the way in, so a literal glyph is required.

/** The cover is a square, sized for Spotify's playlist art (it lives at ~64px in a list). */
export const FRONTIER_COVER_PX = 640;

/**
 * Spotify's playlist-image upload accepts a Base64-encoded JPEG ≤256KB → ~192KB of JPEG
 * bytes. The Worker asserts the transformed JPEG lands under this before it ever reaches
 * Spotify (frontier-cover.ts); a 640² quality-80 JPEG of a dark cover clears it comfortably.
 */
export const FRONTIER_COVER_MAX_JPEG_BYTES = 192 * 1024;

// The one-sun palette (packages/tokens), inlined as hex — a rendered card has no CSS vars.
// Kept verbatim in sync with `colors` in the Remotion master.
const COLOR = {
  deepField: "#090a0b",
  dustLine: "#d0b99029",
  starlightCream: "#f4ead7",
  tapeBlack: "#171611",
} as const;

/**
 * The crew-number stamp for a cover, or null when the owner has no crew number (a legacy
 * account) — in which case no chip is drawn, exactly as the Remotion master. "Nº 042": the
 * ordinal zero-padded to three digits (the master's `padStart(3, "0")`), with "Nº" the
 * all-Oxanium numero substitute shared with the master (see the header — Oxanium has no №).
 */
export function frontierCrewStamp(crewNumber: null | number | undefined): null | string {
  return typeof crewNumber === "number" && crewNumber > 0
    ? `Nº ${String(crewNumber).padStart(3, "0")}`
    : null;
}

/**
 * Build the Satori HTML for a Frontier cover. The founding image is INLINED as a bundled
 * data-URI (Satori does not fetch remote `<img>`; the OG cards inline their hero the same
 * way), so the raster needs no network. Only Oxanium is asked for — the cover speaks purely
 * in the brand mark + a numeral, so it is Oxanium throughout (the mixtape-cover precedent);
 * `frontier-cover.ts` registers `brandFonts()` to match.
 */
export function buildFrontierCoverHtml({
  crewNumber,
}: {
  crewNumber: null | number | undefined;
}): string {
  const px = FRONTIER_COVER_PX;
  const stamp = frontierCrewStamp(crewNumber);

  // The Legible-Sky scrim: a band of warm dark behind the type block only, so the eclipse and
  // the figure above it stay untouched (verbatim from the Remotion master's gradient stops).
  const scrim = `linear-gradient(180deg, transparent 34%, ${COLOR.deepField}b8 52%, ${COLOR.deepField}8c 68%, transparent 82%)`;

  return `
    <div style="position:relative;display:flex;width:${px}px;height:${px}px;background:${COLOR.deepField};overflow:hidden;">
      <img src="${frontierBg}" width="${px}" height="${px}" style="position:absolute;top:0;left:0;width:${px}px;height:${px}px;object-fit:cover;" />
      <div style="position:absolute;top:0;left:0;display:flex;width:${px}px;height:${px}px;background:${scrim};"></div>
      <div style="position:absolute;top:0;left:0;display:flex;flex-direction:column;align-items:center;justify-content:center;width:${px}px;height:${px}px;padding-top:36px;">
        <div style="display:flex;font-family:${BRAND};color:${COLOR.starlightCream};font-size:46px;font-weight:800;letter-spacing:6px;line-height:1;text-shadow:0 2px 18px ${COLOR.deepField};">FLUNCLE’S</div>
        <div style="display:flex;font-family:${BRAND};color:${COLOR.starlightCream};font-size:104px;font-weight:800;letter-spacing:2px;line-height:1.04;text-shadow:0 3px 26px ${COLOR.deepField};">FRONTIER</div>
      </div>
      ${
        stamp
          ? `<div style="position:absolute;bottom:30px;left:30px;display:flex;background:${COLOR.tapeBlack}e6;border:2px solid ${COLOR.dustLine};border-radius:10px;padding:12px 18px 13px;color:${COLOR.starlightCream};font-family:${BRAND};font-size:34px;font-weight:800;letter-spacing:3px;line-height:1;">${stamp}</div>`
          : ""
      }
    </div>
  `;
}
