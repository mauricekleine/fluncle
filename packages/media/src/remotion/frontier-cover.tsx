import { AbsoluteFill, Img, staticFile } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

// <FrontierCover> — the per-user cover for a "Fluncle's Frontier" playlist (E2, the
// public recommendation machine), rendered at 640×640.
//
// ── THIS IS THE DESIGN MASTER, NOT THE SHIPPING PATH ─────────────────────────
// The cover that actually lands on Spotify is now rendered IN THE WORKER, at mint time,
// by a Satori TWIN of this composition: apps/web/src/lib/server/frontier-cover-html.ts
// (`buildFrontierCoverHtml`) + frontier-cover.ts. Remotion needs a real headless Chromium
// and cannot run in a Cloudflare Worker, so a Remotion render could only ever be an
// operator/box pass — and rave-03 is a scale-to-zero ephemeral render box, so there is no
// durable place to run it on a per-mint cadence. Satori (the same engine behind the OG
// cards) renders this trivial composition — the founding image + two text layers — inline.
//
// THIS FILE STAYS as the visual source of record: it is the reference the twin is checked
// against. DRIFT RISK — the two are hand-kept in sync. If you change the plate, the scrim,
// the stamp, or the palette HERE, mirror it in the Satori twin (and its test), and vice
// versa. One known, deliberate deviation in the twin (documented there): Satori honours a
// single text-shadow, not the layered pair below. The stamp is "Nº" (N + U+00BA) on BOTH
// paths — Oxanium has no № glyph (U+2116), so a literal № could only ever render in a
// system-font fallback here (a quiet brand break) and as .notdef in the Worker; Nº keeps
// the whole stamp in the brand face everywhere.
//
// THE ART IS THE FOUNDING IMAGE. The ground is the original cover painting (the
// no-text master, `fluncle-cover-no-text.png`): the floating figure, the burning
// eclipse, the tower blocks, the Discman — the image every visual in the system
// descends from (DESIGN.md §1). No invented sun, no synthetic starfield: the operator
// ruled the v1 diamond off the board (2026-07-17) — we own the real artifact, use it.
//
// TWO overlays only, both sized for the SPOTIFY THUMBNAIL (a cover spends its life at
// ~64px in a library list, so every glyph must survive that):
//   - the brand plate: "FLUNCLE'S / FRONTIER" stacked, Oxanium 800 caps in Starlight
//     Cream over a quiet scrim (The Legible Sky Rule — the pane dims, the text never
//     thins). No tagline: running copy is illegible at list size and Spotify's own
//     title line sits right next to the art.
//   - the crew № stamp: bottom-left (the Discman owns the bottom-right), a Tape-Black
//     chip with a Dust-Line edge, Oxanium numerals — bigger and higher-contrast than
//     v1, per the same ruling. Null crewNumber (a legacy account) ⇒ no chip.
//
// Per-user identity therefore rides the STAMP, not the scene — every crew member holds
// the same founding artifact with their own number on it, which is the point.

export type FrontierCoverProps = {
  // The owner's enlistment ordinal (stamped in the corner). Null/absent ⇒ no stamp (a
  // legacy account created before the crew number existed).
  crewNumber?: null | number;
};

export const FrontierCover: React.FC<FrontierCoverProps> = ({ crewNumber }) => {
  const stamp =
    typeof crewNumber === "number" && crewNumber > 0
      ? `Nº ${String(crewNumber).padStart(3, "0")}`
      : null;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {/* The founding artifact, full bleed (1254² master → 640² frame). */}
      <Img
        src={staticFile("fluncle-cover-no-text.png")}
        style={{ height: "100%", objectFit: "cover", width: "100%" }}
      />

      {/* The Legible Sky scrim: a band of warm dark behind the type block only — the
          eclipse and the figure stay untouched above it. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, transparent 34%, ${colors.deepField}b8 52%, ${colors.deepField}8c 68%, transparent 82%)`,
        }}
      />

      {/* The brand plate — stacked so FRONTIER carries the thumbnail. */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          paddingTop: 36,
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 46,
            fontWeight: 800,
            letterSpacing: "0.14em",
            lineHeight: 1,
            textShadow: `0 2px 18px ${colors.deepField}, 0 0 2px ${colors.deepField}`,
          }}
        >
          FLUNCLE&rsquo;S
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 104,
            fontWeight: 800,
            letterSpacing: "0.015em",
            lineHeight: 1.04,
            textShadow: `0 3px 26px ${colors.deepField}, 0 0 2px ${colors.deepField}`,
          }}
        >
          FRONTIER
        </div>
      </AbsoluteFill>

      {/* The crew № stamp — a printed chip, bottom-left (the Discman owns the right).
          Bigger + full-contrast per the operator's v1 ruling: the stamp is the cover's
          per-user identity, it must read in the library list. */}
      {stamp ? (
        <div
          style={{
            backgroundColor: `${colors.tapeBlack}e6`,
            border: `2px solid ${colors.dustLine}`,
            borderRadius: 10,
            bottom: 30,
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 34,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 800,
            left: 30,
            letterSpacing: "0.08em",
            lineHeight: 1,
            padding: "12px 18px 13px",
            position: "absolute",
          }}
        >
          {stamp}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
