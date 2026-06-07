import { useMemo } from "react";
import { random } from "remotion";
import { colors } from "@fluncle/tokens";
import { withAlpha } from "../color";

// remotion's deterministic random() used as a stable per-cell hash.
const hash = (key: string): number => random(key);

export type DitherPattern = "halftone" | "checker" | "pixel";

export type DitherFieldProps = {
  /** Which matrix texture to render. Default "halftone". */
  pattern?: DitherPattern;
  /** Cell size in px (the texture's base unit). Default 16. */
  scale?: number;
  /** Texture color. Default Starlight Cream. */
  color?: string;
  /**
   * 0..1 fill threshold. For halftone it is dot radius; for checker it biases
   * which cells fill; for pixel it is the per-cell on-probability cut. Default 0.5.
   */
  threshold?: number;
  /** Overall layer opacity, 0..1. Default 1. */
  opacity?: number;
  /** Deterministic seed for the "pixel" pattern. Default 1. */
  seed?: number;
  /** Blend mode over the parent. Default "normal". */
  blendMode?: React.CSSProperties["mixBlendMode"];
};

/**
 * Bitmap / matrix texture fields for the glitch pole of the brand (the squared,
 * machine-label side of Oxanium and the Discman).
 *
 * Implemented as a tiled CSS background (halftone, checker) or a seeded SVG grid
 * (pixel) so it is cheap to rasterize headless: no per-pixel canvas work, just a
 * repeated tile. Pure and deterministic; the "pixel" pattern uses remotion's
 * deterministic hashing via a seed-derived grid, not Math.random().
 *
 * Covers the parent absolutely.
 */
export const DitherField: React.FC<DitherFieldProps> = ({
  pattern = "halftone",
  scale = 16,
  color = colors.starlightCream,
  threshold = 0.5,
  opacity = 1,
  seed = 1,
  blendMode = "normal",
}) => {
  const t = Math.min(1, Math.max(0, threshold));

  const style = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      height: "100%",
      inset: 0,
      mixBlendMode: blendMode,
      opacity,
      pointerEvents: "none",
      position: "absolute",
      width: "100%",
    };

    if (pattern === "halftone") {
      // Radial dots on a square lattice; threshold drives dot radius.
      const r = (t * scale) / 2;
      return {
        ...base,
        backgroundColor: "transparent",
        backgroundImage: `radial-gradient(circle at center, ${color} ${r}px, transparent ${r + 0.5}px)`,
        backgroundSize: `${scale}px ${scale}px`,
      };
    }

    if (pattern === "checker") {
      // Two diagonal half-cell gradients build a checkerboard tile.
      const c = withAlpha(color, t < 0.5 ? t * 2 : 1);
      return {
        ...base,
        backgroundColor: "transparent",
        backgroundImage: `
          linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%),
          linear-gradient(45deg, ${c} 25%, transparent 25%, transparent 75%, ${c} 75%)`,
        backgroundPosition: `0 0, ${scale / 2}px ${scale / 2}px`,
        backgroundSize: `${scale}px ${scale}px`,
      };
    }

    return base;
  }, [pattern, scale, color, t, opacity, blendMode]);

  if (pattern === "pixel") {
    // Seeded on/off pixel grid via SVG rects. Deterministic by seed.
    return (
      <PixelGrid
        scale={scale}
        color={color}
        threshold={t}
        opacity={opacity}
        seed={seed}
        blendMode={blendMode}
      />
    );
  }

  return <div aria-hidden style={style} />;
};

type PixelGridProps = Required<
  Pick<DitherFieldProps, "scale" | "color" | "opacity" | "seed" | "blendMode">
> & { threshold: number };

const PixelGrid: React.FC<PixelGridProps> = ({
  scale,
  color,
  threshold,
  opacity,
  seed,
  blendMode,
}) => {
  // Render a small tile of cells and repeat it via SVG pattern so cost stays low.
  const tile = 8; // cells per tile edge
  const cells = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        // Deterministic hash from seed + cell coords (remotion random()).
        const on = hash(`pixel-${seed}-${x}-${y}`) < threshold;
        if (on) {
          out.push({ x, y });
        }
      }
    }
    return out;
  }, [seed, threshold]);

  const tilePx = tile * scale;

  return (
    <svg
      aria-hidden
      style={{
        height: "100%",
        inset: 0,
        mixBlendMode: blendMode,
        opacity,
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
      }}
    >
      <defs>
        <pattern id={`pixel-${seed}`} width={tilePx} height={tilePx} patternUnits="userSpaceOnUse">
          {cells.map((c, i) => (
            <rect
              key={i}
              x={c.x * scale}
              y={c.y * scale}
              width={scale}
              height={scale}
              fill={color}
            />
          ))}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#pixel-${seed})`} />
    </svg>
  );
};
