export type MixtapeCoverSpec = {
  id: string;

  file: string;
  width: number;
  height: number;

  use: string;
};

export const MIXTAPE_COVER_SPECS: MixtapeCoverSpec[] = [
  {
    file: "cover-square.png",
    height: 1500,
    id: "MixtapeCoverSquare",
    use: "Mixcloud + SoundCloud artwork, and the mixtape's /log coverImageUrl",
    width: 1500,
  },
  {
    file: "thumb-youtube.png",
    height: 720,
    id: "MixtapeCoverWide",
    use: "YouTube thumbnail",
    width: 1280,
  },
  {
    file: "og.png",
    height: 630,
    id: "MixtapeCoverOg",
    use: "the /log link-preview (Open Graph) card",
    width: 1200,
  },
];
