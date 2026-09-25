import { AbsoluteFill, Img, random, staticFile, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";

export type CosmosBannerProps = {
  safe?: { width: number; height: number };

  figure?: number;

  seed?: number;
};

type Star = { bright: number; size: number; x: number; y: number };

const SUN_X = 50;
const SUN_Y = 20;

const FIGURE_IN_CUTOUT = 0.46;

function buildStarfield(count: number, prefix: string): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const roll = random(`${prefix}-r-${index}`);

    stars.push({
      bright: (roll > 0.92 ? 0.6 : 0.18) + random(`${prefix}-b-${index}`) * 0.4,
      size: (roll > 0.92 ? 2.4 : 1) + random(`${prefix}-s-${index}`) * 1.4,
      x: random(`${prefix}-x-${index}`) * 100,
      y: random(`${prefix}-y-${index}`) * 100,
    });
  }

  return stars;
}

export const CosmosBanner: React.FC<CosmosBannerProps> = ({ figure = 1, safe, seed = 7 }) => {
  const { height, width } = useVideoConfig();
  const box = safe ?? { height, width };
  const stars = buildStarfield(190, `bn-${width}x${height}`);
  const imgSize = Math.round((box.height * figure) / FIGURE_IN_CUTOUT);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, ${colors.sleeveBlack} 0%, ${colors.deepField} 55%, #060708 100%)`,
        }}
      />

      <AbsoluteFill
        style={{
          background: `radial-gradient(46% 78% at ${SUN_X}% ${SUN_Y}%, ${colors.eclipseGlow}45 0%, ${colors.eclipseGold}2e 22%, ${colors.reentryRed}12 44%, transparent 70%)`,
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

      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
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

      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.4,
        }}
      />
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity: 0.15 }}>
        <svg height="100%" width="100%" xmlns="http://www.w3.org/2000/svg">
          <filter id={`banner-grain-${seed}`}>
            <feTurbulence baseFrequency="0.9" numOctaves={2} seed={seed} type="fractalNoise" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect filter={`url(#banner-grain-${seed})`} height="100%" width="100%" />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
