import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

let ready: Promise<void> | undefined;

export async function rasterSvgToPixels(
  svg: string,
  width: number,
): Promise<{ height: number; pixels: Uint8Array; width: number }> {
  ready ??= initWasm(resvgWasm);
  await ready;

  const rendered = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();

  return { height: rendered.height, pixels: rendered.pixels, width: rendered.width };
}
