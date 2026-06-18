// The three sizes a mixtape cover ships at — the single source of truth shared by
// the composition registry (root.tsx) and the render script (render-mixtape-cover.ts).
// All three render from one <MixtapeCover> component (mixtape-cover.tsx).
//
// Platform requirements (verify against current docs before relying on them):
//   - Mixcloud + SoundCloud artwork: square, ≥ 1024×1024 (we render 1500²).
//   - SoundCloud also accepts the same square.
//   - YouTube thumbnail: 1280×720 (16:9), under 2 MB.
//   - /log link-preview (Open Graph): 1200×630.
// The square also serves as the mixtape's `coverImageUrl` on its /log page.

export type MixtapeCoverSpec = {
  /** Remotion composition id (registered as a <Still> in root.tsx). */
  id: string;
  /** Output filename under packages/media/out/mixtapes/<coordinate>/. */
  file: string;
  width: number;
  height: number;
  /** What the asset is for. */
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
