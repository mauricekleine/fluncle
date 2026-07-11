import { AbsoluteFill, random } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

// <AppIcon> — candidate app icons for the Fluncle mobile app (apps/mobile).
//
// A single code-generated still (1024×1024, the iOS/Android master size),
// parametrized by `variant` so one composition renders every candidate. The icon
// must read as THE Fluncle mark at ~60px on a phone grid, so each variant is a
// SIMPLE, warm-dark form with gold placed only where it earns it (The One Sun
// Rule). This is a TASTE deliverable: four variants along genuinely DIFFERENT
// axes, for the operator to choose one.
//
// ICON CRAFT (why the numbers are what they are):
//   - Design to the FULL SQUARE. iOS applies its own superellipse ("squircle")
//     corner mask, so we bake NO rounded corners here; the Deep Field ground
//     bleeds edge to edge. Android's adaptive icon re-crops too, so the load-
//     bearing content stays inside a generous central safe zone (SAFE_INSET) —
//     nothing critical rides the corners where a mask would shear it.
//   - NO alpha: iOS rejects an icon with transparency, so every variant fills an
//     opaque Deep Field ground first.
//   - NO text smaller than legible-at-60px: the only letterform is the "stamp"
//     variant's single Oxanium `F`, which fills the frame.
//
// The canon it obeys (DESIGN.md):
//   - Warm Dark Rule — the ground is a warm near-black Deep Field, never a flat
//     cold black.
//   - One Sun Rule — Eclipse Gold is the only light: exactly one gold source per
//     variant (the eclipse, the diamond, or the `F`), owning ~10% of the frame.
//   - Light-Years Rule — grain (and, where it suits, scanlines) are ON, but the
//     WEIGHT is the mark's own: near-silent under a clean, electric mark (so the
//     pop survives), heavier under the far-travelled "cover" scene.
//   - The Ignition Rule — gold is placed like light. The burning corona and the
//     sun-bloom read as a light source, never a painted chip.
//
// Determinism: the starfield and the stippled burning corona are seeded via
// Remotion's random(), never Math.random(), so every candidate renders
// identically each time. Dimensions live on the <Still> in root.tsx (1024×1024).

/** The four candidate axes. One composition renders all of them by `variant`. */
export type AppIconVariant =
  /** The burning eclipse mark alone on Deep Field — the pure identity orb. */
  | "eclipse"
  /** A single Oxanium `F` as a certification stamp, in the plate's printed frame. */
  | "stamp"
  /** The founding cover distilled: eclipse high over a tower skyline, relic grain. */
  | "cover"
  /** The banger-diamond star motif ("every banger out there is a star"). */
  | "diamond";

export type AppIconProps = {
  variant: AppIconVariant;
};

// The central region every platform mask is guaranteed to keep. iOS's squircle
// and Android's adaptive crop both nibble the corners, so load-bearing content
// stays inside this inset of the 1024 square.
const SAFE_INSET = 96;

/** A faint distant star: position (%), size (px), and brightness. */
type Star = { bright: number; size: number; x: number; y: number };

/**
 * A quiet seeded starfield, cleared around the sun so nothing competes with the
 * One Sun. `clearY` is the sun's vertical centre (%) — the field opens up there.
 */
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

/** One stippled corona particle: absolute px position, size, colour, opacity. */
type Ember = { color: string; opacity: number; size: number; x: number; y: number };

/**
 * The burning corona — the cover's signature. A ring band of seeded gold→orange→
 * red particles around the eclipse core, dithered so the "burning" reads as
 * pointillist heat (the founding artwork's stippled sun), not a clean gradient.
 * Denser and hotter near the core, thinning and reddening outward.
 */
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
    // Bias the radius inward (squared roll) so the band is densest at the core
    // and frays outward, like the cover's corona.
    const roll = random(`${seed}-t-${index}`) ** 2;
    const radius = innerRadius + roll * bandWidth;
    const t = (radius - innerRadius) / bandWidth; // 0 at core, 1 at the frayed rim

    // Colour ramp: Eclipse Glow → Eclipse Gold → Re-entry Red as it cools outward.
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

/** The seeded film-grain wash (Light-Years). `opacity` sets the relic weight. */
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

/** The warm Deep Field ground + a gentle warm vignette centred on the sun. */
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
        // Deterministic seeded field — stable index keys.
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
);

