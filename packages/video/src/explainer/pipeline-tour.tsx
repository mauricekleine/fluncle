// The Pipeline Tour manifest — the specific ~3:35 walkthrough of the galaxy
// factory for X. Placeholder mock surfaces stand in until real screen captures
// exist; drop mp4s in public/ and swap a chapter's clip to `{ kind: "video",
// src: "…" }` to go live. Captions are illustrative stand-ins for the real VO
// transcript. Cold open + close are the talking-head bookends; the factory and
// the surfaces are the big beats, so they run picture-in-picture.

import { FPS, HEIGHT, WIDTH } from "./theme";
import { type ExplainerChapter, type ExplainerManifest } from "./types";

// Annotated so the string-literal fields (layout, clip kind, mock) stay narrow.
const chapters: Array<Omit<ExplainerChapter, "id"> & { id?: string }> = [
  {
    captions: [
      { fromMs: 800, text: "I built a machine that turns a drum & bass track", toMs: 5_000 },
      { fromMs: 5_000, text: "into a whole little universe.", toMs: 8_500 },
      { fromMs: 9_500, text: "Let me show you.", toMs: 13_500 },
    ],
    durationMs: 15_000,
    face: { kind: "placeholder", mock: "face" },
    id: "cold-open",
    layout: "talking-head",
    title: "cold open",
  },
  {
    captions: [
      { fromMs: 1_400, text: "It started as a playlist. Just the bangers I find.", toMs: 6_500 },
      {
        fromMs: 7_000,
        text: "I hit CMD+F, and it's logged. Then it got out of hand.",
        toMs: 13_500,
      },
    ],
    durationMs: 25_000,
    layout: "pip",
    number: 1,
    screen: { kind: "placeholder", label: "fluncle.com — the archive", mock: "playlist" },
    showCard: true,
    subtitle: "when I hear a banger, I hit CMD+F and it's in",
    tag: { label: "the archive", sub: "fluncle.com" },
    title: "where it started",
  },
  {
    captions: [
      { fromMs: 1_400, text: "A banger isn't just a track. It's a finding,", toMs: 6_000 },
      { fromMs: 6_000, text: "with a permanent coordinate. A Log ID.", toMs: 11_000 },
      {
        fromMs: 12_000,
        text: "It names the same finding on every surface. Forever.",
        toMs: 18_000,
      },
    ],
    durationMs: 30_000,
    layout: "pip",
    number: 2,
    screen: { kind: "placeholder", label: "fluncle.com/log/004.7.2I", mock: "log" },
    showCard: true,
    subtitle: "a permanent coordinate in the Galaxy",
    tag: { label: "a finding", sub: "fluncle://004.7.2I" },
    title: "what a finding is",
  },
  {
    captions: [
      {
        fromMs: 1_400,
        text: "Then the machines take over. On their own. Overnight.",
        toMs: 7_000,
      },
      { fromMs: 7_500, text: "A bespoke shader video. No two are ever the same.", toMs: 13_500 },
      { fromMs: 14_000, text: "A spoken observation, in a cloned voice.", toMs: 19_500 },
      {
        fromMs: 20_000,
        text: "Nobody runs this. It happens in machines in my house.",
        toMs: 27_000,
      },
    ],
    durationMs: 55_000,
    layout: "pip",
    number: 3,
    screen: { kind: "placeholder", label: "3 rendered videos, side by side", mock: "videos" },
    showCard: true,
    subtitle: "then my machines pull it apart and analyze it",
    tag: { label: "the factory", sub: "enrichment, autonomous" },
    title: "the factory",
  },
  {
    captions: [
      { fromMs: 1_400, text: "One finding. Everywhere at once.", toMs: 6_000 },
      { fromMs: 6_500, text: "The archive is a terminal you can SSH into.", toMs: 12_500 },
      {
        fromMs: 13_000,
        text: "There's a game where your banger is a star you fly to.",
        toMs: 19_500,
      },
      {
        fromMs: 20_000,
        text: "And it's all built to be read by the AI crawlers too.",
        toMs: 26_500,
      },
    ],
    durationMs: 45_000,
    layout: "pip",
    number: 4,
    screen: { kind: "placeholder", label: "ssh rave.fluncle.com", mock: "terminal" },
    showCard: true,
    subtitle: "wherever you come looking, the banger's there",
    tag: { label: "the rave terminal", sub: "ssh rave.fluncle.com" },
    title: "everywhere at once",
  },
  {
    captions: [
      { fromMs: 800, text: "At night it sleeps. The findings blend, like dreams.", toMs: 7_000 },
      { fromMs: 7_500, text: "That's a mixtape. Fluncle, dreaming out loud.", toMs: 14_000 },
    ],
    durationMs: 20_000,
    layout: "screen",
    number: 5,
    screen: { kind: "placeholder", label: "fluncle.com/mixtapes", mock: "mixtape" },
    showCard: true,
    subtitle: "every banger is a place I've been",
    tag: { label: "a mixtape", sub: "Fluncle dreaming" },
    title: "the dream",
  },
  {
    captions: [
      { fromMs: 800, text: "All of it is open source. All of it is public.", toMs: 6_500 },
      { fromMs: 7_000, text: "Come follow the trail.", toMs: 11_500 },
    ],
    durationMs: 25_000,
    face: { kind: "placeholder", mock: "face" },
    id: "close",
    layout: "pip",
    screen: { kind: "placeholder", label: "github.com/mauricekleine/fluncle", mock: "repo" },
    tag: { label: "it's all yours", sub: "fluncle.com/pipeline" },
    title: "come find it",
  },
];

// One set of chapters, three aspect ratios. The layouts reflow off the frame
// dimensions (responsive PiP, stacked split on tall frames), so the same tour
// renders landscape for YouTube/X, portrait for the mobile timeline + Reels/
// Shorts, and square for the in-feed post.
const resolved: ExplainerChapter[] = chapters.map((chapter, index) => ({
  ...chapter,
  id: chapter.id ?? `ch-${index}`,
}));

export const pipelineTour: ExplainerManifest = {
  chapters: resolved,
  fps: FPS,
  height: HEIGHT,
  id: "pipeline-tour",
  title: "The Galaxy Factory",
  width: WIDTH,
};

export const pipelineTourPortrait: ExplainerManifest = {
  ...pipelineTour,
  height: WIDTH, // 1920
  id: "pipeline-tour-portrait",
  width: HEIGHT, // 1080 → 1080×1920 (9:16)
};

export const pipelineTourSquare: ExplainerManifest = {
  ...pipelineTour,
  height: HEIGHT, // 1080
  id: "pipeline-tour-square",
  width: HEIGHT, // 1080 → 1080×1080 (1:1)
};
