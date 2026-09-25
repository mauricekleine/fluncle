import { AbsoluteFill, Img, random, staticFile } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

export type AppIconVariant =
  | "traveler"
  | "traveler-stars"
  | "traveler-glow"
  | "adaptive-foreground"
  | "splash"
  | "eclipse"
  | "stamp"
  | "cover"
  | "diamond";

export type AppIconProps = {
  variant: AppIconVariant;
};

const SAFE_INSET = 96;

type Star = { bright: number; size: number; x: number; y: number };

function buildStarfield(seed: string, count: number, clearY: number): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    const x = random(`${seed}-x-${index}`) * 100;
    const y = random(`${seed}-y-${index}`) * 100;
    const dx = x - 50;
    const dy = y - clearY;

    if (dx * dx + dy * dy < 18 * 18) {
      continue;
    }

    stars.push({
      bright: 0.22 + random(`${seed}-b-${index}`) * 0.42,
      size: 1.4 + random(`${seed}-s-${index}`) * 2.2,
      x,
      y,
    });
  }

  return stars;
}

type Ember = { color: string; opacity: number; size: number; x: number; y: number };

function buildCorona(
  seed: string,
  count: number,
  cx: number,
  cy: number,
  innerRadius: number,
  bandWidth: number,
): Ember[] {
  const embers: Ember[] = [];

  for (let index = 0; index < count; index += 1) {
    const angle = random(`${seed}-a-${index}`) * Math.PI * 2;

    const roll = random(`${seed}-t-${index}`) ** 2;
    const radius = innerRadius + roll * bandWidth;
    const t = (radius - innerRadius) / bandWidth;

    const color = t < 0.4 ? colors.eclipseGlow : t < 0.72 ? colors.eclipseGold : colors.reentryRed;

    embers.push({
      color,
      opacity: (1 - t) * 0.85 + 0.1,
      size: 3 + random(`${seed}-s-${index}`) * (7 - t * 4),
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  }

  return embers;
}

const Grain: React.FC<{ id: string; opacity: number; seed: number }> = ({ id, opacity, seed }) => (
  <AbsoluteFill style={{ mixBlendMode: "overlay", opacity }}>
    <svg height="100%" width="100%" xmlns="http://www.w3.org/2000/svg">
      <filter id={id}>
        <feTurbulence baseFrequency="0.9" numOctaves={2} seed={seed} type="fractalNoise" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect filter={`url(#${id})`} height="100%" width="100%" />
    </svg>
  </AbsoluteFill>
);

const WarmGround: React.FC<{ sunY: number }> = ({ sunY }) => (
  <>
    <AbsoluteFill style={{ backgroundColor: colors.deepField }} />
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 120% at 50% ${sunY}%, ${colors.sleeveBlack} 0%, ${colors.deepField} 60%, #060708 100%)`,
      }}
    />
  </>
);

const Starfield: React.FC<{ stars: Star[] }> = ({ stars }) => (
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
);

const Corona: React.FC<{ embers: Ember[] }> = ({ embers }) => (
  <AbsoluteFill>
    {embers.map((ember, index) => (
      <div
        key={index}
        style={{
          backgroundColor: ember.color,
          borderRadius: "50%",
          height: ember.size,
          left: ember.x - ember.size / 2,
          opacity: ember.opacity,
          position: "absolute",
          top: ember.y - ember.size / 2,
          width: ember.size,
        }}
      />
    ))}
  </AbsoluteFill>
);

