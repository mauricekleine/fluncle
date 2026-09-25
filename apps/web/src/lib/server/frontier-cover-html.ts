import { colors } from "@fluncle/tokens";
import frontierBg from "./frontier-cover-bg.jpg?inline";
import { BRAND } from "./satori-render";

export const FRONTIER_COVER_PX = 640;

export const FRONTIER_COVER_MAX_JPEG_BYTES = 192 * 1024;

const COLOR = {
  deepField: colors.deepField,
  dustLine: colors.dustLine,
  starlightCream: colors.starlightCream,
  tapeBlack: colors.tapeBlack,
} as const;

export function frontierCrewStamp(crewNumber: null | number | undefined): null | string {
  return typeof crewNumber === "number" && crewNumber > 0
    ? `Nº ${String(crewNumber).padStart(3, "0")}`
    : null;
}

export function buildFrontierCoverHtml({
  crewNumber,
}: {
  crewNumber: null | number | undefined;
}): string {
  const px = FRONTIER_COVER_PX;
  const stamp = frontierCrewStamp(crewNumber);

  const scrim = `linear-gradient(180deg, transparent 34%, ${COLOR.deepField}b8 52%, ${COLOR.deepField}8c 68%, transparent 82%)`;

  return `
    <div style="position:relative;display:flex;width:${px}px;height:${px}px;background:${COLOR.deepField};overflow:hidden;">
      <img src="${frontierBg}" width="${px}" height="${px}" style="position:absolute;top:0;left:0;width:${px}px;height:${px}px;object-fit:cover;" />
      <div style="position:absolute;top:0;left:0;display:flex;width:${px}px;height:${px}px;background:${scrim};"></div>
      <div style="position:absolute;top:0;left:0;display:flex;flex-direction:column;align-items:center;justify-content:center;width:${px}px;height:${px}px;padding-top:36px;">
        <div style="display:flex;font-family:${BRAND};color:${COLOR.starlightCream};font-size:46px;font-weight:800;letter-spacing:6px;line-height:1;text-shadow:0 2px 18px ${COLOR.deepField};">FLUNCLE’S</div>
        <div style="display:flex;font-family:${BRAND};color:${COLOR.starlightCream};font-size:104px;font-weight:800;letter-spacing:2px;line-height:1.04;text-shadow:0 3px 26px ${COLOR.deepField};">FRONTIER</div>
      </div>
      ${
        stamp
          ? `<div style="position:absolute;bottom:30px;left:30px;display:flex;background:${COLOR.tapeBlack}e6;border:2px solid ${COLOR.dustLine};border-radius:10px;padding:12px 18px 13px;color:${COLOR.starlightCream};font-family:${BRAND};font-size:34px;font-weight:800;letter-spacing:3px;line-height:1;">${stamp}</div>`
          : ""
      }
    </div>
  `;
}
