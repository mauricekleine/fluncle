// The Explainer renderer: turns a manifest into a timeline of chapter scenes
// (each with its layout, surface tag, captions, and an optional card flash) and
// lays a star-warp transition over every seam. calculateMetadata sums the
// chapter durations so Studio + the render agree on length.

import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { type CalculateMetadataFunction } from "remotion";

import { srtToCaptionLines } from "./captions";
import { CARD_MS, FPS, msToFrames, TRANSITION_MS } from "./theme";
import {
  Captions,
  ChapterCard,
  Frame,
  Pip,
  ScreenFull,
  Split,
  SmearTransition,
  SurfaceTag,
  TalkingHead,
} from "./scene";
import { type ExplainerChapter, type ExplainerClip, type ExplainerProps } from "./types";

const FACE_FALLBACK: ExplainerClip = { kind: "placeholder", mock: "face" };

const Layout: React.FC<{ chapter: ExplainerChapter }> = ({ chapter }) => {
  const face = chapter.face ?? FACE_FALLBACK;
  const screen = chapter.screen ?? { kind: "placeholder", mock: "log" };
  if (chapter.layout === "talking-head") {
    return <TalkingHead face={face} />;
  }
  if (chapter.layout === "pip") {
    return <Pip face={face} screen={screen} />;
  }
  if (chapter.layout === "split") {
    return <Split face={face} screen={screen} />;
  }
  return <ScreenFull screen={screen} />;
};

const ChapterScene: React.FC<{ chapter: ExplainerChapter; showCaptions: boolean }> = ({
  chapter,
  showCaptions,
}) => {
  const { fps } = useVideoConfig();
  const cardFrames = msToFrames(CARD_MS, fps);
  return (
    <AbsoluteFill>
      <Layout chapter={chapter} />
      {chapter.tag !== undefined ? (
        <SurfaceTag label={chapter.tag.label} sub={chapter.tag.sub} />
      ) : null}
      {showCaptions ? <Captions lines={chapter.captions} /> : null}
      {chapter.showCard === true ? (
        <Sequence durationInFrames={cardFrames} from={0} name="card">
          <ChapterCard chapter={chapter} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

export const ExplainerComposition: React.FC<ExplainerProps> = ({ manifest }) => {
  const { fps } = useVideoConfig();
  const transFrames = msToFrames(TRANSITION_MS, fps);
  const globalCaptions =
    manifest.captionsSrt !== undefined ? srtToCaptionLines(manifest.captionsSrt) : undefined;

  let cursor = 0;
  const scenes = manifest.chapters.map((chapter) => {
    const from = cursor;
    const durationInFrames = Math.max(1, msToFrames(chapter.durationMs, fps));
    cursor += durationInFrames;
    return { chapter, durationInFrames, from };
  });

  return (
    <Frame>
      {scenes.map(({ chapter, durationInFrames, from }) => (
        <Sequence
          durationInFrames={durationInFrames}
          from={from}
          key={chapter.id}
          name={chapter.title}
        >
          <ChapterScene chapter={chapter} showCaptions={globalCaptions === undefined} />
        </Sequence>
      ))}
      {scenes.slice(1).map(({ from }, index) => (
        <Sequence
          durationInFrames={transFrames}
          from={Math.max(0, from - Math.round(transFrames / 2))}
          key={`seam-${index}`}
          name="seam"
        >
          <SmearTransition seed={index + 1} />
        </Sequence>
      ))}
      {globalCaptions !== undefined ? <Captions lines={globalCaptions} /> : null}
    </Frame>
  );
};

export const calculateExplainerMetadata: CalculateMetadataFunction<ExplainerProps> = ({
  props,
}) => {
  const { manifest } = props;
  const fps = manifest.fps > 0 ? manifest.fps : FPS;
  const total = manifest.chapters.reduce(
    (n, ch) => n + Math.max(1, msToFrames(ch.durationMs, fps)),
    0,
  );
  return {
    durationInFrames: Math.max(1, total),
    fps,
    height: manifest.height,
    width: manifest.width,
  };
};
