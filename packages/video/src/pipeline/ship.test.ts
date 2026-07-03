// Coverage for ship.ts's pure bundle-assembly logic. ship.ts itself is
// side-effect-free on import (its work runs behind an import.meta.main guard),
// so these exercise the exported functions directly — no fs, no spawnSync, no
// network.

import path from "node:path";

import { describe, expect, test } from "bun:test";

import { buildCaption, type CaptionTrack } from "./caption";
import {
  buildNoteText,
  buildRenderJson,
  EXTRA_VARIANT_SOURCES,
  parseShipArgs,
  resolveBundlePaths,
} from "./ship";

describe("parseShipArgs", () => {
  test("parses a bare positional with no flags", () => {
    const flags = parseShipArgs(["spotify:track:abc123"]);

    expect(flags.trackInput).toBe("spotify:track:abc123");
    expect(flags.vehicle).toBeUndefined();
    expect(flags.grain).toBeUndefined();
    expect(flags.model).toBeUndefined();
    expect(flags.reasoning).toBeUndefined();
    expect(flags.register).toBeUndefined();
  });

  test("parses every flag, trimming string values", () => {
    const flags = parseShipArgs([
      "004.6.0K",
      "--vehicle",
      " voronoi cellular ",
      "--grain",
      "grainCoarseSilver",
      "--model",
      "anthropic/claude-opus-4-8",
      "--reasoning",
      "high",
      "--register",
      "abstract",
    ]);

    expect(flags.vehicle).toBe("voronoi cellular");
    expect(flags.grain).toBe("grainCoarseSilver");
    expect(flags.model).toBe("anthropic/claude-opus-4-8");
    expect(flags.reasoning).toBe("high");
    expect(flags.register).toBe("abstract");
  });

  test("accepts all three register values", () => {
    for (const register of ["abstract", "representational", "framed"] as const) {
      expect(parseShipArgs(["id", "--register", register]).register).toBe(register);
    }
  });

  test("rejects an invalid register value", () => {
    expect(() => parseShipArgs(["id", "--register", "surreal"])).toThrow(
      /--register must be one of/,
    );
  });

  test("throws (with usage) when the positional track id is missing", () => {
    expect(() => parseShipArgs(["--vehicle", "tag"])).toThrow(/usage: bun src\/pipeline\/ship\.ts/);
  });

  test("throws on an unknown flag", () => {
    expect(() => parseShipArgs(["id", "--bogus"])).toThrow();
  });
});

describe("resolveBundlePaths", () => {
  test("joins every bundle file under outDir/logId", () => {
    const paths = resolveBundlePaths("/out", "004.6.0K");

    expect(paths.bundle).toBe(path.join("/out", "004.6.0K"));
    expect(paths.footage).toBe(path.join("/out", "004.6.0K", "footage.mp4"));
    expect(paths.footageSocial).toBe(path.join("/out", "004.6.0K", "footage.social.mp4"));
    expect(paths.footageLandscape).toBe(path.join("/out", "004.6.0K", "footage.landscape.mp4"));
    expect(paths.footageLandscapeSocial).toBe(
      path.join("/out", "004.6.0K", "footage.landscape.social.mp4"),
    );
    expect(paths.footageNotext).toBe(path.join("/out", "004.6.0K", "footage.notext.mp4"));
    expect(paths.poster).toBe(path.join("/out", "004.6.0K", "poster.jpg"));
    expect(paths.notePath).toBe(path.join("/out", "004.6.0K", "note.txt"));
    expect(paths.compositionPath).toBe(path.join("/out", "004.6.0K", "composition.tsx"));
    expect(paths.propsOutPath).toBe(path.join("/out", "004.6.0K", "props.json"));
    expect(paths.intentOutPath).toBe(path.join("/out", "004.6.0K", "intent.json"));
    expect(paths.renderOutPath).toBe(path.join("/out", "004.6.0K", "render.json"));
    expect(paths.sceneOutPath).toBe(path.join("/out", "004.6.0K", "scene.json"));
  });
});

describe("EXTRA_VARIANT_SOURCES", () => {
  test("maps the three documented extra-variant suffixes to distinct filenames", () => {
    const suffixes = EXTRA_VARIANT_SOURCES.map((s) => s.suffix).sort();
    expect(suffixes).toEqual([".landscape", ".notext", ".notext.landscape"]);

    const pathKeys = new Set(EXTRA_VARIANT_SOURCES.map((s) => s.pathKey));
    expect(pathKeys.size).toBe(EXTRA_VARIANT_SOURCES.length);
  });

  test("the clean-landscape escape hatch maps .notext.landscape -> footageLandscape", () => {
    const source = EXTRA_VARIANT_SOURCES.find((s) => s.suffix === ".notext.landscape");
    expect(source?.masterFlag).toBe("footageLandscape");
    expect(source?.pathKey).toBe("footageLandscape");
  });
});

describe("buildRenderJson", () => {
  const base = {
    compositionId: "MyComp",
    grain: "grainCoarseSilver",
    hasCompositionFile: true,
    hasIntentFile: true,
    hasPropsFile: true,
    model: "anthropic/claude-opus-4-8",
    reasoning: "high",
    register: "abstract",
    trackId: "abc123",
    variants: { "footage.mp4": { aspect: "square" as const, hideOverlay: true } },
    vehicle: "voronoi cellular",
  };

  test("carries every field through, including the new register axis", () => {
    const json = buildRenderJson(base);

    expect(json).toMatchObject({
      compositionId: "MyComp",
      compositionSource: "composition.tsx",
      grain: "grainCoarseSilver",
      intent: "intent.json",
      model: "anthropic/claude-opus-4-8",
      props: "props.json",
      reasoning: "high",
      register: "abstract",
      trackId: "abc123",
      vehicle: "voronoi cellular",
    });
  });

  test("missing composition/intent/props files null out their pointers", () => {
    const json = buildRenderJson({
      ...base,
      hasCompositionFile: false,
      hasIntentFile: false,
      hasPropsFile: false,
    });

    expect(json.compositionSource).toBeNull();
    expect(json.intent).toBeNull();
    expect(json.props).toBeNull();
  });

  test("a null register is preserved as null (warn-not-fail contract)", () => {
    const json = buildRenderJson({ ...base, register: null });

    expect(json.register).toBeNull();
  });
});

describe("buildNoteText", () => {
  test("delegates to buildCaption", () => {
    const track: CaptionTrack = {
      addedAt: "2026-06-08T12:00:00Z",
      artists: ["Artist One"],
      logId: "001.1.1A",
      title: "The Title",
    };

    expect(buildNoteText(track, 2020)).toBe(buildCaption(track, 2020));
  });
});
