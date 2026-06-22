import { AbsoluteFill, Img, random, staticFile, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

// <MixtapeCover> — cover art for a Fluncle mixtape (a checkpoint / "Fluncle
// dreaming"; see packages/skills/fluncle-mixtapes). One code-generated still,
// parametrized by the mixtape number and its Log ID coordinate, rendered at three
// aspect ratios from this one component (mixtape-cover-specs.ts): square for
// Mixcloud / SoundCloud + the /log coverImageUrl, 16:9 for the YouTube thumbnail,
// and 1200×630 for the /log OG card.
//
// Reuses the founding hero — the lone cosmonaut (public/fluncle-cosmonaut.png,
// Maurice's own artwork) on a warm Deep Field cosmos, exactly like the social
// banners (cosmos-banner.tsx) — and adds only the two markers that make this
// mixtape unique: "MIXTAPE #N" and its coordinate. Canon: Warm Dark ground, One
// Sun (the single warm eclipse glow), Light-Years grain + scanlines, One Voice
// (Oxanium caps for the marks). The starfield is seeded by the coordinate, so each
// mixtape's field differs but renders reproducibly.

export type MixtapeCoverProps = {
  /** The Log ID coordinate, e.g. "019.F.1A". Also seeds the starfield. */
  coordinate: string;
  /**
   * Draw the "MIXTAPE #N" + coordinate markers. Default true for Studio preview
   * and the legacy full-cover render; the on-the-fly cover endpoint bakes the
   * background with `markers: false` and stamps the text in Satori instead
   * (apps/web/src/routes/api/mixtape-cover.$logId.ts).
   */
  markers?: boolean;
  /** The mixtape sequence number, e.g. "1". */
  number: string;
};

type Star = { bright: number; size: number; x: number; y: number };

// Static style for the coordinate marker — hoisted so its object identity is
// stable across renders (all properties are constant, none per-render).
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

// The cosmonaut fills ~46% of the height of its square cutout (the rest is
// transparent margin); scale so the visible figure hits the target height.
const FIGURE_IN_CUTOUT = 0.46;

/** A quiet seeded starfield with the odd brighter punctuation, seeded by coordinate. */
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
  // The figure fills ~42% of the frame height, leaving the lower band for the
  // markers (which sit over the cutout's transparent margin, not the figure).
  const imgSize = Math.round((height * 0.42) / FIGURE_IN_CUTOUT);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      {/* Warm Dark: a gentle vertical wash, warmer up top toward the sun. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, ${colors.sleeveBlack} 0%, ${colors.deepField} 55%, #060708 100%)`,
        }}
      />
      {/* One Sun: a single large warm eclipse glow (gold → orange → a breath of
          re-entry red), the only light in the frame. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(46% 78% at 50% 20%, ${colors.eclipseGlow}45 0%, ${colors.eclipseGold}2e 22%, ${colors.reentryRed}12 44%, transparent 70%)`,
        }}
      />

      {/* Seeded starfield. */}
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

      {/* The cosmonaut — the hero, centred and lifted so the lower band is free
          for the markers; a soft gold glow seats it against the dark. */}
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

      {/* The two markers — the only thing that makes this cover unique. Skipped
          when baking the shared background; the cover endpoint stamps them in Satori. */}
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

      {/* Light-Years: faint scanlines + a film-grain wash over the frame. */}
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
