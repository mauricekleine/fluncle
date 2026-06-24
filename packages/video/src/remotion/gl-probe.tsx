import { AbsoluteFill } from "remotion";
import { GLSL } from "./journey/glsl";
import { ShaderLayer } from "./journey/shader-layer";

// Smoke test for the GPU shader stack: fbm field through the Retint palette ramp,
// finished with organic film grain, a dither pass to kill banding, and a vignette.
// Renders via <ShaderLayer> on ANGLE/Metal. Scrub in Studio (GlProbe) or shoot a
// still: `bunx remotion still GlProbe out/shader-smoke.png` (GL renderer via FLUNCLE_GL).
//
// Targets: grain must read as film (emulsion clumping), not TV static; the
// gradient must be smooth with no 8-bit banding (dither8 in the header).

const SMOKE_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;

  // Slowly drifting fbm field, warped by a second fbm for organic flow.
  vec2 q = uv * vec2(1.0, 1.8);
  float warp = fbm(q * 1.4 + vec2(0.0, u_time * 0.05), 4);
  float field = fbm(q * 2.4 + warp * 0.6 + vec2(u_time * 0.03, 0.0), 6);

  // Keep the warm-dark ground dominant (Warm Dark Rule): the ramp only climbs
  // into gold/cream where the field peaks, so most of the frame stays near-black
  // Deep Field with heat blooming through. Vertical bias keeps a horizon glow.
  float t = field * field * 0.85 + (1.0 - uv.y) * 0.18;
  vec3 col = paletteRamp(t);

  // Vignette toward the warm dark, then organic grain over everything.
  col *= mix(0.4, 1.0, vignette(uv, 0.95, 0.85));
  col = filmGrain(col, uv, u_time, 0.16);

  // Dither to 8-bit to break gradient banding.
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

export const GlProbe: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#090a0b" }}>
      <ShaderLayer fragmentShader={SMOKE_FRAG} seed={7} />
    </AbsoluteFill>
  );
};