const EclipseOrb: React.FC<{ cx: number; cy: number; size: number }> = ({ cx, cy, size }) => (
  <div
    style={{
      height: size,
      left: cx - size / 2,
      position: "absolute",
      top: cy - size / 2,
      width: size,
    }}
  >
    <div
      style={{
        background: `radial-gradient(circle, ${colors.eclipseGlow}59 0%, ${colors.eclipseGold}24 42%, transparent 70%)`,
        borderRadius: "50%",
        inset: -size * 0.9,
        position: "absolute",
      }}
    />
    <div
      style={{
        background: `radial-gradient(circle at 50% 42%, ${colors.eclipseGlow} 0%, ${colors.eclipseGold} 52%, #c79400 100%)`,
        borderRadius: "50%",
        boxShadow: `0 0 ${size * 0.5}px ${size * 0.08}px ${colors.eclipseGold}4d`,
        inset: 0,
        position: "absolute",
      }}
    />
    <div
      style={{
        background: `radial-gradient(circle, #fff7e0 0%, ${colors.eclipseGlow} 46%, transparent 72%)`,
        borderRadius: "50%",
        inset: size * 0.26,
        position: "absolute",
      }}
    />
  </div>
);

const FIGURE_CANVAS = 1180;
const FIGURE_BOX = { height: 488, left: 405, top: 363, width: 398 } as const;

const Traveler: React.FC<{ heightFrac: number }> = ({ heightFrac }) => {
  const scale = (1024 * heightFrac) / FIGURE_BOX.height;
  const size = FIGURE_CANVAS * scale;
  const figureCx = FIGURE_BOX.left + FIGURE_BOX.width / 2;
  const figureCy = FIGURE_BOX.top + FIGURE_BOX.height / 2;

  return (
    <Img
      src={staticFile("fluncle-cosmonaut.png")}
      style={{
        height: size,
        left: 512 - figureCx * scale,
        position: "absolute",
        top: 512 - figureCy * scale,
        width: size,
      }}
    />
  );
};

const TRAVELER_HEIGHT_FRAC = 0.72;

const TravelerVariant: React.FC = () => (
  <>
    <WarmGround sunY={50} />
    <Traveler heightFrac={TRAVELER_HEIGHT_FRAC} />
    <Grain id="icon-traveler-grain" opacity={0.09} seed={5} />
  </>
);

const TravelerStarsVariant: React.FC = () => {
  const stars: Star[] = [];

  for (let index = 0; index < 90; index += 1) {
    const roll = random(`traveler-stars-r-${index}`);

    stars.push({
      bright: (roll > 0.9 ? 0.55 : 0.16) + random(`traveler-stars-b-${index}`) * 0.3,
      size: (roll > 0.9 ? 3.4 : 1.6) + random(`traveler-stars-s-${index}`) * 1.6,
      x: random(`traveler-stars-x-${index}`) * 100,
      y: random(`traveler-stars-y-${index}`) * 100,
    });
  }

  return (
    <>
      <WarmGround sunY={50} />
      <Starfield stars={stars} />
      <Traveler heightFrac={TRAVELER_HEIGHT_FRAC} />
      <Grain id="icon-traveler-stars-grain" opacity={0.09} seed={6} />
    </>
  );
};

const TravelerGlowVariant: React.FC = () => (
  <>
    <WarmGround sunY={44} />

    <AbsoluteFill
      style={{
        background: `radial-gradient(42% 42% at 50% 44%, ${colors.eclipseGlow}30 0%, ${colors.eclipseGold}1f 34%, ${colors.reentryRed}0d 58%, transparent 76%)`,
      }}
    />
    <Traveler heightFrac={TRAVELER_HEIGHT_FRAC} />
    <Grain id="icon-traveler-glow-grain" opacity={0.09} seed={4} />
  </>
);

const AdaptiveForegroundVariant: React.FC = () => <Traveler heightFrac={0.58} />;

