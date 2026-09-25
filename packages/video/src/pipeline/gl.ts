export type GlRenderer = "angle" | "swangle";

export function glRenderer(): GlRenderer {
  return process.env.FLUNCLE_GL === "swangle" ? "swangle" : "angle";
}
