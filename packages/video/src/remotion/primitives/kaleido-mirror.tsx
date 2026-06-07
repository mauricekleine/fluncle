import React from "react";

export type KaleidoMirrorProps = {
  /**
   * Number of mirrored wedge segments. Even values give clean mirror symmetry;
   * 6 or 8 read as a classic kaleidoscope. Default 6.
   */
  segments?: number;
  /** Diameter of the kaleidoscope in px. Default 1080 (full width). */
  size?: number;
  /** Static rotation of the whole assembly in degrees. Default 0. */
  rotation?: number;
  /**
   * Scale applied to the children inside each wedge, to push the interesting
   * part of the source toward the center seam. Default 1.4.
   */
  sourceScale?: number;
  /** The source content mirrored into every wedge. */
  children: React.ReactNode;
};

/**
 * Kaleidoscope mirroring of children.
 *
 * HTML-IN-CANVAS DECISION: not used. Remotion's <HtmlInCanvas> (built into the
 * `remotion` package) is explicitly experimental and unstable per the docs
 * (https://www.remotion.dev/docs/html-in-canvas.md): it needs Chrome 149+ with
 * the chrome://flags/#canvas-draw-element flag, draws DOM into a real canvas
 * context, cannot be nested, and the docs warn Chrome may change or remove it.
 * That makes it unsuitable for a CPU-friendly headless render of this primitive.
 * So this is the sanctioned CSS-transform fallback: N rotated-and-mirrored copies
 * of the children inside a clipped circular container. No canvas, no WebGL, just
 * transforms and a conic clip-path; cheap to rasterize headless.
 *
 * Each wedge is a `(360/segments)`-degree slice; alternating wedges are flipped
 * (scaleX(-1)) so adjacent slices mirror across their shared edge, which is what
 * gives the true kaleidoscope symmetry. Deterministic: pure transforms, no time
 * or randomness of its own (animate by animating the children or `rotation`).
 */
export const KaleidoMirror: React.FC<KaleidoMirrorProps> = ({
  segments = 6,
  size = 1080,
  rotation = 0,
  sourceScale = 1.4,
  children,
}) => {
  const count = Math.max(1, Math.round(segments));
  const wedgeAngle = 360 / count;

  // A clip-path triangle wedge fanning out from the center, slightly wider than
  // the exact slice so adjacent wedges overlap and leave no seam gap.
  const half = wedgeAngle / 2 + 0.5;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  // Points on a generous radius so the wedge always covers its slice.
  const x1 = 50 + 80 * Math.sin(rad(-half));
  const y1 = 50 - 80 * Math.cos(rad(-half));
  const x2 = 50 + 80 * Math.sin(rad(half));
  const y2 = 50 - 80 * Math.cos(rad(half));
  const wedgeClip = `polygon(50% 50%, ${x1.toFixed(3)}% ${y1.toFixed(3)}%, ${x2.toFixed(3)}% ${y2.toFixed(3)}%)`;

  return (
    <div
      aria-hidden
      style={{
        borderRadius: "50%",
        height: size,
        overflow: "hidden",
        position: "relative",
        transform: `rotate(${rotation}deg)`,
        width: size,
      }}
    >
      {Array.from({ length: count }).map((_, i) => {
        const angle = i * wedgeAngle;
        const flip = i % 2 === 1 ? -1 : 1;
        return (
          <div
            key={i}
            style={{
              clipPath: wedgeClip,
              inset: 0,
              position: "absolute",
              transform: `rotate(${angle}deg)`,
              transformOrigin: "50% 50%",
            }}
          >
            <div
              style={{
                inset: 0,
                position: "absolute",
                transform: `scaleX(${flip}) scale(${sourceScale})`,
                transformOrigin: "50% 50%",
              }}
            >
              {children}
            </div>
          </div>
        );
      })}
    </div>
  );
};
