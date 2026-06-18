import { AbsoluteFill, random } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

// <MixtapeCover> — cover art for a Fluncle mixtape (a checkpoint / "Fluncle
// dreaming"; see docs/fluncle-mixtapes-runbook.md). One code-generated still,
// parametrized by the mixtape number and its Log ID coordinate, rendered at three
// aspect ratios from this one component (mixtape-cover-specs.ts): square for
// Mixcloud / SoundCloud + the /log coverImageUrl, 16:9 for the YouTube thumbnail,
// and 1200×630 for the /log OG card. Sizes use vmin so the centred composition
// holds across all three.
//
// Canon (same as galaxy-og.tsx): Warm Dark ground, One Sun (a single Eclipse-Gold
// source — the eclipse; the type stays cream), Light-Years grain + scanlines, One
// Voice (Oxanium caps for the brand marks). Checkpoint register: deeper out, a
// still point — quiet, the coordinate the only loud-to-insiders tell.
//
// SCAFFOLD: a clean canon-correct starting point. Iterate the art with the
// fluncle-video kit (e.g. drop the cosmonaut figure in over the eclipse).

export type MixtapeCoverProps = {
  /** The Log ID coordinate, e.g. "019.F.1A". Also seeds the starfield. */
  coordinate: string;
  /** The mixtape sequence number, e.g. "1". */
  number: string;
};

type Star = { bright: number; size: number; x: number; y: number };

/** A quiet seeded starfield, cleared around the centred sun, seeded by coordinate. */
function buildStarfield(seed: string, count: number): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const x = random(`${seed}-x-${index}`) * 100;
    const y = random(`${seed}-y-${index}`) * 100;
    const dx = x - 50;
    const dy = y - 50;

    if (dx * dx + dy * dy < 15 * 15) {
      continue;
    }

    stars.push({
      bright: 0.2 + random(`${seed}-b-${index}`) * 0.4,
      size: 1 + random(`${seed}-s-${index}`) * 1.8,
      x,
      y,
    });
  }

  return stars;
}

export const MixtapeCover: React.FC<MixtapeCoverProps> = ({ coordinate, number }) => {
  const stars = buildStarfield(coordinate, 140);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {/* Warm Dark: a gentle warm vignette, centred, corners falling to near-black. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 120% at 50% 46%, ${colors.sleeveBlack} 0%, ${colors.deepField} 60%, #050607 100%)`,
        }}
      />

      {/* Seeded starfield — quiet, deeper out. */}
      <AbsoluteFill>
        {stars.map((star, index) => (
          <div
            // deterministic seeded field; stable index keys
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

      {/* The One Sun: the eclipse, centred behind the type — the only gold source. */}
      <AbsoluteFill style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
        <div style={{ height: "30vmin", position: "relative", width: "30vmin" }}>
          <div
            style={{
              background: `radial-gradient(circle, ${colors.eclipseGlow}59 0%, ${colors.eclipseGold}22 40%, transparent 70%)`,
              borderRadius: "50%",
              inset: "-90%",
              position: "absolute",
            }}
          />
          <div
            style={{
              background: `linear-gradient(135deg, ${colors.eclipseGlow} 0%, ${colors.eclipseGold} 55%, #c79400 100%)`,
              borderRadius: "8%",
              boxShadow: `0 0 8vmin 1vmin ${colors.eclipseGold}4d`,
              inset: 0,
              position: "absolute",
              transform: "rotate(45deg)",
            }}
          />
          <div
            style={{
              background: `radial-gradient(circle, #fff7e0 0%, ${colors.eclipseGlow} 45%, transparent 72%)`,
              borderRadius: "50%",
              inset: "26%",
              position: "absolute",
            }}
          />
        </div>
      </AbsoluteFill>

      {/* Type: the brand plate, the mixtape number, the coordinate. Cream only —
          the eclipse keeps the One Sun budget. */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: "3vmin",
            fontWeight: 800,
            letterSpacing: "0.32em",
            marginBottom: "4vmin",
            opacity: 0.74,
            textShadow: `0 1px 12px ${colors.deepField}`,
          }}
        >
          FLUNCLE&rsquo;S FINDINGS
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: "13vmin",
            fontWeight: 800,
            letterSpacing: "0.02em",
            lineHeight: 0.95,
            textShadow: `0 2px 24px ${colors.deepField}, 0 0 1px ${colors.deepField}`,
          }}
        >
          MIXTAPE
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: "8vmin",
            fontWeight: 800,
            letterSpacing: "0.02em",
            lineHeight: 1,
            marginTop: "1vmin",
            textShadow: `0 2px 20px ${colors.deepField}`,
          }}
        >
          No.&nbsp;{number}
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: "3.4vmin",
            fontVariantNumeric: "tabular-nums",
            fontWeight: 400,
            letterSpacing: "0.18em",
            marginTop: "6vmin",
            opacity: 0.78,
          }}
        >
          {coordinate}
        </div>
      </AbsoluteFill>

      {/* Light-Years: scanlines + film grain over the whole frame. */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.5,
        }}
      />
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity: 0.16 }}>
        <svg height="100%" width="100%" xmlns="http://www.w3.org/2000/svg">
          <filter id="mixtape-grain">
            <feTurbulence baseFrequency="0.9" numOctaves={2} seed={3} type="fractalNoise" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect filter="url(#mixtape-grain)" height="100%" width="100%" />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
