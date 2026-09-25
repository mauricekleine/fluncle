import { AbsoluteFill, random } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK, SPACE_GROTESK_STACK } from "./fonts";

const SEED = 7;

type Star = {
  bright: number;
  size: number;
  x: number;
  y: number;
};

function buildStarfield(count: number): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const x = random(`x-${index}`) * 100;
    const y = random(`y-${index}`) * 100;

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
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 120% at 50% 40%, ${colors.sleeveBlack} 0%, ${colors.deepField} 62%, #060708 100%)`,
        }}
      />

      <AbsoluteFill>
        {STARS.map((star, index) => (
          <div
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
          <div
            style={{
              background: `radial-gradient(circle, ${colors.eclipseGlow}66 0%, ${colors.eclipseGold}26 38%, transparent 70%)`,
              borderRadius: "50%",
              inset: -120,
              position: "absolute",
            }}
          />

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

      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.5,
        }}
      />

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
