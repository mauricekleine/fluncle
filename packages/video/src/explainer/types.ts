export type ExplainerLayout = "talking-head" | "screen" | "pip" | "split";

export type MockSurface =
  | "face"
  | "playlist"
  | "log"
  | "lens"
  | "videos"
  | "voice"
  | "terminal"
  | "galaxy"
  | "crawler"
  | "mixtape"
  | "repo";

export type ExplainerClip =
  | { kind: "video"; src: string; label?: string }
  | { kind: "placeholder"; mock: MockSurface; label?: string };

export type CaptionLine = { text: string; fromMs: number; toMs: number };

export type ChapterAccent = "gold" | "violet" | "red";

export type TagSubFace = "command" | "coordinate" | "prose";

export type ExplainerChapter = {
  id: string;

  number?: number;
  title: string;
  subtitle?: string;
  durationMs: number;
  layout: ExplainerLayout;

  screen?: ExplainerClip;

  face?: ExplainerClip;

  tag?: { label: string; sub?: string; subFace?: TagSubFace };
  captions?: CaptionLine[];

  showCard?: boolean;
  accent?: ChapterAccent;
};

export type ExplainerManifest = {
  id: string;
  title: string;
  fps: number;
  width: number;
  height: number;
  chapters: ExplainerChapter[];

  captionsSrt?: string;

  showCaptureHints?: boolean;
};

export type ExplainerProps = {
  manifest: ExplainerManifest;
};
