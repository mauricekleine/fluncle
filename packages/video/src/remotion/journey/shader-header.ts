export type FragmentHeaderOptions = {
  coreUniforms: string;

  derivatives?: boolean;

  ditherHelpers: string;

  glsl3?: boolean;

  textureNames?: string[];
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

export const buildVertexShader = (glsl3: boolean): string =>
  glsl3
    ? `#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`
    : `attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`;

export const assignTextureUnits = (names: string[]): Record<string, number> => {
  const units: Record<string, number> = {};
  [...names].sort(byName).forEach((name, index) => {
    units[name] = index;
  });
  return units;
};

export const isRemoteSrc = (src: string): boolean =>
  /^(https?:|data:|blob:)/i.test(src) || src.startsWith("//") || src.startsWith("/");
