import { type RefObject, useEffect, useState } from "react";
import { type RenditionWidth } from "./media";

export const RENDITION_LADDER: readonly RenditionWidth[] = [360, 480, 720, 1080];

export const SMALLEST_RENDITION_WIDTH: RenditionWidth = 360;

const MAX_PIXEL_RATIO = 2;

function pickRenditionWidth(deviceWidth: number): RenditionWidth {
  for (const rung of RENDITION_LADDER) {
    if (deviceWidth <= rung) {
      return rung;
    }
  }

  return RENDITION_LADDER[RENDITION_LADDER.length - 1] ?? 1080;
}

export function stepDownRenditionWidth(width: RenditionWidth, steps: number): RenditionWidth {
  const index = RENDITION_LADDER.indexOf(width);

  if (index < 0) {
    return width;
  }

  const target = Math.max(0, index - Math.max(0, Math.trunc(steps)));

  return RENDITION_LADDER[target] ?? SMALLEST_RENDITION_WIDTH;
}

export function useResponsiveWidth(ref: RefObject<HTMLElement | null>): RenditionWidth | undefined {
  const [width, setWidth] = useState<RenditionWidth | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;

    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    const measure = () => {
      const cssWidth = element.getBoundingClientRect().width;

      if (cssWidth > 0) {
        setWidth(pickRenditionWidth(cssWidth * ratio));
      }
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  return width;
}
