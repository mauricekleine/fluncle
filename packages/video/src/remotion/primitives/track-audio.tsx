import { Audio, staticFile, useVideoConfig } from "remotion";
import { type CosmosAudio } from "../types";

// <TrackAudio> — plays the analysed preview clip for the whole composition.
//
// MANDATORY in every video. The audio HOOKS (useAudioReactivity / useBeat / …)
// only read the `audio.*` curves to drive VISUAL reactivity — they do NOT make a
// sound. This component is what actually gives the rendered MP4 audible audio.
// Omit it and the review cut renders a silent track (every shader still animates,
// so it's an easy mistake — caught by the render's silence assertion).
//
// It starts at the analysed clip window (`audio.startMs`) so picture and sound
// share the same beat grid, and plays for the whole composition (durationInFrames
// is the clip length). The `ship` step separately strips audio for the
// `footage-silent.mp4` TikTok cut; the review `footage.mp4` keeps this sound.
export const TrackAudio: React.FC<{ audio: CosmosAudio }> = ({ audio }) => {
  const { fps } = useVideoConfig();
  return (
    <Audio src={staticFile(audio.file)} startFrom={Math.round((audio.startMs / 1000) * fps)} />
  );
};
