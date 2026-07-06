// Pure header/shader-source assembly for <ShaderLayer>. Split out of
// shader-layer.tsx so the string plumbing is unit-testable with no WebGL / React
// / Remotion context (the component keeps the GPU + audio side). Everything here
// is a pure function of its arguments.
//
// The audio/journey/brand uniform BLOCK (`coreUniforms`) and the dither helpers
// stay OWNED by shader-layer.tsx and are passed in — so a shader adds a new
// uniform in ONE place there and this assembler stays untouched.

export type FragmentHeaderOptions = {
  /** The audio/journey/brand uniform declarations block (owned by shader-layer.tsx). */
  coreUniforms: string;
  /** The `OES_standard_derivatives` extension is available (WebGL1 only; WebGL2 has it built in). */
  derivatives?: boolean;
  /** The ditherValue/dither8 banding helpers (owned by shader-layer.tsx). */
  ditherHelpers: string;
  /** Emit a `#version 300 es` (WebGL2 / GLSL ES 3.00) header instead of WebGL1. */
  glsl3?: boolean;
  /**
   * Custom texture uniform names. Each name N gains `uniform sampler2D N;` and
   * `uniform float NAspectRatio;` in the header, so a shader can sample the image
   * and correct for its aspect ratio. Bound to units in sorted order — see
   * assignTextureUnits.
   */
  textureNames?: string[];
};

/** Case-stable ascii sort so texture unit/uniform order is deterministic across hosts. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Assemble the fragment-shader header injected ahead of a shader body.
 *
 * Layout (top to bottom): the optional `#version 300 es` line (GLSL3 only), the
 * optional `#extension GL_OES_standard_derivatives : enable` line (WebGL1 only,
 * and only when the extension is present — both directives MUST precede the first
 * real token), `precision highp float;`, the core uniform block, one
 * `sampler2D`/`AspectRatio` pair per texture (sorted), the GLSL3 `out vec4
 * fragColor;` declaration, then the dither helpers.
 */
export const buildFragmentHeader = (options: FragmentHeaderOptions): string => {
  const {
    coreUniforms,
    derivatives = false,
    ditherHelpers,
    glsl3 = false,
    textureNames = [],
  } = options;

  const parts: string[] = [];
  if (glsl3) {
    parts.push("#version 300 es");
  }
  if (derivatives && !glsl3) {
    parts.push("#extension GL_OES_standard_derivatives : enable");
  }
  parts.push("precision highp float;");
  parts.push("");
  parts.push(coreUniforms.trim());

  for (const name of [...textureNames].sort(byName)) {
    parts.push(`uniform sampler2D ${name};`);
    parts.push(`uniform float ${name}AspectRatio;`);
  }

  if (glsl3) {
    parts.push("");
    parts.push("out vec4 fragColor;");
  }

  parts.push("");
  parts.push(ditherHelpers.trim());

  return parts.join("\n") + "\n";
};

/**
 * The fullscreen-triangle vertex shader, matched to the fragment dialect. GLSL3
 * needs `#version 300 es` + `in` where WebGL1 uses `attribute`.
 */
export const buildVertexShader = (glsl3: boolean): string =>
  glsl3
    ? `#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`
    : `attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`;

/**
 * Deterministic texture-unit assignment: sorted names → unit index (0,1,2,…), so
 * a given set of textures always binds to the same units regardless of the
 * object's key insertion order.
 */
export const assignTextureUnits = (names: string[]): Record<string, number> => {
  const units: Record<string, number> = {};
  [...names].sort(byName).forEach((name, index) => {
    units[name] = index;
  });
  return units;
};

/**
 * True when a texture source is already a fully-qualified URL (https/http/data/
 * blob) or a root/protocol-relative path — i.e. NOT a bare `public/` filename
 * that must go through Remotion's `staticFile()`. Remote artwork URLs pass
 * through untouched so headless renders fetch them directly.
 */
export const isRemoteSrc = (src: string): boolean =>
  /^(https?:|data:|blob:)/i.test(src) || src.startsWith("//") || src.startsWith("/");
