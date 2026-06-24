// The Chromium OpenGL renderer for headless WebGL (ShaderLayer) renders.
//
// ANGLE (Metal on Apple Silicon) gives a real hardware GL context locally and in
// Studio — the default, so a workstation render is unchanged. A GPU-less host (the
// remote render box) exports `FLUNCLE_GL=swangle` (SwiftShader-on-ANGLE: a software
// GL implementation with visually identical output, just slower per frame). One
// source of truth, read by render.ts, render-cover.ts, and remotion.config.ts.
export type GlRenderer = "angle" | "swangle";

export function glRenderer(): GlRenderer {
  return process.env.FLUNCLE_GL === "swangle" ? "swangle" : "angle";
}
