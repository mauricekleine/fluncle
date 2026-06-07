import { type CSSProperties } from "react";
import { AbsoluteFill } from "remotion";
import { GLSL } from "../journey/glsl";
import { ShaderLayer } from "../journey/shader-layer";
import { type CosmosPalette } from "../types";

export type TowerBlocksProps = {
  /** Palette; silhouettes derive from background, lit windows from glow/accent. */
  palette?: Partial<CosmosPalette>;
  /** Deterministic seed for block layout and lit-window pattern. Default 1. */
  seed?: number;
  /** Fraction of windows that are lit, 0..1. Default 0.22. */
  litWindowDensity?: number;
  /** Height of the tallest block as a fraction of container height. Default 0.42. */
  maxHeight?: number;
  /** Number of blocks across the NEAREST depth layer. Default 11. */
  count?: number;
  /**
   * Brightness multiplier for lit windows, 0..1+. Drive from useBass/useEnergy
   * so the city pulses with the low end. Default 1.
   */
  windowGlow?: number;
  /**
   * Number of parallax depth layers, 1..3. Deeper layers sit higher (further
   * up the frame), are hazier/lighter, and have smaller/denser blocks, giving
   * the skyline photographic depth. Default 3.
   */
  depth?: number;
  /**
   * Atmospheric haze strength 0..1: how much each deeper layer washes toward the
   * sky tone, plus how much fog rises from the horizon. Higher = mistier, more
   * distant city. Default 0.55.
   */
  haze?: number;
  /** Layer opacity 0..1. Default 1. */
  opacity?: number;
  /** Blend mode over the parent. Default "normal". */
  blendMode?: CSSProperties["mixBlendMode"];
};

