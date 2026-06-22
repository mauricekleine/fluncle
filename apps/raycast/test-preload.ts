// bun test preload (wired in bunfig.toml). The Raycast CLI resolves the
// `@raycast/api` entry at build time (its package.json declares only `types`, no
// `main`/`exports`), so `bun test` cannot import the real module. The unit under
// test (parseSpotifyTrackInput) is pure and never touches Raycast APIs — this
// stub only makes the top-level `import { getPreferenceValues } from "@raycast/api"`
// in fluncle.ts resolve. getPreferenceValues is called lazily inside the CLI exec
// path, which these tests never reach.
import { mock } from "bun:test";

void mock.module("@raycast/api", () => ({
  getPreferenceValues: () => ({ flunclePath: "/usr/bin/fluncle" }),
}));
