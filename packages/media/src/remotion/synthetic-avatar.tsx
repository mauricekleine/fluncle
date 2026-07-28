import { AbsoluteFill, random, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

// <SyntheticAvatar> — a generative 600² artist portrait-SUBSTITUTE.
//
// WHY THIS EXISTS. The Decks taste picker renders a grid of artist faces, and in the
// store screenshots those faces were Spotify's own artist photography — the second half
// of the Guideline 5.2.1 rejection. This draws the tile instead: an abstract cosmos mark,
// deterministic per artist slug. NO FACES, NO PHOTOGRAPHY, no likeness of anyone. See
// docs/mobile-store-screenshots.md.
//
// A waypoint rather than a portrait: a tilted orbital system with one gold body on it and
// the artist's initials at the centre. That reads as "an act we have charted" without
// pretending to be a picture of a person.
//
// CROP-SAFE BY CONSTRUCTION. The picker masks the tile to a circle (`borderRadius: 32` on
// a 64pt square, mix-taste-picker.tsx), so every load-bearing element — the monogram, the
// gold body, the inner rings — sits inside the inscribed circle. The corners carry nothing
// but ground and grain, and are meant to be cut.
//
// Canon: Warm Dark ground, ONE Eclipse-Gold light (the single orbiting body — the rings
// themselves are cream-dust paper), Light-Years grain + scanlines, and Oxanium for the
// monogram (a MARK, which is exactly what Oxanium is for — The One Voice Rule).
//
// Determinism: everything procedural goes through Remotion's `random(seed)`.

export type SyntheticAvatarProps = {
  /** The artist's display name — the initials are derived from it. */
  name: string;
  /** The seed string — the fixture's artist slug. Same slug, same mark, forever. */
  seed: string;
};

/** A faint distant star: position (%), size (px), brightness. */
type Star = { bright: number; size: number; x: number; y: number };

function buildStarfield(seed: string, count: number): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    stars.push({
      bright: 0.12 + random(`${seed}-av-b-${index}`) * 0.34,
      size: 1 + random(`${seed}-av-s-${index}`) * 1.6,
      x: random(`${seed}-av-x-${index}`) * 100,
      y: random(`${seed}-av-y-${index}`) * 100,
    });
  }

  return stars;
}

/**
 * The monogram: the first letter of each of the first two words, uppercased. "Marrow &
 * Vane" → "MV"; "Pulsewidth" → "P". Punctuation-only words (an ampersand) are skipped, so
 * the mark reads as initials rather than as typography accident.
 */
export function monogramOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => /\p{L}/u.exec(word)?.[0] ?? "")
    .filter(Boolean);

  return letters.slice(0, 2).join("").toUpperCase();
}

export const SyntheticAvatar: React.FC<SyntheticAvatarProps> = ({ name, seed }) => {
  const { height } = useVideoConfig();
  const monogram = monogramOf(name);
  const stars = buildStarfield(seed, 54);
  // The system's tilt, and where the one gold body sits on its ring. Both seeded, so two
  // artists never get the same arrangement.
  const tilt = -34 + random(`${seed}-tilt`) * 68;
  const bodyAngle = random(`${seed}-body`) * 360;
  const ringCount = 2 + Math.floor(random(`${seed}-rings`) * 2);
  // The gold body rides the OUTERMOST ring, at 72% of the frame — comfortably inside the
  // circular crop (which cuts at 100% diameter).
  const orbitSpan = 72;
  const bodyRadius = orbitSpan / 2;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {/* Warm Dark: a warm centre falling to near-black at the edge the crop keeps. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 120% at 50% 42%, ${colors.sleeveBlack} 0%, ${colors.deepField} 60%, #060708 100%)`,
        }}
      />

      <AbsoluteFill>
        {stars.map((star, index) => (
          <div
            // Seeded field, fixed length: index keys are stable by construction.
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

      {/* The orbital system: cream-dust ellipses on one seeded tilt. Paper, not light. */}
      <AbsoluteFill style={{ transform: `rotate(${tilt}deg)` }}>
        {Array.from({ length: ringCount + 1 }, (_, index) => {
          const span = orbitSpan - index * 16;
          const squash = 0.34 + random(`${seed}-squash-${index}`) * 0.3;

          return (
            <div
              // Seeded, fixed-length geometry: index keys are stable by construction.
              // oxlint-disable-next-line no-array-index-key
              key={index}
              style={{
                borderColor: colors.starlightCream,
                borderRadius: "50%",
                borderStyle: "solid",
                // Heavy enough to survive the picker's 64pt downscale: a 2px hairline at
                // 0.2 opacity vanishes entirely once the tile is a tenth of this size.
                borderWidth: 4,
                height: `${span * squash}%`,
                left: `${50 - span / 2}%`,
                opacity: 0.3 + index * 0.09,
                position: "absolute",
                top: `${50 - (span * squash) / 2}%`,
                width: `${span}%`,
              }}
            />
          );
        })}

        {/* THE ONE SUN: a single gold body on the outermost ring, with its halo. */}
        <div
          style={{
            height: "100%",
            left: 0,
            position: "absolute",
            top: 0,
            transform: `rotate(${bodyAngle}deg)`,
            width: "100%",
          }}
        >
          <div
            style={{
              background: `radial-gradient(circle, ${colors.eclipseGlow} 0%, ${colors.eclipseGold} 52%, #c79400 100%)`,
              borderRadius: "50%",
              boxShadow: `0 0 ${Math.round(height * 0.06)}px ${Math.round(height * 0.012)}px ${colors.eclipseGold}59`,
              height: "9%",
              left: `${50 + bodyRadius - 4.5}%`,
              position: "absolute",
              top: "45.5%",
              width: "9%",
            }}
          />
        </div>
      </AbsoluteFill>

      {/* The monogram, dead centre, over a warm scrim so it clears AA on any arrangement. */}
      <AbsoluteFill style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            background: `radial-gradient(circle, ${colors.deepField}e6 0%, ${colors.deepField}b3 52%, transparent 76%)`,
            borderRadius: "50%",
            height: "50%",
            position: "absolute",
            width: "50%",
          }}
        />
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: Math.round(height * 0.24),
            fontWeight: 800,
            letterSpacing: "0.02em",
            lineHeight: 1,
            position: "relative",
            textShadow: `0 2px ${Math.round(height * 0.04)}px ${colors.deepField}`,
          }}
        >
          {monogram}
        </div>
      </AbsoluteFill>

      {/* Light-Years: scanlines + film grain over the whole mark. */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.38,
        }}
      />
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity: 0.15 }}>
        <svg height="100%" width="100%" xmlns="http://www.w3.org/2000/svg">
          <filter id={`avatar-grain-${seed}`}>
            <feTurbulence baseFrequency="0.9" numOctaves={2} seed={5} type="fractalNoise" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect filter={`url(#avatar-grain-${seed})`} height="100%" width="100%" />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
