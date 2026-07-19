// THE SHARED LINE-CHART GEOMETRY — the one place the hand-drawn SVG line charts compute their
// coordinates (no chart dependency). Used by the public `/reach` telemetry console and the
// `/admin/funnel` growth charts, so the two can never draw the same shape two different ways.
//
// Pure math: it maps a series of {value} points into a fixed viewBox (drawn with
// preserveAspectRatio="none", so the viewBox stretches to the rendered size). The caller owns
// the viewBox dimensions and passes them as `dims` — /reach is taller (220) than the funnel's
// compact growth cards (160), same math either way.
//
// QUIRK (preserved, not fixed here): the last point pins to x = width, the exact right edge of
// the viewBox, so a live-edge dot drawn there renders half-outside the viewBox and reads as a
// half-dot. Both consumers have always drawn it this way; a later cleanup can inset the live
// edge by the dot radius. Kept identical for now so this extraction changes no rendered output.

/** The viewBox the geometry is computed in. `padY` insets the line vertically from top/bottom. */
export type ChartDims = { height: number; padY: number; width: number };

/** The polyline/area/last-point geometry for a set of points, in the given viewBox space. */
export type ChartGeometry = {
  /** The filled area path (closed to the baseline), for the translucent fill under the line. */
  area: string;
  /** The live edge — the last point, where the one gold dot sits. */
  last: { x: number; y: number };
  /** The line polyline points ("x,y x,y …"). */
  line: string;
  max: number;
  min: number;
};

/**
 * Map points to viewBox coordinates: x spreads evenly across the width, y inverts the value into
 * the padded height (bigger value = higher on screen). A flat series (span 0) draws down the
 * middle; a single point pins to the right edge (the live edge), so a caller can drop the dot at
 * "now" without a fabricated line. An empty series yields empty paths and a centered fallback
 * point — no NaN, nothing to draw.
 */
export function chartGeometry(points: { value: number }[], dims: ChartDims): ChartGeometry {
  const { height, padY, width } = dims;
  const values = points.map((point) => point.value);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const span = max - min;
  const usable = height - padY * 2;

  const coords = points.map((point, index) => ({
    x: points.length === 1 ? width : (index / (points.length - 1)) * width,
    y: span === 0 ? height / 2 : padY + (1 - (point.value - min) / span) * usable,
  }));

  const last = coords[coords.length - 1] ?? { x: width, y: height / 2 };
  const line = coords.map((coord) => `${coord.x},${coord.y}`).join(" ");
  const area =
    coords.length > 0
      ? `M0,${height} L${coords.map((c) => `${c.x},${c.y}`).join(" L")} L${width},${height} Z`
      : "";

  return { area, last, line, max, min };
}