const SplashVariant: React.FC = () => {
  const stars: Star[] = [];

  for (let index = 0; index < 110; index += 1) {
    const roll = random(`splash-r-${index}`);
    const x = random(`splash-x-${index}`) * 100;
    const y = random(`splash-y-${index}`) * 100;

    const distance = Math.hypot(x - 50, y - 50);
    const falloff = Math.min(1, Math.max(0, (47 - distance) / 17));

    if (falloff <= 0) {
      continue;
    }

    stars.push({
      bright: ((roll > 0.9 ? 0.55 : 0.16) + random(`splash-b-${index}`) * 0.3) * falloff,
      size: (roll > 0.9 ? 3.4 : 1.6) + random(`splash-s-${index}`) * 1.6,
      x,
      y,
    });
  }

  return (
    <>
      <Starfield stars={stars} />
      <Traveler heightFrac={0.46} />
    </>
  );
};

const EclipseVariant: React.FC = () => {
  const cx = 512;
  const cy = 512;

  return (
    <>
      <WarmGround sunY={50} />
      <Starfield stars={buildStarfield("eclipse", 60, 50)} />
      <Corona embers={buildCorona("eclipse", 320, cx, cy, 190, 150)} />
      <EclipseOrb cx={cx} cy={cy} size={300} />
      <Grain id="icon-eclipse-grain" opacity={0.1} seed={7} />
    </>
  );
};

const StampVariant: React.FC = () => {
  const frame = SAFE_INSET + 40;
  const tick = 46;

  return (
    <>
      <WarmGround sunY={30} />

      <AbsoluteFill
        style={{
          background: `radial-gradient(70% 55% at 50% 8%, ${colors.eclipseGold}1f 0%, transparent 60%)`,
        }}
      />

      <div
        style={{
          border: `2px solid ${colors.dustLine}`,
          borderRadius: 6,
          inset: frame,
          position: "absolute",
        }}
      />
      <div
        style={{
          border: `1px solid ${colors.dustVeil}`,
          borderRadius: 4,
          inset: frame + 14,
          position: "absolute",
        }}
      />

      {[
        [frame - 22, frame - 22, false],
        [1024 - frame - tick + 22, frame - 22, false],
        [frame - 22, 1024 - frame - tick + 22, false],
        [1024 - frame - tick + 22, 1024 - frame - tick + 22, false],
      ].map(([left, top], index) => (
        <div
          key={index}
          style={{
            height: tick,
            left: Number(left),
            position: "absolute",
            top: Number(top),
            width: tick,
          }}
        >
          <div
            style={{
              background: colors.dustLine,
              height: 2,
              left: 0,
              position: "absolute",
              top: tick / 2,
              width: tick,
            }}
          />
          <div
            style={{
              background: colors.dustLine,
              height: tick,
              left: tick / 2,
              position: "absolute",
              top: 0,
              width: 2,
            }}
          />
        </div>
      ))}

      <div style={{ height: 40, left: 512 - 20, position: "absolute", top: frame + 26, width: 40 }}>
        <div
          style={{
            background: colors.dustLine,
            height: 1.5,
            left: 0,
            position: "absolute",
            top: 20,
            width: 40,
          }}
        />
        <div
          style={{
            background: colors.dustLine,
            height: 40,
            left: 20,
            position: "absolute",
            top: 0,
            width: 1.5,
          }}
        />
      </div>

      <AbsoluteFill style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            background: `radial-gradient(circle, ${colors.eclipseGold}2e 0%, transparent 62%)`,
            borderRadius: "50%",
            height: 620,
            position: "absolute",
            width: 620,
          }}
        />
        <div
          style={{
            color: colors.eclipseGold,
            fontFamily: OXANIUM_STACK,
            fontSize: 620,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            lineHeight: 1,
            textShadow: `0 0 60px ${colors.eclipseGold}59, 0 6px 30px ${colors.deepField}`,
          }}
        >
          F
        </div>
      </AbsoluteFill>

      <Grain id="icon-stamp-grain" opacity={0.11} seed={11} />
    </>
  );
};

