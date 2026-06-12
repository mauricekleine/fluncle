import { AbsoluteFill, Img, random, staticFile, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";

// <CosmosBanner> — the floating-cosmonaut banner / cover for Fluncle's social
// profiles (YouTube, Mixcloud, …). Fluncle's hero image is the lone cosmonaut
// (public/fluncle-cosmonaut.png — Maurice's own artwork): the traveller drifting
// through space, his consciousness lifted by the bangers. The platform shows the
// channel name as text, so the banner stays WORDLESS — just the figure against a
// warm Deep Field cosmos. (The FLUNCLE wordmark lives on the cover art, not here;
// the cover art is the wordmark surface, the cosmonaut is the avatar/banner one.)
//
// Canon: Warm Dark (a warm near-black ground, never cold), One Sun (a single warm
// Eclipse-Gold sun, the only light), Light-Years (grain + faint scanlines always
// on). The cosmonaut cutout is a sanctioned bitmap alongside the fonts — the
// founding image, not something to re-draw in code.
//
// The safe-area contract: platforms crop a banner differently across devices.
// `safe` is the centred box always shown; the figure is sized off its height so
// the hard mobile crop still catches it, while the cosmos bleeds to the edges.
// The starfield is seeded via Remotion's random() (never Math.random()), so a
// render is byte-reproducible.

export type CosmosBannerProps = {
  /** Centered always-visible box (px); the figure is sized off its height. */
  safe?: { width: number; height: number };
  /** Cosmonaut figure height as a fraction of the safe-box (or frame) height. */
  figure?: number;
  /** Grain seed (stable per composition). */
  seed?: number;
};

type Star = { bright: number; size: number; x: number; y: number };

// The sun anchor (fraction of frame) — upper, where the warm Eclipse glow sits;
// the cosmonaut drifts up toward it.
const SUN_X = 50;
const SUN_Y = 20;

// The cosmonaut fills ~46% of the height of its 1180² cutout (the rest is
// transparent margin); scale the whole image up to hit the target figure height.
const FIGURE_IN_CUTOUT = 0.46;

function buildStarfield(count: number, prefix: string): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const roll = random(`${prefix}-r-${index}`);

    stars.push({
      // A few brighter, larger stars punctuate the quiet field.
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
      {/* Warm Dark: a gentle vertical wash, warmer up top toward the sun. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, ${colors.sleeveBlack} 0%, ${colors.deepField} 55%, #060708 100%)`,
        }}
      />
      {/* One Sun — a single large, warm eclipse glow (gold → orange → a breath of
          re-entry red at the rim), the only light in the frame. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(46% 78% at ${SUN_X}% ${SUN_Y}%, ${colors.eclipseGlow}45 0%, ${colors.eclipseGold}2e 22%, ${colors.reentryRed}12 44%, transparent 70%)`,
        }}
      />

      {/* Distant starfield — quiet, with the odd brighter punctuation. */}
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

      {/* The cosmonaut — the hero, centred so the hard mobile crop still catches
          it; a soft gold glow seats it against the dark. */}
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

      {/* Light-Years Rule: faint scanlines + a film-grain wash over the frame. */}
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
