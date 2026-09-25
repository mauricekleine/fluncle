import { type FC } from "react";
import { AbsoluteFill } from "remotion";

import { resolveSceneTextures, type Scene } from "../pipeline/scene";
import { type CosmosAudio } from "./types";
import { ShaderLayer } from "./journey/shader-layer";
import { type AudioReactivityOptions } from "./hooks/use-audio-reactivity";

export type SceneHostProps = {
  scene: Scene;

  audio: CosmosAudio;

  seed?: number;

  progress?: number;

  artworkUrl?: string;

  plateUrl?: string;

  plateBackgroundUrl?: string;

  dropMs?: number;

  opacity?: number;
};

function toReactivity(scene: Scene, dropMs?: number): AudioReactivityOptions | undefined {
  if (!scene.reactivity) {
    return undefined;
  }
  const { drop, swellBeatWeight } = scene.reactivity;
  return {
    drop: {
      fallMs: drop.fallMs,
      holdMs: drop.holdMs,

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
