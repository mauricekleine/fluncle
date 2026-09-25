export type SocialSpec = {
  id: string;

  file: string;
  width: number;
  height: number;
  format: "png" | "jpeg";

  figure?: number;

  safe?: { width: number; height: number };

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
