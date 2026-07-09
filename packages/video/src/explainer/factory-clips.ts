// The factory beat plays real rendered track footage when it is present, and
// falls back to the procedural shader tiles otherwise. That footage is a LOCAL,
// export-time asset: `packages/video/public/*.mp4` is gitignored, so a clean
// checkout renders the procedural stand-in (works anywhere, nothing in history).
//
// To wire real footage for an export, name three findings (by Log ID or Spotify
// id) and run:
//
//   bun run --cwd packages/video factory:clips <id> <id> <id>
//
// It resolves each source (a local out/<id> render first, else the public
// footage on found.fluncle.com), transcodes to tile size into public/, and
// rewrites the array below. Reset with `git checkout src/explainer/factory-clips.ts`.
export const FACTORY_CLIPS: string[] = [];
