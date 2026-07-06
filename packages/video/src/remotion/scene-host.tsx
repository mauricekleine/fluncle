// SceneHost — the offline replay host for a `fluncle.scene/1` manifest. A THIN,
// data-driven wrapper over the existing <ShaderLayer>: it reads a resolved scene
// body + palette + grain/bloom/reactivity out of a scene.json and renders it,
// fed the finding's audio + seed as props. It authors nothing; ShaderLayer still
// owns the GPU plumbing and the brand law (the injected u_palette ramp + dither8).
//
// This is the OFFLINE sibling of the live `LiveSceneHost` (Unit L): the same body,
// the same header uniforms, one driven by rendered audio curves, the other by the
// live DSP bus. Proving the scene manifest reproduces its source composition is the
// round-trip obligation (scene-roundtrip.ts).
//
// A scene whose body is NOT live-ready (custom clip-time uniforms) can still be
// rendered here — SceneHost simply cannot supply those uniforms, so such a scene
// only reproduces its source when the missing uniform sat at its default. Live-ready
// scenes (header uniforms only) reproduce exactly; that is what the round-trip proves.

import { type FC } from "react";
import { AbsoluteFill } from "remotion";

import { resolveSceneTextures, type Scene } from "../pipeline/scene";
import { type CosmosAudio } from "./types";
import { ShaderLayer } from "./journey/shader-layer";
import { type AudioReactivityOptions } from "./hooks/use-audio-reactivity";

export type SceneHostProps = {
  /** The parsed scene.json manifest (the replay contract). */
  scene: Scene;
  /** The finding's analyzed audio — drives the header audio bus exactly as the source did. */
  audio: CosmosAudio;
  /** The per-track seed for u_seed (host-supplied; the manifest carries no seed). */
  seed?: number;
  /** 0..1 progress for u_progress (offline: clip progress; defaults to frame-derived). */
  progress?: number;
  /**
   * The matched finding's artwork URL, bound to every `glsl.textures` sampler
   * with `source: "artwork"`. Required when the scene declares an artwork
   * texture; ignored otherwise.
   */
  artworkUrl?: string;
  /**
   * Override for a `source: "plate"` sampler. Defaults to the finding bundle's
   * own durable key (`https://found.fluncle.com/<id>/plate.png`) — the same URL
   * the composition rendered from, per the plate lane's upload-first order.
   */
  plateUrl?: string;
  /** Override for `source: "plate-background"`; defaults to `<id>/plate.background.png`. */
  plateBackgroundUrl?: string;
  /** Detected drop time (ms) injected into the drop envelope (offline peak). */
  dropMs?: number;
  /** Layer opacity 0..1. Default 1. */
  opacity?: number;
};

/** Map the manifest's drop envelope SHAPE onto ShaderLayer's reactivity options. */
function toReactivity(scene: Scene, dropMs?: number): AudioReactivityOptions | undefined {
  if (!scene.reactivity) {
    return undefined;
  }
  const { drop, swellBeatWeight } = scene.reactivity;
  return {
    drop: {
      fallMs: drop.fallMs,
      holdMs: drop.holdMs,
      // The manifest omits peakTimeMs by design; the offline host injects it.
      ...(dropMs !== undefined ? { peakTimeMs: dropMs } : {}),
      riseMs: drop.riseMs,
    },
    swellBeatWeight,
  };
}

export const SceneHost: FC<SceneHostProps> = ({
  scene,
  audio,
  seed,
  progress,
  artworkUrl,
  plateUrl,
  plateBackgroundUrl,
  dropMs,
  opacity = 1,
}) => {
  const textures = resolveSceneTextures(scene, { artworkUrl, plateBackgroundUrl, plateUrl });

  return (
    <AbsoluteFill>
      <ShaderLayer
        fragmentShader={scene.glsl.body}
        glsl3={scene.glsl.glsl3}
        paletteStops={scene.palette}
        seed={seed}
        progress={progress}
        opacity={opacity}
        beatGrid={audio.beatGrid}
        onsets={audio.onsets}
        downbeats={audio.downbeats}
        energyCurve={audio.energyCurve}
        bassCurve={audio.bassCurve}
        midCurve={audio.midCurve}
        trebleCurve={audio.trebleCurve}
        fluxCurve={audio.fluxCurve}
        kickCurve={audio.kickCurve}
        snareCurve={audio.snareCurve}
        subCurve={audio.subCurve}
        airCurve={audio.airCurve}
        dropMs={dropMs}
        bloom={scene.bloom}
        reactivity={toReactivity(scene, dropMs)}
        textures={textures}
      />
    </AbsoluteFill>
  );
};
