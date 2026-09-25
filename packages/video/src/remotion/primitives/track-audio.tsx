import { Audio, staticFile, useVideoConfig } from "remotion";
import { type CosmosAudio } from "../types";

export const TrackAudio: React.FC<{ audio: CosmosAudio }> = ({ audio }) => {
  const { fps } = useVideoConfig();
  return (
    <Audio src={staticFile(audio.file)} startFrom={Math.round((audio.startMs / 1000) * fps)} />
  );
};
