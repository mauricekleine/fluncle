// The Explainer family — a reusable, on-brand Remotion framework for walkthrough
// videos (talking-head + screen-capture picture-in-picture, chapter cards, smear
// transitions, burned-in captions). Unlike the per-track workbench, this family
// composites PRE-RECORDED footage (an `OffthreadVideo` first) into the Nostalgic
// Cosmos frame. One video = one manifest; the framework renders any manifest.

/** Which composition layout a chapter uses. */
export type ExplainerLayout =
  | "talking-head" // the face, full-bleed (cold open, the close)
  | "screen" // a surface walkthrough, full-bleed
  | "pip" // a surface walkthrough with the face cornered (the big beats)
  | "split"; // face on one side, walkthrough on the other

/** A schematic stand-in for real footage we do not have yet. Each renders an
 *  on-brand mock of the surface so the format reads before capture exists. */
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

/** A clip is either real footage (an mp4 in public/) or a placeholder mock. */
export type ExplainerClip =
  | { kind: "video"; src: string; label?: string }
  | { kind: "placeholder"; mock: MockSurface; label?: string };

/** One burned-in caption line, timed relative to the chapter start. */
export type CaptionLine = { text: string; fromMs: number; toMs: number };

export type ChapterAccent = "gold" | "violet" | "red";

/** Which canon face a SurfaceTag's sub-line reads in. Default "prose". */
export type TagSubFace =
  | "command" // a literal command you could type: mono, the machine's voice
  | "coordinate" // a Log ID, bare or `fluncle://`-prefixed: Oxanium, tabular
  | "prose"; // everything else: Space Grotesk

export type ExplainerChapter = {
  id: string;
  /** Chapter number for the card kicker; omit on the cold open + close. */
  number?: number;
  title: string;
  subtitle?: string;
  durationMs: number;
  layout: ExplainerLayout;
  /** The walkthrough / surface clip (screen, pip, split). */
  screen?: ExplainerClip;
  /** The talking-head clip (talking-head, pip, split). */
  face?: ExplainerClip;
  /**
   * A label tag for the surface on screen ("ssh rave.fluncle.com"). The sub-line
   * carries MIXED content across chapters, and DESIGN.md §3 gives each kind its
   * own face, so the tag declares which one it is: a literal command is machine
   * text (mono), a coordinate is the brand's numeral (Oxanium tabular — even
   * inside a `fluncle://` URI), and anything else simply reads (Space Grotesk,
   * the default).
   */
  tag?: { label: string; sub?: string; subFace?: TagSubFace };
  captions?: CaptionLine[];
  /** Flash the chapter card at the start of the chapter. */
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
  /** The production caption route: the whole VO transcribed to an SRT string
   *  (whisper or hand-authored). When set, it drives one absolute-timed caption
   *  track for the entire video and the per-chapter inline captions are ignored. */
  captionsSrt?: string;
  /** Burn the "screen capture → …" hint onto placeholder surfaces. Off by default;
   *  flip on for a capture-planning render that lists what footage each beat needs. */
  showCaptureHints?: boolean;
};

export type ExplainerProps = {
  manifest: ExplainerManifest;
};
