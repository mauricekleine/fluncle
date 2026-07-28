import { AbsoluteFill, random, useVideoConfig } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK, SPACE_GROTESK_STACK } from "./fonts";

// <SyntheticSleeve> — a generative 1000² album sleeve in Fluncle's own visual language.
//
// WHY THIS EXISTS. Apple rejected mobile 1.0 under Guideline 5.2.1: the App Store
// screenshots showed real album artwork we hold no rights to. Every sleeve in a store
// asset now has to be art Fluncle OWNS, so this composition draws one from nothing —
// no photography, no sampled texture, no lettering borrowed from a real release. The
// only strings on the frame are the synthetic title and artist handed in as props.
// See docs/mobile-store-screenshots.md.
//
// It is NOT a pastiche of any particular cover. It is the Nostalgic Cosmos applied to a
// square: a warm dark ground, one committed Eclipse-Gold light, cream-dust geometry, and
// the Light-Years grain + scanline wash. Four geometry families keep a wall of fourteen
// sleeves from reading as one template, and the family is picked from the seed, so a
// given slug always renders the same sleeve.
//
// The canon it obeys:
//   - Warm Dark Rule — every ground is one of the three warm blacks; no cold black.
//   - One Sun Rule — EXACTLY one gold element per sleeve (the disc, the band, the ring,
//     or the seam, depending on family). The cream/dust geometry around it is paper, not
//     light. Nothing else in the frame is gold.
//   - Light-Years Rule — grain + scanlines are always on.
//   - One Voice Rule — the title and artist are running words, so they are Space Grotesk
//     (the body face). Oxanium sets only the sleeve's catalogue mark, which is a numeral.
//   - The One Box Rule rides in via ./fonts, so mixed-face lines share a centre line.
//
// Determinism: everything procedural goes through Remotion's `random(seed)`. No
// Math.random, no wall clock — the same slug renders byte-stable art.

/** The geometry families. One is picked per seed; each spends the single gold differently. */
const FAMILIES = ["eclipse", "strata", "orbit", "fracture"] as const;

type Family = (typeof FAMILIES)[number];

export type SyntheticSleeveProps = {
  /** The billed artist, set small above the title. */
  artist: string;
  /** The seed string — the fixture slug. Same slug, same sleeve, forever. */
  seed: string;
  /** The release title, the loudest text on the sleeve. */
  title: string;
};

/** The three warm blacks, in the order the seed picks a ground from. */
const GROUNDS = [colors.deepField, colors.sleeveBlack, colors.tapeBlack] as const;

/** Pick one member of a tuple deterministically from a seeded roll. */
function pick<T>(items: readonly T[], roll: number): T | undefined {
  return items[Math.min(items.length - 1, Math.floor(roll * items.length))];
}

/** A faint distant star: position (%), size (px), and brightness. */
type Star = { bright: number; size: number; x: number; y: number };

/** A quiet seeded starfield — depth behind the geometry, never a second light. */
function buildStarfield(seed: string, count: number): Star[] {
  const stars: Star[] = [];

  for (let index = 0; index < count; index += 1) {
    stars.push({
      bright: 0.14 + random(`${seed}-star-b-${index}`) * 0.34,
      size: 1 + random(`${seed}-star-s-${index}`) * 1.5,
      x: random(`${seed}-star-x-${index}`) * 100,
      y: random(`${seed}-star-y-${index}`) * 100,
    });
  }

  return stars;
}

/**
 * THE ECLIPSE. A large gold disc riding low, half-occluded by a warm-dark band — the
 * founding image of the whole system, cut down to a sleeve. The gold is the disc.
 */
