import { AbsoluteFill, random } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK, SPACE_GROTESK_STACK } from "./fonts";

// <GalaxyOg> — the Open Graph / link-preview card for the /galaxy route.
//
// A gate screen in the Nostalgic Cosmos (DESIGN.md). It is the FIRST asset in
// this image package and the model for the rest: a single still, fully
// generated from code (no bitmaps but the fonts), deterministic from a seed.
//
// The canon it obeys:
//   - Warm Dark Rule — the ground is a warm near-black Deep Field, never a flat
//     cold black, and never a decorative gradient that fights the sun.
//   - One Sun Rule — Eclipse Gold is the only light. There is exactly one gold
//     source: the banger-diamond (the game's star motif, a rotated gold square
//     with a soft Eclipse-Glow halo), and it owns roughly a tenth of the frame.
//   - Light-Years Rule — grain + scanlines are ON. A clean frame reads fake, so
//     a film-grain wash and faint horizontal scanlines cover the whole card.
//   - One Voice — "FLUNCLE'S GALAXY" is the brand mark, so it is set in Oxanium
//     ALL-CAPS (VOICE.md sanctions caps for brand-mark plates). The tagline is
//     running copy in sentence case, so it is Space Grotesk, the body face, in
//     Starlight Cream — Oxanium speaks only for the brand and the numbers, never
//     for a sentence. Both faces carry the One Box metric overrides (./fonts), so
//     the mark and the tagline sit on one optical centre line.
//
// Determinism: the starfield is seeded via Remotion's random(), never
// Math.random(), so the still renders identically every time.

// Dimensions live on the <Still> in root.tsx (1200×630, the standard OG size).
const SEED = 7;

/** A faint distant star: position (%), size (px), and brightness. */
type Star = {
  bright: number;
  size: number;
  x: number;
  y: number;
};

/**
 * A quiet seeded starfield. Stars cluster away from the sun (lower-right bias
 * removed near the diamond) so the One Sun keeps the eye. Brightness stays low —
 * these are distant, not a second light source.
 */
function buildStarfield(count: number): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const x = random(`x-${index}`) * 100;
    const y = random(`y-${index}`) * 100;
    // Keep the field clear around the sun (centre, slightly high) so nothing
    // competes with the diamond's glow.
    const dx = x - 50;
    const dy = y - 42;
    const nearSun = dx * dx + dy * dy < 17 * 17;

    if (nearSun) {
      continue;
    }

    stars.push({
      bright: 0.25 + random(`b-${index}`) * 0.45,
      size: 1 + random(`s-${index}`) * 1.6,
      x,
      y,
    });
  }

  return stars;
}

const STARS = buildStarfield(110);

export const GalaxyOg: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {/* Warm Dark Rule: a gentle warm vignette over the Deep Field. Centred on
          the sun, it lifts the middle a touch and lets the corners fall to the
          warm near-black ground — no cold black, no rival gradient. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 120% at 50% 40%, ${colors.sleeveBlack} 0%, ${colors.deepField} 62%, #060708 100%)`,
        }}
      />

      {/* Distant starfield — quiet, low-brightness, cleared around the sun. */}
      <AbsoluteFill>
        {STARS.map((star, index) => (
          <div
            // The starfield is fixed and seeded, so index keys are stable.
            // oxlint-disable-next-line no-array-index-key
            key={index}
            style={{
              backgroundColor: colors.starlightCream,
              borderRadius: "50%",
              height: star.size,
              left: `${star.x}%`,
              opacity: star.bright,
              position: "absolute",
              top: `${star.y}%`,
              width: star.size,
            }}
          />
        ))}
      </AbsoluteFill>

      {/* The One Sun: the banger-diamond (the game's star motif). A soft
          Eclipse-Glow halo, then the committed Eclipse-Gold diamond — a rotated
          square with a bright glow core. This is the only gold in the frame. */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          paddingTop: 150,
        }}
      >
        <div style={{ height: 132, position: "relative", width: 132 }}>
          {/* The soft halo — the eclipse glow bleeding into the dark. */}
          <div
            style={{
              background: `radial-gradient(circle, ${colors.eclipseGlow}66 0%, ${colors.eclipseGold}26 38%, transparent 70%)`,
              borderRadius: "50%",
              inset: -120,
              position: "absolute",
            }}
          />
          {/* The diamond body — a rotated gold square. */}
          <div
            style={{
              background: `linear-gradient(135deg, ${colors.eclipseGlow} 0%, ${colors.eclipseGold} 55%, #c79400 100%)`,
              borderRadius: 10,
              boxShadow: `0 0 60px 8px ${colors.eclipseGold}59`,
              inset: 0,
              position: "absolute",
              transform: "rotate(45deg)",
            }}
          />
          {/* A hot specular core so the sun reads as a light source, not a chip. */}
          <div
            style={{
              background: `radial-gradient(circle, #fff7e0 0%, ${colors.eclipseGlow} 45%, transparent 72%)`,
              borderRadius: "50%",
              inset: 34,
              position: "absolute",
            }}
          />
        </div>
      </AbsoluteFill>

      {/* Type block: the brand mark, then the tagline. Sits below the sun so the
          eclipse stays the focus and the copy reads against the warm ground. */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          justifyContent: "flex-end",
          paddingBottom: 96,
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 78,
            fontWeight: 800,
            letterSpacing: "0.04em",
            lineHeight: 1,
            textShadow: `0 2px 28px ${colors.deepField}, 0 0 1px ${colors.deepField}`,
          }}
        >
          FLUNCLE&rsquo;S GALAXY
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: SPACE_GROTESK_STACK,
            fontSize: 30,
            fontWeight: 400,
            letterSpacing: "0.01em",
            opacity: 0.86,
            textShadow: `0 1px 16px ${colors.deepField}`,
          }}
        >
          Every banger out there is a star.
        </div>
      </AbsoluteFill>

      {/* Light-Years Rule: scanlines + film grain over the whole frame. */}
      {/* Faint horizontal scanlines — a CRT trace, kept low so it textures
          rather than stripes. */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.5,
        }}
      />
      {/* Film grain via an SVG feTurbulence wash — the system base texture. */}
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity: 0.16 }}>
        <svg height="100%" width="100%" xmlns="http://www.w3.org/2000/svg">
          <filter id="og-grain">
            <feTurbulence baseFrequency="0.9" numOctaves={2} seed={SEED} type="fractalNoise" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect filter="url(#og-grain)" height="100%" width="100%" />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