const Corona: React.FC<{ embers: Ember[] }> = ({ embers }) => (
  <AbsoluteFill>
    {embers.map((ember, index) => (
      <div
        // Deterministic seeded corona — stable index keys.
        // oxlint-disable-next-line no-array-index-key
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

/**
 * The eclipse orb itself — a soft halo, the gold body, and a hot near-white
 * specular core so it reads as a light SOURCE (The Ignition Rule), not a chip.
 * `size` is the body diameter in px; the halo and core scale from it.
 */
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

// ── Variant A: the burning eclipse mark alone ────────────────────────────────
// The purest brand mark — the sun the traveler moves toward, big and centred,
// wrapped in the cover's stippled burning corona. Minimal starfield, near-silent
// grain: an electric mark, its pop protected.
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

// ── Variant B: the Oxanium `F` certification stamp ───────────────────────────
// The typographic identity — the Discman-print letterform stamped on the
// logbook plate. The plate grammar (crop-mark brackets, register cross, double-
// rule frame) is printed in cream-dust (Dust Line), so the ONE gold is the `F`
// itself: the certification light (The One Sun Rule, The Unlit Rule's companion).
const StampVariant: React.FC = () => {
  const frame = SAFE_INSET + 40; // the printed edge, inside the safe zone
  const tick = 46; // crop-mark arm length

  return (
    <>
      <WarmGround sunY={30} />
      {/* A quiet sun-bloom from above — the sun sits off-frame, top (Ignition). */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(70% 55% at 50% 8%, ${colors.eclipseGold}1f 0%, transparent 60%)`,
        }}
      />

      {/* The double-rule frame — the plate's printed edge, in cream-dust. */}
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

      {/* Crop-mark corner brackets, printed just inside the frame. */}
      {[
        [frame - 22, frame - 22, false],
        [1024 - frame - tick + 22, frame - 22, false],
        [frame - 22, 1024 - frame - tick + 22, false],
        [1024 - frame - tick + 22, 1024 - frame - tick + 22, false],
      ].map(([left, top], index) => (
        <div
          // Fixed four corners — stable index keys.
          // oxlint-disable-next-line no-array-index-key
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

      {/* The register cross, printed centre-top just under the frame. */}
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

      {/* The `F` — the one gold, the certification stamp. A gentle bloom seats it. */}
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

// ── Variant C: the founding cover distilled ──────────────────────────────────
// The whole cover as an icon — the burning eclipse riding high with a wide
// stippled corona, a fuller starfield, and a low tower-skyline silhouette (the
// home you floated up from). The far-travelled relic, so grain + scanlines run
// heavier. Reads as a warm-lit scene, not a bare mark: the "scene" axis.
const CoverVariant: React.FC = () => {
  const cx = 512;
  const sunY = 300;

  return (
    <>
      {/* Warm sky: brighter high where the sun sits, falling to Deep Field. */}
      <AbsoluteFill style={{ backgroundColor: colors.deepField }} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(80% 62% at 50% 22%, ${colors.eclipseGold}22 0%, ${colors.reentryRed}12 30%, ${colors.deepField} 60%, #060708 100%)`,
        }}
      />
      <Starfield stars={buildStarfield("cover", 120, 30)} />
      <Corona embers={buildCorona("cover", 360, cx, sunY, 150, 210)} />
      <EclipseOrb cx={cx} cy={sunY} size={210} />

      {/* The tower skyline — a low band of warm-dark blocks with a few lit
          windows: the earthbound pole. Kept low-contrast so at 60px it reads as
          a warm base under the glow, never as mush competing with the sun. */}
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
                // Fixed seeded skyline — stable index keys.
                // oxlint-disable-next-line no-array-index-key
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

      {/* Light-Years: scanlines + a heavier grain (the far-travelled relic). */}
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

// ── Variant D: the banger-diamond star motif ─────────────────────────────────
// "Every banger out there is a star" (the Galaxy motif, galaxy-og.tsx) as a
// mark: a rotated Eclipse-Gold diamond with a hot core and a soft halo, on Deep
// Field. Geometric where the eclipse is a glow — the distinct fourth axis.
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
  cover: CoverVariant,
  diamond: DiamondVariant,
  eclipse: EclipseVariant,
  stamp: StampVariant,
};

export const AppIcon: React.FC<AppIconProps> = ({ variant }) => {
  const Variant = VARIANTS[variant];

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField, overflow: "hidden" }}>
      <Variant />
    </AbsoluteFill>
  );
};
