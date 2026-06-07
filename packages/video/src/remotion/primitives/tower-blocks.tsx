import { useMemo } from "react";
import { random } from "remotion";
import { colors } from "@fluncle/tokens";
import { type CosmosPalette } from "../types";
import { mix, withAlpha } from "../color";

export type TowerBlocksProps = {
  /** Palette; silhouettes derive from background, lit windows from glow/accent. */
  palette?: Partial<CosmosPalette>;
  /** Deterministic seed for block layout and lit-window pattern. Default 1. */
  seed?: number;
  /** Fraction of windows that are lit, 0..1. Default 0.22. */
  litWindowDensity?: number;
  /** Height of the tallest block as a fraction of container height. Default 0.42. */
  maxHeight?: number;
  /** Number of blocks across. Default 11. */
  count?: number;
  /**
   * Brightness multiplier for lit windows, 0..1+. Drive from useBass/useEnergy
   * so the city pulses with the low end. Default 1.
   */
  windowGlow?: number;
};

type Tower = {
  x: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
};

/**
 * Procedural dark apartment-block silhouettes along the bottom with tiny lit
 * windows, echoing the cover art's tower blocks the figure floats out of.
 *
 * Everything is seeded via remotion random() (positions, heights, which windows
 * are lit) so it is stable across renders. Lit windows are Eclipse Gold / glow,
 * the lit windows in the towers per DESIGN.md's One Sun reading. Renders to the
 * bottom edge, transparent above.
 *
 * Pure: animate brightness from outside via windowGlow (audio-reactive).
 */
export const TowerBlocks: React.FC<TowerBlocksProps> = ({
  palette,
  seed = 1,
  litWindowDensity = 0.22,
  maxHeight = 0.42,
  count = 11,
  windowGlow = 1,
}) => {
  const background = palette?.background ?? colors.deepField;
  const accent = palette?.accent ?? colors.eclipseGold;
  const glow = palette?.glow ?? colors.eclipseGlow;

  // Silhouette: warm near-black, a hair lighter than the sky so the skyline reads.
  const silhouette = mix(background, accent, 0.05);
  const litColor = mix(accent, glow, 0.4);

  const towers = useMemo<Tower[]>(() => {
    const out: Tower[] = [];
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      const width = 0.05 + random(`tower-w-${seed}-${i}`) * 0.06;
      const height = (0.4 + random(`tower-h-${seed}-${i}`) * 0.6) * maxHeight;
      const cols = 2 + Math.floor(random(`tower-c-${seed}-${i}`) * 3);
      const rows = Math.max(3, Math.floor((height / maxHeight) * 12));
      out.push({ cols, height, rows, width, x: cursor });
      // Slight overlap/gap so the skyline feels packed, not evenly spaced.
      cursor += width * (0.78 + random(`tower-g-${seed}-${i}`) * 0.35);
    }
    return out;
  }, [count, seed, maxHeight]);

  const VB_W = 1000;
  const VB_H = 1000;

  return (
    <svg
      aria-hidden
      style={{
        bottom: 0,
        height: "100%",
        left: 0,
        pointerEvents: "none",
        position: "absolute",
        right: 0,
        width: "100%",
      }}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
    >
      {towers.map((t, i) => {
        const px = t.x * VB_W;
        const pw = t.width * VB_W;
        const ph = t.height * VB_H;
        const py = VB_H - ph;

        const winW = (pw / t.cols) * 0.42;
        const winH = (ph / t.rows) * 0.4;
        const gapX = pw / t.cols;
        const gapY = ph / t.rows;

        const windows: React.ReactNode[] = [];
        for (let r = 0; r < t.rows; r++) {
          for (let c = 0; c < t.cols; c++) {
            const lit = random(`win-${seed}-${i}-${r}-${c}`) < litWindowDensity;
            if (!lit) {
              continue;
            }
            // Per-window brightness variation, scaled by the live windowGlow.
            const base = 0.45 + random(`winb-${seed}-${i}-${r}-${c}`) * 0.55;
            const a = Math.min(1, base * windowGlow);
            windows.push(
              <rect
                key={`w-${r}-${c}`}
                x={px + c * gapX + (gapX - winW) / 2}
                y={py + r * gapY + (gapY - winH) / 2}
                width={winW}
                height={winH}
                fill={withAlpha(litColor, a)}
              />,
            );
          }
        }

        return (
          <g key={i}>
            <rect x={px} y={py} width={pw} height={ph} fill={silhouette} />
            {windows}
          </g>
        );
      })}
    </svg>
  );
};