function EclipseFamily({ ground, seed }: { ground: string; seed: string }) {
  const size = 40 + random(`${seed}-disc`) * 16;
  const cx = 34 + random(`${seed}-disc-x`) * 32;
  const cy = 36 + random(`${seed}-disc-y`) * 14;
  const bandTop = cy + 2 + random(`${seed}-band`) * 8;

  return (
    <>
      <AbsoluteFill>
        {/* The disc's halo, then the disc. ONE gold light. */}
        <div
          style={{
            background: `radial-gradient(circle, ${colors.eclipseGlow}4d 0%, ${colors.eclipseGold}1f 42%, transparent 72%)`,
            borderRadius: "50%",
            height: `${size * 2.1}%`,
            left: `${cx - size * 1.05}%`,
            position: "absolute",
            top: `${cy - size * 1.05}%`,
            width: `${size * 2.1}%`,
          }}
        />
        <div
          style={{
            background: `linear-gradient(160deg, ${colors.eclipseGlow} 0%, ${colors.eclipseGold} 58%, #c79400 100%)`,
            borderRadius: "50%",
            height: `${size}%`,
            left: `${cx - size / 2}%`,
            position: "absolute",
            top: `${cy - size / 2}%`,
            width: `${size}%`,
          }}
        />
      </AbsoluteFill>
      {/* The occluding band — the ground itself, cutting the disc. Warm, opaque, flat. */}
      <div
        style={{
          backgroundColor: ground,
          height: `${18 + random(`${seed}-band-h`) * 10}%`,
          left: 0,
          position: "absolute",
          right: 0,
          top: `${bandTop}%`,
        }}
      />
      {/* A single cream hairline riding the band's upper edge: the horizon. */}
      <div
        style={{
          backgroundColor: colors.stardust,
          height: 2,
          left: "8%",
          opacity: 0.5,
          position: "absolute",
          right: "8%",
          top: `${bandTop}%`,
        }}
      />
    </>
  );
}

/**
 * THE STRATA. Horizontal cream-dust bands of drifting weight, one of them gold — a
 * spectrogram flattened into printed paper. The gold is the single lit band.
 */
