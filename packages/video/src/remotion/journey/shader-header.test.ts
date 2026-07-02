// Unit tests for the pure shader-source assembler. No WebGL/React needed — these
// pin the header layout that the glsl3 / derivatives / texture features rely on.

import { expect, test } from "bun:test";

import {
  assignTextureUnits,
  buildFragmentHeader,
  buildVertexShader,
  isRemoteSrc,
} from "./shader-header";

const CORE = "uniform float u_time;\nuniform vec2 u_res;";
const DITHER = "vec3 dither8(vec3 c, vec2 uv){ return c; }";

test("WebGL1 default header: precision first, no version/extension/out", () => {
  const header = buildFragmentHeader({ coreUniforms: CORE, ditherHelpers: DITHER });
  expect(header.startsWith("precision highp float;")).toBe(true);
  expect(header).not.toContain("#version");
  expect(header).not.toContain("#extension");
  expect(header).not.toContain("out vec4 fragColor");
  expect(header).toContain("uniform float u_time;");
  expect(header).toContain("dither8");
});

test("derivatives adds the WebGL1 #extension line BEFORE precision", () => {
  const header = buildFragmentHeader({
    coreUniforms: CORE,
    derivatives: true,
    ditherHelpers: DITHER,
  });
  const ext = header.indexOf("#extension GL_OES_standard_derivatives : enable");
  const prec = header.indexOf("precision highp float;");
  expect(ext).toBeGreaterThanOrEqual(0);
  expect(ext).toBeLessThan(prec);
});

test("glsl3 emits #version 300 es first, an out fragColor, and never the extension line", () => {
  const header = buildFragmentHeader({
    coreUniforms: CORE,
    // derivatives is a WebGL1-only header line; glsl3 wins and suppresses it.
    derivatives: true,
    ditherHelpers: DITHER,
    glsl3: true,
  });
  expect(header.startsWith("#version 300 es\n")).toBe(true);
  expect(header).toContain("out vec4 fragColor;");
  expect(header).not.toContain("#extension");
});

test("each texture name yields a sorted sampler + AspectRatio pair", () => {
  const header = buildFragmentHeader({
    coreUniforms: CORE,
    ditherHelpers: DITHER,
    textureNames: ["u_art", "u_bg"],
  });
  expect(header).toContain("uniform sampler2D u_art;");
  expect(header).toContain("uniform float u_artAspectRatio;");
  expect(header).toContain("uniform sampler2D u_bg;");
  // Sorted: u_art declared before u_bg regardless of input order.
  expect(header.indexOf("sampler2D u_art;")).toBeLessThan(header.indexOf("sampler2D u_bg;"));
});

test("texture declaration order is stable regardless of input order", () => {
  const a = buildFragmentHeader({
    coreUniforms: CORE,
    ditherHelpers: DITHER,
    textureNames: ["u_bg", "u_art"],
  });
  const b = buildFragmentHeader({
    coreUniforms: CORE,
    ditherHelpers: DITHER,
    textureNames: ["u_art", "u_bg"],
  });
  expect(a).toBe(b);
});

test("buildVertexShader matches the fragment dialect", () => {
  expect(buildVertexShader(false)).toContain("attribute vec2 p;");
  expect(buildVertexShader(false)).not.toContain("#version");
  const v3 = buildVertexShader(true);
  expect(v3.startsWith("#version 300 es")).toBe(true);
  expect(v3).toContain("in vec2 p;");
});

test("assignTextureUnits maps sorted names to 0..n deterministically", () => {
  expect(assignTextureUnits(["u_bg", "u_art"])).toEqual({ u_art: 0, u_bg: 1 });
  expect(assignTextureUnits(["u_art", "u_bg"])).toEqual({ u_art: 0, u_bg: 1 });
  expect(assignTextureUnits([])).toEqual({});
  expect(assignTextureUnits(["only"])).toEqual({ only: 0 });
});

test("isRemoteSrc: URLs/roots pass through, bare public filenames go to staticFile", () => {
  expect(isRemoteSrc("https://found.fluncle.com/x/poster.jpg")).toBe(true);
  expect(isRemoteSrc("http://localhost:3000/a.png")).toBe(true);
  expect(isRemoteSrc("data:image/png;base64,AAAA")).toBe(true);
  expect(isRemoteSrc("blob:abc")).toBe(true);
  expect(isRemoteSrc("//cdn.example.com/a.png")).toBe(true);
  expect(isRemoteSrc("/rooted/a.png")).toBe(true);
  expect(isRemoteSrc("artwork.png")).toBe(false);
  expect(isRemoteSrc("nested/artwork.png")).toBe(false);
});
