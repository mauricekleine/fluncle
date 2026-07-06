// Plate-texture reconstruction proof. The glass replays an archived plate body by
// prepending the SAME `sampler2D <name>;` + `float <name>AspectRatio;` header pair the
// OFFLINE ShaderLayer injected, bound at the SAME sorted units. Compiling GLSL needs a
// GPU (unavailable in `bun test`), so these lock the reconstruction to the offline
// `buildFragmentHeader` / `assignTextureUnits` by VALUE — if the live decls match the
// ones the render already compiled from, the replay program compiles too.

import { describe, expect, test } from "bun:test";

import {
  assignTextureUnits as offlineUnits,
  buildFragmentHeader,
} from "../../../video/src/remotion/journey/shader-header.ts";
import {
  assignTextureUnits,
  bodyDeclaresSampler,
  REPLAY_HEADER,
  textureUniformDecls,
} from "./glsl-runtime.ts";

const PLATE_NAMES = ["u_plate", "u_plateBackground"];

describe("assignTextureUnits — render-aligned, deterministic", () => {
  test("sorted names → 0,1,2… (matches the offline ShaderLayer assignment)", () => {
    expect(assignTextureUnits(PLATE_NAMES)).toEqual({ u_plate: 0, u_plateBackground: 1 });
  });
  test("byte-for-byte agreement with packages/video assignTextureUnits", () => {
    const names = ["u_plateBackground", "u_art", "u_plate"]; // unsorted input
    expect(assignTextureUnits(names)).toEqual(offlineUnits(names));
  });
});

describe("textureUniformDecls — the injected sampler pair", () => {
  test("emits a sorted sampler2D + AspectRatio pair per texture", () => {
    expect(textureUniformDecls(PLATE_NAMES)).toBe(
      "uniform sampler2D u_plate;\n" +
        "uniform float u_plateAspectRatio;\n" +
        "uniform sampler2D u_plateBackground;\n" +
        "uniform float u_plateBackgroundAspectRatio;\n",
    );
  });
  test("every emitted decl also appears in the offline buildFragmentHeader", () => {
    // The render's header is the ground truth the archived body compiled against.
    const offline = buildFragmentHeader({
      coreUniforms: "uniform float u_time;",
      ditherHelpers: "",
      textureNames: PLATE_NAMES,
    });
    for (const line of textureUniformDecls(PLATE_NAMES).trim().split("\n")) {
      expect(offline).toContain(line);
    }
  });
  test("a sampler already declared in the body is NOT re-declared (no double decl)", () => {
    const decls = textureUniformDecls(["u_art"], new Set(["u_art"]));
    expect(decls).toBe("");
  });
  test("no textures → empty string (the abstract-vehicle path is untouched)", () => {
    expect(textureUniformDecls([])).toBe("");
  });
});

describe("the reconstructed plate fragment", () => {
  test("REPLAY_HEADER + decls + body declares every sampler the body reads", () => {
    const body = "void main(){ gl_FragColor = texture2D(u_plate, gl_FragCoord.xy/u_res); }";
    const frag = REPLAY_HEADER + textureUniformDecls(PLATE_NAMES) + body;
    expect(frag).toContain("uniform sampler2D u_plate;");
    expect(frag).toContain("uniform float u_plateAspectRatio;");
    expect(frag).toContain("uniform vec3  u_palette[4];"); // the core header is still present
    expect(frag).toContain("texture2D(u_plate");
  });
});

describe("bodyDeclaresSampler", () => {
  test("detects a body-declared sampler (avoids the double decl)", () => {
    expect(bodyDeclaresSampler("uniform sampler2D u_art;\nvoid main(){}", "u_art")).toBe(true);
  });
  test("a mere usage (not a declaration) does not count", () => {
    expect(bodyDeclaresSampler("void main(){ texture2D(u_plate, vec2(0.0)); }", "u_plate")).toBe(
      false,
    );
  });
});