function StrataFamily({ seed }: { seed: string }) {
  const count = 7 + Math.floor(random(`${seed}-strata-n`) * 4);
  const litIndex = Math.floor(random(`${seed}-strata-lit`) * count);
  // Each band is a CORE plus its offset, so the stack drifts across the square rather than
  // sitting left-flush — flush rows of grey read as a loading skeleton, not as printing.
  const drift = 0.5 + random(`${seed}-strata-drift`) * 0.5;

  return (
    <AbsoluteFill style={{ padding: "13% 12% 26%" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "2.2%",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {Array.from({ length: count }, (_, index) => {
          const lit = index === litIndex;
          const span = 34 + random(`${seed}-strata-w-${index}`) * 56;
          // Sinusoidal drift keeps the left edges in a curve — a strata section, not noise.
          const left = (1 - span / 100) * 100 * drift * (0.5 + 0.5 * Math.sin(index * 0.8));

          return (
            <div
              // Seeded, fixed-length geometry: index keys are stable by construction.
              // oxlint-disable-next-line no-array-index-key
              key={index}
              style={{
                backgroundColor: lit ? colors.eclipseGold : colors.starlightCream,
                borderRadius: 3,
                boxShadow: lit ? `0 0 52px 8px ${colors.eclipseGold}4d` : undefined,
                height: `${lit ? 4.6 : 2.4 + random(`${seed}-strata-h-${index}`) * 4}%`,
                marginLeft: `${left}%`,
                opacity: lit ? 1 : 0.24 + random(`${seed}-strata-o-${index}`) * 0.46,
                width: `${span}%`,
              }}
            />
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

/**
 * THE ORBIT. Concentric cream rings around an off-centre point, one of them gold — the
 * voyage spiral seen end-on. The gold is the single lit ring.
 */
function OrbitFamily({ seed }: { seed: string }) {
  const count = 7 + Math.floor(random(`${seed}-orbit-n`) * 4);
  const litIndex = 1 + Math.floor(random(`${seed}-orbit-lit`) * (count - 2));
  const cx = 38 + random(`${seed}-orbit-x`) * 24;
  const cy = 34 + random(`${seed}-orbit-y`) * 22;

  return (
    <AbsoluteFill>
      {Array.from({ length: count }, (_, index) => {
        const lit = index === litIndex;
        const span = 12 + index * (76 / count);

        return (
          <div
            // Seeded, fixed-length geometry: index keys are stable by construction.
            // oxlint-disable-next-line no-array-index-key
            key={index}
            style={{
              borderColor: lit ? colors.eclipseGold : colors.starlightCream,
              borderRadius: "50%",
              borderStyle: "solid",
              borderWidth: lit ? 5 : 1.5,
              boxShadow: lit ? `0 0 46px 4px ${colors.eclipseGold}40` : undefined,
              height: `${span}%`,
              left: `${cx - span / 2}%`,
              opacity: lit ? 1 : 0.16 + random(`${seed}-orbit-o-${index}`) * 0.3,
              position: "absolute",
              top: `${cy - span / 2}%`,
              width: `${span}%`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
}

/**
 * THE FRACTURE. The square split on a diagonal — a dust-veiled field against the warm
 * dark, with a single gold seam along the break. The gold is the seam.
 */
function FractureFamily({ seed }: { seed: string }) {
  const angle = 108 + random(`${seed}-frac-a`) * 44;
  const stop = 38 + random(`${seed}-frac-s`) * 22;

  return (
    <>
      <AbsoluteFill
        style={{
          background: `linear-gradient(${angle}deg, ${colors.dustVeil} 0%, ${colors.dustVeil} ${stop}%, transparent ${stop}%, transparent 100%)`,
        }}
      />
      {/* The seam — one gold line along the break, glowing into the dark side. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(${angle}deg, transparent 0%, transparent ${stop - 0.35}%, ${colors.eclipseGold} ${stop - 0.35}%, ${colors.eclipseGold} ${stop + 0.35}%, transparent ${stop + 0.35}%, transparent 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `linear-gradient(${angle}deg, transparent 0%, transparent ${stop - 4}%, ${colors.eclipseGold}2e ${stop}%, transparent ${stop + 7}%, transparent 100%)`,
        }}
      />
    </>
  );
}

export const SyntheticSleeve: React.FC<SyntheticSleeveProps> = ({ artist, seed, title }) => {
  const { height } = useVideoConfig();
  const family: Family = pick(FAMILIES, random(`${seed}-family`)) ?? "eclipse";
  const ground = pick(GROUNDS, random(`${seed}-ground`)) ?? colors.deepField;
  const stars = buildStarfield(seed, 90);
  // The catalogue mark: a two-digit numeral, the one thing on the sleeve Oxanium may set
  // (The One Voice Rule — Oxanium speaks for the brand and the numbers, never a sentence).
  const catalogueMark = String(1 + Math.floor(random(`${seed}-cat`) * 98)).padStart(2, "0");

  return (
    <AbsoluteFill style={{ backgroundColor: ground }}>
      {/* Warm Dark: a warm vignette so the corners fall away and the middle carries. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 130% at 50% 38%, ${colors.sleeveBlack} 0%, ${ground} 58%, #060708 100%)`,
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

      {family === "eclipse" ? <EclipseFamily ground={ground} seed={seed} /> : null}
      {family === "strata" ? <StrataFamily seed={seed} /> : null}
      {family === "orbit" ? <OrbitFamily seed={seed} /> : null}
      {family === "fracture" ? <FractureFamily seed={seed} /> : null}

      {/* The printed field: a dust-line rule, the catalogue mark, the artist, the title.
          It sits on a warm scrim so the type holds AA over whatever geometry is behind it
          (The Legible Sky Rule — the pane gets more opaque, the text never dimmer). */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, transparent 0%, ${ground}00 44%, ${ground}d9 66%, ${ground} 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          padding: `0 ${Math.round(height * 0.08)}px ${Math.round(height * 0.075)}px`,
        }}
      >
        <div
          style={{
            backgroundColor: colors.dustLine,
            height: 1,
            marginBottom: Math.round(height * 0.028),
            width: "100%",
          }}
        />
        <div style={{ alignItems: "baseline", display: "flex", gap: Math.round(height * 0.022) }}>
          <div
            style={{
              color: colors.eclipseGlow,
              fontFamily: OXANIUM_STACK,
              fontSize: Math.round(height * 0.032),
              fontVariantNumeric: "tabular-nums",
              fontWeight: 400,
              letterSpacing: "0.14em",
              opacity: 0.8,
            }}
          >
            {catalogueMark}
          </div>
          <div
            style={{
              color: colors.stardust,
              fontFamily: SPACE_GROTESK_STACK,
              fontSize: Math.round(height * 0.034),
              fontWeight: 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {artist}
          </div>
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: SPACE_GROTESK_STACK,
            fontSize: Math.round(height * 0.072),
            fontWeight: 700,
            letterSpacing: "-0.01em",
            lineHeight: 1.06,
            marginTop: Math.round(height * 0.012),
          }}
        >
          {title}
        </div>
      </AbsoluteFill>

      {/* Light-Years: scanlines + film grain over the whole sleeve. */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${colors.deepField}00 0px, ${colors.deepField}00 2px, ${colors.deepField}40 3px, ${colors.deepField}40 3px)`,
          mixBlendMode: "multiply",
          opacity: 0.42,
        }}
      />
      <AbsoluteFill style={{ mixBlendMode: "overlay", opacity: 0.17 }}>
        <svg height="100%" width="100%" xmlns="http://www.w3.org/2000/svg">
          <filter id={`sleeve-grain-${seed}`}>
            <feTurbulence baseFrequency="0.85" numOctaves={2} seed={3} type="fractalNoise" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect filter={`url(#sleeve-grain-${seed})`} height="100%" width="100%" />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
