import { AbsoluteFill, random } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK, SPACE_GROTESK_STACK } from "./fonts";

// <FrontierCover> — the per-user cover for a "Fluncle's Frontier" playlist (E2, the
// public recommendation machine). Rendered NODE-SIDE (Remotion needs a real headless
// Chromium; it does not run in a Cloudflare Worker) at 640×640 and uploaded to Spotify
// by the cover script (apps/web/scripts/render-frontier-covers.ts).
//
// A quiet gate screen in the Nostalgic Cosmos (DESIGN.md), the sibling of the Galaxy OG
// card — the SAME visual language (Deep Field ground, one Eclipse-Gold sun, a seeded
// starfield, the grain + scanline wash) so a crew member's cover reads as part of the
// same universe. The two differences that make it a per-user artifact:
//   - the brand plate reads "FLUNCLE'S FRONTIER" (Oxanium caps — a brand-mark plate);
//   - the crew № is stamped small in the bottom-right corner (Oxanium, Starlight Cream —
//     numerals are always Oxanium, VOICE.md), so each cover carries its owner's place on
//     the manifest.
//
// The canon it obeys: Warm Dark (the ground is a warm near-black, never a flat cold
// black), One Sun (Eclipse Gold is the only light — one diamond), Light-Years (grain +
// scanlines always on). Determinism: the starfield is seeded off the crew № via
// Remotion's random(), never Math.random(), so a given crew member's cover renders
// identically every time AND differs from the next member's.

export type FrontierCoverProps = {
  // The owner's enlistment ordinal (stamped in the corner). Null/absent ⇒ no stamp (a
  // legacy account created before the crew number existed).
  crewNumber?: null | number;
};

/** A faint distant star: position (%), size (px), and brightness. */
type Star = {
  bright: number;
  size: number;
  x: number;
  y: number;
};

/** A quiet seeded starfield, cleared around the sun so nothing competes with the diamond. */
function buildStarfield(count: number, seed: string): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const x = random(`${seed}-x-${index}`) * 100;
    const y = random(`${seed}-y-${index}`) * 100;
    const dx = x - 50;
    const dy = y - 38;

    if (dx * dx + dy * dy < 16 * 16) {
      continue;
    }

    stars.push({
      bright: 0.22 + random(`${seed}-b-${index}`) * 0.42,
      size: 1 + random(`${seed}-s-${index}`) * 1.5,
      x,
      y,
    });
  }

  return stars;
}

export const FrontierCover: React.FC<FrontierCoverProps> = ({ crewNumber }) => {
  const seed = `frontier-${crewNumber ?? "x"}`;
  const stars = buildStarfield(90, seed);
  const stamp =
    typeof crewNumber === "number" && crewNumber > 0
      ? `№ ${String(crewNumber).padStart(3, "0")}`
      : null;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {/* Warm Dark Rule: a gentle warm vignette over the Deep Field, centred on the sun. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 120% at 50% 36%, ${colors.sleeveBlack} 0%, ${colors.deepField} 60%, #060708 100%)`,
        }}
      />

      {/* Distant starfield — quiet, low-brightness, cleared around the sun. */}
      <AbsoluteFill>
        {stars.map((star, index) => (
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

      {/* The One Sun: the banger-diamond. A soft Eclipse-Glow halo, then the committed
          Eclipse-Gold diamond with a hot specular core. The only gold in the frame. */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          paddingTop: 150,
        }}
      >
        <div style={{ height: 96, position: "relative", width: 96 }}>
          <div
            style={{
              background: `radial-gradient(circle, ${colors.eclipseGlow}66 0%, ${colors.eclipseGold}26 38%, transparent 70%)`,
              borderRadius: "50%",
              inset: -90,
              position: "absolute",
            }}
          />
          <div
            style={{
              background: `linear-gradient(135deg, ${colors.eclipseGlow} 0%, ${colors.eclipseGold} 55%, #c79400 100%)`,
              borderRadius: 8,
              boxShadow: `0 0 44px 6px ${colors.eclipseGold}59`,
              inset: 0,
              position: "absolute",
              transform: "rotate(45deg)",
            }}
          />
          <div
            style={{
              background: `radial-gradient(circle, #fff7e0 0%, ${colors.eclipseGlow} 45%, transparent 72%)`,
              borderRadius: "50%",
              inset: 26,
              position: "absolute",
            }}
          />
        </div>
      </AbsoluteFill>

      {/* Type block: the brand plate, then a quiet line of running copy. Below the sun so
          the eclipse stays the focus. */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          justifyContent: "flex-end",
          paddingBottom: 92,
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 52,
            fontWeight: 800,
            letterSpacing: "0.05em",
            lineHeight: 1,
            textShadow: `0 2px 22px ${colors.deepField}, 0 0 1px ${colors.deepField}`,
          }}
        >
          FLUNCLE&rsquo;S FRONTIER
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: SPACE_GROTESK_STACK,
            fontSize: 21,
            fontWeight: 400,
            letterSpacing: "0.01em",
            opacity: 0.82,
            textShadow: `0 1px 12px ${colors.deepField}`,
          }}
        >
          Dug from the far side of the archive.
        </div>
      </AbsoluteFill>

      {/* The crew № stamp — small, bottom-right, Oxanium numerals in Starlight Cream. */}
      {stamp ? (
        <div
          style={{
            bottom: 28,
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "0.06em",
            opacity: 0.7,
            position: "absolute",
            right: 30,
            textShadow: `0 1px 10px ${colors.deepField}`,
          }}
        >
          {stamp}
        </div>
      ) : null}

      {/* Light-Years Rule: scanlines + film grain over the whole frame. */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.5,
        }}
      />
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity: 0.15 }}>
        <svg height="100%" width="100%" xmlns="http://www.w3.org/2000/svg">
          <filter id="frontier-grain">
            <feTurbulence baseFrequency="0.9" numOctaves={2} seed={7} type="fractalNoise" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect filter="url(#frontier-grain)" height="100%" width="100%" />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