const CoverVariant: React.FC = () => {
  const cx = 512;
  const sunY = 300;

  return (
    <>
      <AbsoluteFill style={{ backgroundColor: colors.deepField }} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(80% 62% at 50% 22%, ${colors.eclipseGold}22 0%, ${colors.reentryRed}12 30%, ${colors.deepField} 60%, #060708 100%)`,
        }}
      />
      <Starfield stars={buildStarfield("cover", 120, 30)} />
      <Corona embers={buildCorona("cover", 360, cx, sunY, 150, 210)} />
      <EclipseOrb cx={cx} cy={sunY} size={210} />

      <AbsoluteFill style={{ alignItems: "flex-end", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            alignItems: "flex-end",
            display: "flex",
            gap: 10,
            height: 300,
            width: 1024 - SAFE_INSET * 2,
          }}
        >
          {Array.from({ length: 9 }, (_, index) => {
            const h = 120 + random(`tower-h-${index}`) * 170;
            const lit = random(`tower-l-${index}`) > 0.45;

            return (
              <div
                key={index}
                style={{
                  background: colors.sleeveBlack,
                  borderTop: `1px solid ${colors.dustVeil}`,
                  flex: 1,
                  height: h,
                  position: "relative",
                }}
              >
                {lit ? (
                  <div
                    style={{
                      background: colors.eclipseGold,
                      borderRadius: 1,
                      height: 5,
                      left: "30%",
                      opacity: 0.5,
                      position: "absolute",
                      top: 24,
                      width: 5,
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 3px, ${colors.deepField}40 4px, ${colors.deepField}40 4px)`,
          mixBlendMode: "multiply",
          opacity: 0.5,
        }}
      />
      <Grain id="icon-cover-grain" opacity={0.17} seed={3} />
    </>
  );
};

const DiamondVariant: React.FC = () => {
  const size = 340;

  return (
    <>
      <WarmGround sunY={50} />
      <Starfield stars={buildStarfield("diamond", 70, 50)} />

      <AbsoluteFill style={{ alignItems: "center", display: "flex", justifyContent: "center" }}>
        <div style={{ height: size, position: "relative", width: size }}>
          <div
            style={{
              background: `radial-gradient(circle, ${colors.eclipseGlow}59 0%, ${colors.eclipseGold}24 40%, transparent 70%)`,
              borderRadius: "50%",
              inset: -size * 0.85,
              position: "absolute",
            }}
          />
          <div
            style={{
              background: `linear-gradient(135deg, ${colors.eclipseGlow} 0%, ${colors.eclipseGold} 55%, #c79400 100%)`,
              borderRadius: 26,
              boxShadow: `0 0 ${size * 0.45}px ${size * 0.06}px ${colors.eclipseGold}4d`,
              inset: 0,
              position: "absolute",
              transform: "rotate(45deg)",
            }}
          />
          <div
            style={{
              background: `radial-gradient(circle, #fff7e0 0%, ${colors.eclipseGlow} 45%, transparent 72%)`,
              borderRadius: "50%",
              inset: size * 0.3,
              position: "absolute",
            }}
          />
        </div>
      </AbsoluteFill>

      <Grain id="icon-diamond-grain" opacity={0.1} seed={9} />
    </>
  );
};

const VARIANTS: Record<AppIconVariant, React.FC> = {
  "adaptive-foreground": AdaptiveForegroundVariant,
  cover: CoverVariant,
  diamond: DiamondVariant,
  eclipse: EclipseVariant,
  splash: SplashVariant,
  stamp: StampVariant,
  traveler: TravelerVariant,
  "traveler-glow": TravelerGlowVariant,
  "traveler-stars": TravelerStarsVariant,
};

const TRANSPARENT_VARIANTS: ReadonlySet<AppIconVariant> = new Set([
  "adaptive-foreground",
  "splash",
]);

export const AppIcon: React.FC<AppIconProps> = ({ variant }) => {
  const Variant = VARIANTS[variant];
  const transparent = TRANSPARENT_VARIANTS.has(variant);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: transparent ? "transparent" : colors.deepField,
        overflow: "hidden",
      }}
    >
      <Variant />
    </AbsoluteFill>
  );
};
