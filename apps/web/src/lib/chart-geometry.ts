export type ChartDims = { height: number; padY: number; width: number };

export type ChartGeometry = {
  area: string;

  last: { x: number; y: number };

  line: string;
  max: number;
  min: number;
};

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
