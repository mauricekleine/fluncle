// Per-platform banner / cover specs — the single source of truth shared by the
// composition registry (root.tsx) and the render script (render-socials.ts).
//
// A platform's "safe" box is the centered region it always shows across devices
// (YouTube crops hardest; the 1235×338 box is the only area visible on every
// screen). The CosmosBanner sizes the floating cosmonaut off that box's height so
// the hard mobile crop still catches the figure, and bleeds the cosmos to the
// edges. Banners are WORDLESS — the figure against space; the FLUNCLE wordmark
// lives on the cover art, and the platform shows the channel name as text.
//
// Note: the Spotify playlist cover is NOT generated here — it is the founding
// cover art (apps/web/public/fluncle-cover.png).
//
// Per-account banner/cover dimensions are defined in the specs below.
// `render: true` = a claimed account we output by default; `false` = wired in
// and previewable in Studio, but not written until the account exists.

export type SocialSpec = {
  /** Remotion composition id (registered as a <Still> in root.tsx). */
  id: string;
  /** Output filename under docs/socials/banners/. */
  file: string;
  width: number;
  height: number;
  format: "png" | "jpeg";
  /** Cosmonaut figure height as a fraction of the safe-box height (tunes scale). */
  figure?: number;
  /** Centered always-visible box; the figure is sized off its height. */
  safe?: { width: number; height: number };
  /** Render to disk by default (a claimed account) vs future/unclaimed. */
  render: boolean;
};

export const SOCIAL_SPECS: SocialSpec[] = [
  {
    figure: 1,
    file: "youtube.png",
    format: "png",
    height: 1152,
    id: "YouTubeBanner",
    render: true,
    safe: { height: 338, width: 1235 },
    width: 2048,
  },
  {
    figure: 1.05,
    file: "mixcloud.png",
    format: "png",
    height: 512,
    id: "MixcloudCover",
    render: true,
    safe: { height: 380, width: 1600 },
    width: 2048,
  },
  {
    figure: 0.95,
    file: "soundcloud.png",
    format: "png",
    height: 520,
    id: "SoundcloudHeader",
    render: true,
    safe: { height: 460, width: 1480 },
    width: 2480,
  },
  {
    figure: 0.92,
    file: "twitch.png",
    format: "png",
    height: 480,
    id: "TwitchBanner",
    render: true,
    safe: { height: 420, width: 1040 },
    width: 1200,
  },
  // Future — specs ready for when the account is claimed.
  {
    figure: 0.95,
    file: "x.png",
    format: "png",
    height: 500,
    id: "XHeader",
    render: false,
    safe: { height: 420, width: 1380 },
    width: 1500,
  },
];
