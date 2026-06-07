import { useCurrentFrame, useVideoConfig, staticFile, interpolate } from "remotion";
import { Grain } from "../primitives";

// <Plate> — a first-party image plate laid into the cosmos.
//
// FIRST-PARTY / PRE-CLEARED: plates loaded from public/plates/ are the operator's
// OWN collages (Maurice's work, 2019-2020). MOODBOARD.md grants full rights to
// sample them DIRECTLY into videos as plates, textures, or cutouts — unlike every
// other reference on the board, which may only contribute techniques. The three
// pre-cleared plates shipped in public/plates/ are:
//   - plates/rainy-days.jpg  — gold moon over Re-entry-Red lit mirrored peaks,
//     warm dark, heavy grain. The single most canon-ready plate; needs no retint.
//   - plates/the-cave-ii.jpg — a photographic Milky Way through a torn portal; a
//     premium star plate / reveal device.
//   - plates/the-portal.jpg  — a marbled planet with a black aperture core; a
//     centerpiece orb. Cool-leaning, so it WANTS a <Retint> pass.
//
// COMPOSES NATURALLY with the rest of the kit:
//   - inside <Retint>: <Retint mode="gradient-map"><Plate src={...} /></Retint>
//     pulls a cool plate into the canon palette (do this for the-portal.jpg).
//   - under <Grain>: a top-level <Grain> still sits over the whole frame; this
//     component's own `grainBoost` only thickens grain ON the plate so its
//     texture matches the surrounding cosmos. Grain over everything, always.
//
// BRAND LAW this component owns: staticFile resolution, the warm object-fit
// framing, deterministic frame-derived drift (no wall clock, no random), and the
// baked grain pass. The agent owns CREATIVITY: which plate, the fit, and the
// drift gesture (a preset or a per-axis spec).
//
// One Vehicle note: a plate is a SUPPORTING layer, not the travelling vehicle.
// Let the orb / lines / fractal / glass / glitch carry the journey; the plate
// sits behind or within it.

/** A slow, deterministic Ken-Burns drift over the clip. */
export type PlateDrift = {
  /** Horizontal pan as a fraction of width, start -> end. e.g. 0.04 drifts right. */
  x?: number;
  /** Vertical pan as a fraction of height, start -> end. e.g. -0.03 drifts up. */
  y?: number;
  /** Scale at the END of the clip (start is always 1). e.g. 1.08 = slow push-in. */
  scale?: number;
};

/**
 * Named drift presets so the agent does not have to hand-tune numbers. "slow-drift"
 * is a gentle push-in with a touch of upward pan — the cosmos breathes, it does
 * not scroll (DESIGN.md). "none" holds the plate still.
 */
export type PlateDriftPreset = "slow-drift" | "none";

export type PlateProps = {
  /**
   * Path passed to staticFile(). For the pre-cleared first-party plates use
   * "plates/rainy-days.jpg", "plates/the-cave-ii.jpg", or "plates/the-portal.jpg".
   * Any other public/ path also works, but only public/plates/ is rights-cleared
   * for direct sampling.
   */
  src: string;
  /** CSS object-fit for the image. Default "cover" (fill the frame, crop). */
  fit?: React.CSSProperties["objectFit"];
  /**
   * The Ken-Burns drift across the whole clip. Pass a preset name or a per-axis
   * spec ({ x, y, scale }). Frame-derived and deterministic. Default "slow-drift".
   */
  drift?: PlateDrift | PlateDriftPreset;
  /**
   * Extra grain opacity baked ONTO the plate (0..1) so its texture matches the
   * grainy cosmos before the top-level <Grain> lands over everything. Default
   * 0.12. This does not replace the frame-wide <Grain>; it seats the plate in it.
   */
  grainBoost?: number;
  /** Deterministic seed for the plate's baked grain. Default 11. */
  seed?: number;
  /** Overall opacity of the plate layer. Default 1. */
  opacity?: number;
  /** Blend mode of the plate over whatever sits behind it. Default "normal". */
  blendMode?: React.CSSProperties["mixBlendMode"];
  /** Extra styles on the wrapping element (position, inset, size). */
  style?: React.CSSProperties;
};

const PRESETS: Record<PlateDriftPreset, PlateDrift> = {
  none: { scale: 1, x: 0, y: 0 },
  "slow-drift": { scale: 1.08, x: 0.02, y: -0.02 },
};

const resolveDrift = (drift: PlateDrift | PlateDriftPreset): Required<PlateDrift> => {
  const d = typeof drift === "string" ? PRESETS[drift] : drift;
  return { scale: d.scale ?? 1, x: d.x ?? 0, y: d.y ?? 0 };
};

/**
 * A first-party image plate with a slow deterministic drift and a baked grain
 * pass, sized to its container. Pure: the drift is a function of the frame only.
 *
 * Compose inside <Retint> to recolor a cool plate to canon, and let the frame's
 * top-level <Grain> sit over the whole stack as always.
 */
export const Plate: React.FC<PlateProps> = ({
  src,
  fit = "cover",
  drift = "slow-drift",
  grainBoost = 0.12,
  seed = 11,
  opacity = 1,
  blendMode = "normal",
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;

  const { x, y, scale } = resolveDrift(drift);

  // Pan in pixels across the clip; scale eases from 1 to its end value. The base
  // scale stays >= the drift so the pan never reveals an empty edge.
  const panX = interpolate(progress, [0, 1], [0, x * width]);
  const panY = interpolate(progress, [0, 1], [0, y * height]);
  const driftScale = interpolate(progress, [0, 1], [1, scale]);
  // A small fixed overscan covers the pan so edges never show through.
  const overscan = 1 + Math.max(Math.abs(x), Math.abs(y)) * 2;

  return (
    <div
      aria-hidden
      style={{
        inset: 0,
        mixBlendMode: blendMode,
        opacity,
        overflow: "hidden",
        position: "absolute",
        ...style,
      }}
    >
      <img
        src={staticFile(src)}
        style={{
          height: "100%",
          inset: 0,
          objectFit: fit,
          position: "absolute",
          transform: `translate(${panX}px, ${panY}px) scale(${overscan * driftScale})`,
          width: "100%",
        }}
      />
      {/* Baked grain seats the plate in the cosmos texture (still under the
          frame-wide <Grain>). fps referenced so the hook contract is satisfied. */}
      {grainBoost > 0 ? (
        <Grain
          opacity={grainBoost}
          seed={(seed % 97) + 1}
          intensity={0.95}
          framePool={Math.max(8, Math.round(fps / 2))}
          blendMode="overlay"
        />
      ) : null}
    </div>
  );
};