// The skyline shader. A rendered-grade city instead of flat CSS rects: 2-3
// parallax depth layers of varying-height blocks rising from the bottom, each
// deeper layer lighter and hazier (aerial perspective) with fog pooling at the
// horizon, emissive window dots that bloom and flicker on a slow seeded clock,
// and soft top edges (no razor rectangles). Built on ShaderLayer so it grains
// and dithers with the rest of the GPU stack.
//
// Moodboard: posted/infinity.jpg (hazy distant moon-lit world, soft tonal
// bands), the founding image's lit windows in dark towers, photographic
// atmosphere over flat graphics.
//
// Custom uniforms (fed from TowerBlocks):
//   u_count      blocks across the nearest layer
//   u_litDensity fraction of windows lit
//   u_maxHeight  tallest block as a fraction of frame height
//   u_winGlow    live window brightness (bass/energy)
//   u_depth      number of parallax layers (1..3)
//   u_haze       atmospheric haze strength
const TOWERS_FRAG = /* glsl */ `
uniform float u_count;
uniform float u_litDensity;
uniform float u_maxHeight;
uniform float u_winGlow;
uniform float u_depth;
uniform float u_haze;

${GLSL.hash}
${GLSL.valueNoise}

// Per-block height for column index c in a given layer (stable, seeded). Returns
// the block's top as a fraction of frame height (0 = bottom of frame).
float blockTop(float c, float layerSeed) {
  float h = hash21(vec2(c * 1.37 + layerSeed * 7.0, layerSeed * 3.1));
  return (0.42 + 0.58 * h) * u_maxHeight;
}

// One depth layer. uv is full-frame 0..1 (y up). depthT 0 = nearest, 1 =
// farthest. Writes the layer's color into col and returns its coverage alpha
// (1 inside a building, soft at the top edge, fog-faded near the horizon).
float skylineLayer(vec2 uv, float depthT, inout vec3 col) {
  // Deeper layers: more, narrower columns; shorter; lifted up the frame so they
  // peek behind the nearer rows.
  float cols = u_count * mix(1.0, 2.1, depthT);
  float baseLift = depthT * u_maxHeight * 0.55; // distant skyline sits higher
  float heightScale = mix(1.0, 0.6, depthT);

  // Column coordinate. A per-layer horizontal offset destacks the rows so blocks
  // don't line up across depths.
  float layerSeed = 11.0 + depthT * 23.0 + u_seed;
  float xoff = hash21(vec2(layerSeed, 2.0)) * 3.7;
  float fx = uv.x * cols + xoff;
  float c = floor(fx);
  float inCol = fract(fx);

  float top = baseLift + blockTop(c, layerSeed) * heightScale;

  // Soft top edge instead of a razor rect: a few px of feather, plus a tiny
  // per-column roofline jitter so tops aren't all flat.
  float roof = top + (hash21(vec2(c, layerSeed + 5.0)) - 0.5) * 0.006;
  float feather = 0.006 + depthT * 0.01;
  float cov = smoothstep(roof + feather, roof - feather, uv.y);

  // Thin gaps between blocks so the skyline reads as separate towers, softened
  // for distance.
  float gap = smoothstep(0.02, 0.06, inCol) * smoothstep(0.02, 0.06, 1.0 - inCol);
  cov *= mix(1.0, mix(0.0, 1.0, gap), 0.9 - depthT * 0.4);

  // --- Silhouette tone (aerial perspective) --------------------------------
  // Nearest layer is near-black warm; deeper layers wash toward the sky/haze
  // tone (palette stop 1, the warm accent-dark) so distance reads as lighter,
  // lower-contrast, exactly like a hazy real skyline.
  // Near towers are an almost-black warm silhouette (just off the Deep Field
  // ground); distance washes them gently toward the haze tone. Keep the accent
  // mix small so the city reads as dark warm concrete, not a red wall.
  vec3 nearTone = mix(u_palette[0], u_palette[1], 0.04);
  vec3 farTone = mix(u_palette[0], u_palette[1], 0.30);
  vec3 silhouette = mix(nearTone, farTone, depthT * u_haze * 1.4);
  // A faint vertical gradient on each building: a touch brighter near its base
  // where ground light pools.
  float baseGlow = smoothstep(top, 0.0, uv.y) * 0.08 * (1.0 - depthT);
  silhouette += u_palette[1] * baseGlow;

  // --- Emissive windows -----------------------------------------------------
  // A regular grid of window cells inside each building; a seeded subset is lit.
  // Lit windows are soft dots (gaussian) that bloom slightly and flicker on a
  // slow per-window clock — never a hard rect. Distant windows shrink and dim.
  float winCols = 3.0;
  float winRows = mix(10.0, 6.0, depthT);
  vec2 wcell = vec2(inCol * winCols, (uv.y / max(top, 1e-3)) * winRows);
  vec2 wid = floor(wcell);
  vec2 wf = fract(wcell) - 0.5;
  // Stable per-window random.
  float wr = hash21(vec2(c * 31.0 + wid.x, wid.y * 17.0 + layerSeed));
  float lit = step(1.0 - u_litDensity, wr);
  // Soft round window: gaussian dot, scaled so windows are dots not panes.
  float winShape = exp(-dot(wf, wf) * mix(34.0, 70.0, depthT));
  // Slow seeded flicker: a low-frequency sine per window, subtle (stays mostly
  // lit). Phase from the window's own random so they're out of sync.
  float flick = 0.78 + 0.22 * sin(u_time * (0.5 + wr * 1.5) + wr * 28.0);
  // Only inside the building, only above the ground.
  float windows =
    lit * winShape * flick * cov * smoothstep(0.0, 0.04, uv.y) * smoothstep(0.01, 0.05, top - uv.y);
  // Distant windows dim into the haze.
  windows *= mix(1.0, 0.35, depthT);
  // Window color: warm glow -> ink core (lit panes), riding u_winGlow.
  vec3 winCol = mix(u_palette[2], u_palette[3], 0.4);
  float winAmt = windows * u_winGlow;
  // Slight bloom halo: a wider, softer dot under the core.
  float bloom = lit * exp(-dot(wf, wf) * mix(10.0, 22.0, depthT)) * cov * flick * 0.35;
  bloom *= smoothstep(0.0, 0.04, uv.y) * mix(1.0, 0.3, depthT);

  vec3 layerCol = silhouette + winCol * (winAmt + bloom * u_winGlow * 0.6);

  // Composite over what's behind (nearer alpha already written): this layer only
  // fills where the nearer ones didn't.
  col = mix(col, layerCol, cov);
  return cov;
}

void main() {
  // gl_FragCoord.y is 0 at the BOTTOM in WebGL, so uv.y is already "y up": the
  // towers grow from uv.y = 0 (bottom of the frame) up to their roofline.
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 sky = vec2(uv.x, 1.0 - uv.y); // sky-space: 0 at top, for the horizon fog

  // Start transparent; accumulate coverage so the skyline composites over the
  // scene below it (the sky/orb show through above the rooftops).
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  int layers = int(clamp(u_depth, 1.0, 3.0));
  // Draw farthest -> nearest so nearer towers occlude distant ones.
  for (int i = 2; i >= 0; i--) {
    if (i >= layers) continue;
    float depthT = layers > 1 ? float(i) / float(layers - 1) : 0.0;
    vec3 layerCol = col;
    float cov = skylineLayer(uv, depthT, layerCol);
    col = mix(col, layerCol, cov);
    alpha = max(alpha, cov);
  }

  // --- Fog rising from the horizon -----------------------------------------
  // A soft band of warm haze pooling among the rooftops near the bottom of the
  // frame and thinning upward, drawn as added coverage so it veils the bases of
  // the towers and lifts off into the sky. uv.y is 0 at the bottom, so the band
  // peaks low and fades up. Wisps come from drifting value noise.
  float horizon = smoothstep(u_maxHeight * 1.1, 0.0, uv.y);
  float fogNoise = valueNoise(vec2(uv.x * 5.0 + u_time * 0.05, uv.y * 8.0)) * 0.5 + 0.5;
  float fog = horizon * fogNoise * u_haze * 0.6;
  vec3 fogCol = mix(u_palette[0], u_palette[1], 0.45);
  col = mix(col, fogCol, fog);
  alpha = max(alpha, fog * 0.85);

  // Grain baked through the city (the system's base texture), light so the global
  // <Grain /> still leads; here it just keeps the skyline from reading as clean
  // vector art.
  col = dither8(col, uv);

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * Procedural city skyline the figure floats out of: rendered-grade GPU light,
 * not flat CSS rects. 2-3 parallax depth layers of varying-height blocks rise
 * from the bottom, each deeper layer lighter and hazier (aerial perspective)
 * with fog pooling at the horizon; window dots bloom and flicker on a slow
 * seeded clock; tops are soft, not razor edges.
 *
 * Same prop API surface as before (palette, seed, litWindowDensity, maxHeight,
 * count, windowGlow) plus depth/haze for the atmosphere. Deterministic: layout
 * and lit windows come from hash(seed) in-shader; the flicker is frame-derived;
 * no Math.random / wall clock.
 *
 * Moodboard: posted/infinity.jpg (hazy distant world), the founding image's lit
 * windows. Pure: animate brightness from outside via windowGlow (audio-reactive).
 */
export const TowerBlocks: React.FC<TowerBlocksProps> = ({
  palette,
  seed = 1,
  litWindowDensity = 0.22,
  maxHeight = 0.42,
  count = 11,
  windowGlow = 1,
  depth = 3,
  haze = 0.55,
  opacity = 1,
  blendMode = "normal",
}) => {
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <ShaderLayer
        fragmentShader={TOWERS_FRAG}
        palette={palette}
        seed={seed}
        opacity={opacity}
        blendMode={blendMode}
        uniforms={{
          u_count: Math.max(1, Math.round(count)),
          u_depth: Math.max(1, Math.min(3, Math.round(depth))),
          u_haze: haze,
          u_litDensity: litWindowDensity,
          u_maxHeight: maxHeight,
          u_winGlow: windowGlow,
        }}
      />
    </AbsoluteFill>
  );
};
