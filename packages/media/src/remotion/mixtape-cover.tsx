import { AbsoluteFill, Img, random, staticFile, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

export type MixtapeCoverProps = {
  coordinate: string;

  markers?: boolean;

  number: string;
};

type Star = { bright: number; size: number; x: number; y: number };

const COORDINATE_STYLE: React.CSSProperties = {
  color: colors.starlightCream,
  fontFamily: OXANIUM_STACK,
  fontSize: "3.4vmin",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 400,
  letterSpacing: "0.22em",
  marginTop: "2.4vmin",
  opacity: 0.72,
  textShadow: `0 1px 14px ${colors.deepField}`,
};

const FIGURE_IN_CUTOUT = 0.46;

function buildStarfield(seed: string, count: number): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const roll = random(`${seed}-r-${index}`);

    stars.push({
      bright: (roll > 0.92 ? 0.6 : 0.18) + random(`${seed}-b-${index}`) * 0.4,
      size: (roll > 0.92 ? 2.4 : 1) + random(`${seed}-s-${index}`) * 1.4,
      x: random(`${seed}-x-${index}`) * 100,
      y: random(`${seed}-y-${index}`) * 100,
    });
  }

  return stars;
}

export const MixtapeCover: React.FC<MixtapeCoverProps> = ({
  coordinate,
  markers = true,
  number,
}) => {
  const { height } = useVideoConfig();
  const stars = buildStarfield(coordinate, 170);

  const imgSize = Math.round((height * 0.42) / FIGURE_IN_CUTOUT);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, ${colors.sleeveBlack} 0%, ${colors.deepField} 55%, #060708 100%)`,
        }}
      />

      <AbsoluteFill
        style={{
          background: `radial-gradient(46% 78% at 50% 20%, ${colors.eclipseGlow}45 0%, ${colors.eclipseGold}2e 22%, ${colors.reentryRed}12 44%, transparent 70%)`,
        }}
      />

      <AbsoluteFill>
        {stars.map((star, index) => (
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
        style={{ alignItems: "center", justifyContent: "center", paddingBottom: "18%" }}
      >
        <Img
          src={staticFile("fluncle-cosmonaut.png")}
          style={{
            filter: `drop-shadow(0 0 ${Math.round(imgSize * 0.03)}px ${colors.eclipseGold}66)`,
            height: imgSize,
            objectFit: "contain",
            width: imgSize,
          }}
        />
      </AbsoluteFill>

      {markers ? (
        <AbsoluteFill
          style={{
            alignItems: "center",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            paddingBottom: "8%",
            textAlign: "center",
          }}
        >
          <div
            style={{
              color: colors.starlightCream,
              fontFamily: OXANIUM_STACK,
              fontSize: "6.4vmin",
              fontWeight: 800,
              letterSpacing: "0.06em",
              lineHeight: 1,
              textShadow: `0 2px 22px ${colors.deepField}, 0 0 1px ${colors.deepField}`,
            }}
          >
            MIXTAPE #{number}
          </div>
          <div style={COORDINATE_STYLE}>{coordinate}</div>
        </AbsoluteFill>
      ) : null}

      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.4,
        }}
      />
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity: 0.15 }}>
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
